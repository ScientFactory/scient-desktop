// @effect-diagnostics globalTimers:off -- Framework-neutral persistence lane with an injected transport and deterministic timer tests.
// @effect-diagnostics globalDate:off -- Elapsed debounce deadlines share the timer clock, virtualized in deterministic tests.
// @effect-diagnostics globalConsole:off -- Observer defects must not interrupt publication bookkeeping.
import type {
  MarkdownDocumentSession,
  MarkdownSaveIntent,
  MarkdownExternalConflict,
} from "./session.ts";
import { reconcileMarkdown, type MarkdownReconciliation } from "./reconciliation.ts";

export interface MarkdownExternalUpdate extends MarkdownReconciliation {
  readonly previousSource: string;
  readonly editVersion: number;
}
export type PrepareMarkdownExternalUpdate = (
  update: MarkdownExternalUpdate,
) => (() => void) | "defer" | null;

export type MarkdownPersistenceFailureKind =
  | "conflict"
  | "transient"
  | "operation"
  | "disconnected"
  | "terminal";

export interface MarkdownPersistenceReadResult {
  readonly source: string;
  readonly revision: string;
  readonly truncated?: boolean;
  readonly readOnly?: boolean;
}

export interface MarkdownPersistenceOptions {
  readonly source: string;
  readonly revision: string;
  readonly draftSource?: string;
  readonly initialConflict?: MarkdownExternalConflict;
  readonly write: (intent: MarkdownSaveIntent) => Promise<{ readonly revision: string }>;
  /** Must begin after earlier writes for this file have settled, without a query cache. */
  readonly read: () => Promise<MarkdownPersistenceReadResult>;
  readonly classifyFailure: (error: unknown) => MarkdownPersistenceFailureKind;
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly prepareExternalUpdate?: PrepareMarkdownExternalUpdate;
}

export interface MarkdownPersistenceSnapshot extends MarkdownDocumentSession {
  readonly transitionVersion: number;
  /** Exact owned attempt, retained while its publication may be ambiguous. */
  readonly publicationSource: string | null;
  /** Includes an ambiguous attempt even if the user has undone back to the old baseline. */
  readonly pending: boolean;
  readonly inFlight: boolean;
  /** Includes a queued read waiting for reconnect or another owned operation. */
  readonly reading: boolean;
  readonly retrying: boolean;
  readonly error: unknown | null;
  /** The last explicitly discarded local draft remains recoverable in this renderer. */
  readonly recoverySource: string | null;
  readonly editingBlocked: boolean;
}

type ReadPurpose =
  | { readonly type: "freshness" }
  | { readonly type: "verify" }
  | { readonly type: "local"; readonly expectedRevision: string }
  | { readonly type: "disk"; readonly editVersion: number };

interface ReadRequest {
  readonly purpose: ReadPurpose;
  readonly resolve?: (accepted: boolean) => void;
}

interface ActiveRead {
  readonly id: number;
  readonly request: ReadRequest;
  readonly generation: number;
  readonly editVersion: number;
}

/**
 * One publication owner for one renderer/file identity. Views lease this owner;
 * they do not own its lifetime. Cached previews and watcher events are never
 * evidence that a write completed. Only matching command results and ordered
 * reads may move the baseline.
 */
export class MarkdownPersistenceCoordinator {
  private readonly options: MarkdownPersistenceOptions;
  private snapshot: MarkdownPersistenceSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly waiters = new Set<(saved: boolean) => void>();
  private writeOperation: { readonly id: number; readonly intent: MarkdownSaveIntent } | null =
    null;
  private ambiguousIntent: MarkdownSaveIntent | null = null;
  private readOperation: ActiveRead | null = null;
  private readRequest: ReadRequest | null = null;
  private verificationNeeded = false;
  private nextOperationId = 1;
  private requestedGeneration = 0;
  private reconciledGeneration = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private dirtySince: number | null = null;
  private retryCount = 0;
  private readonly disconnectedError = new Error(
    "Connection unavailable; your local edits remain open.",
  );
  private connected = true;
  private disposed = false;
  private renameHold: object | null = null;
  private publicationUncertain = false;
  private reconciliationCount = 0;
  private reconciliationDeferred = false;

  resumeExternalUpdates(): void {
    if (!this.reconciliationDeferred || this.disposed) return;
    this.reconciliationDeferred = false;
    this.verificationNeeded = true;
    this.drive();
  }

  constructor(options: MarkdownPersistenceOptions) {
    this.options = options;
    const draftSource = options.draftSource ?? options.source;
    this.snapshot = {
      mode: "write",
      baselineSource: options.source,
      baselineRevision: options.revision,
      draftSource,
      editVersion: draftSource === options.source ? 0 : 1,
      confirmedEditVersion: 0,
      conflict: options.initialConflict ?? null,
      transitionVersion: 0,
      publicationSource: null,
      pending: draftSource !== options.source || options.initialConflict !== undefined,
      inFlight: false,
      reading: false,
      retrying: false,
      error: null,
      recoverySource: null,
      editingBlocked: false,
    };
    if (this.snapshot.pending) this.scheduleDraft();
  }

  getSnapshot = (): MarkdownPersistenceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Reject stale full-document projections instead of silently replacing newer edits. */
  change(source: string, basedOnVersion = this.snapshot.editVersion): boolean {
    if (this.disposed || this.renameHold !== null || basedOnVersion !== this.snapshot.editVersion)
      return false;
    if (source === this.snapshot.draftSource) return true;
    this.update({ draftSource: source, editVersion: this.snapshot.editVersion + 1 });
    this.scheduleDraft();
    return true;
  }

  noteFreshnessHint(_reason?: string): void {
    if (this.disposed) return;
    this.requestedGeneration += 1;
    this.drive();
  }

  /** Flushing never unblocks a verified conflict or a terminal failure. */
  flushNow(): Promise<boolean> {
    if (this.disposed || this.snapshot.conflict !== null || this.snapshot.error !== null) {
      return Promise.resolve(false);
    }
    this.clearDebounce();
    return new Promise((resolve) => {
      this.waiters.add(resolve);
      this.drive();
      this.settleWaiters();
    });
  }

  retry(): Promise<boolean> {
    if (this.disposed || this.snapshot.conflict !== null) return Promise.resolve(false);
    this.retryCount = 0;
    this.clearRetry();
    if (this.verificationNeeded) this.readRequest = { purpose: { type: "verify" } };
    this.update({ error: null });
    return this.flushNow();
  }

  async refresh(): Promise<boolean> {
    if (this.disposed) return false;
    this.requestedGeneration += 1;
    // A requested refresh may verify a blocked lane, but cannot trust query data.
    if (this.snapshot.conflict !== null || this.snapshot.error !== null) {
      this.clearRetry();
      this.update({ error: null });
      return this.requestRead({ type: "verify" });
    }
    this.drive();
    return this.flushNow();
  }

  async resolveWithLocal(expectedPresentedRevision: string): Promise<boolean> {
    if (this.disposed || this.snapshot.conflict?.externalRevision !== expectedPresentedRevision) {
      return false;
    }
    const accepted = await this.requestRead({
      type: "local",
      expectedRevision: expectedPresentedRevision,
    });
    return accepted ? this.flushNow() : false;
  }

  resolveWithDisk(): Promise<boolean> {
    if (this.disposed || this.snapshot.conflict === null) return Promise.resolve(false);
    return this.requestRead({ type: "disk", editVersion: this.snapshot.editVersion });
  }

  restoreRecovery(): boolean {
    const source = this.snapshot.recoverySource;
    if (source === null) return false;
    const previousDraft = this.snapshot.draftSource;
    if (!this.change(source)) return false;
    // Restoring is itself reversible, even after further edits to the disk
    // version. External projection replacement need not retain editor history.
    if (source !== previousDraft) this.update({ recoverySource: previousDraft });
    return true;
  }

  /** A successful rename must move exactly the clean bytes the user named. */
  holdForRename(): (() => void) | null {
    if (
      this.disposed ||
      this.snapshot.pending ||
      this.snapshot.error !== null ||
      this.snapshot.conflict !== null ||
      this.readOperation !== null ||
      this.readRequest !== null
    )
      return null;
    const hold = {};
    this.renameHold = hold;
    this.clearDebounce();
    this.publish();
    return () => {
      if (this.disposed || this.renameHold !== hold) return;
      this.renameHold = null;
      this.publish();
      this.drive();
    };
  }

  setConnected(connected: boolean): void {
    if (this.disposed || connected === this.connected) return;
    this.connected = connected;
    if (connected) {
      this.requestedGeneration += 1;
      this.clearRetry();
      if (this.snapshot.error !== null && this.classify(this.snapshot.error) === "disconnected") {
        this.update({ error: null });
      }
      this.drive();
    }
    this.publish();
  }

  /** The registry may evict only clean, idle entries; releasing a view does not call this. */
  dispose(): boolean {
    if (
      this.snapshot.pending ||
      this.readOperation !== null ||
      this.readRequest !== null ||
      this.snapshot.conflict !== null ||
      this.snapshot.error !== null
    ) {
      return false;
    }
    return this.retireClean();
  }

  /** Only after a successful rename: retire the old identity without applying a late read. */
  retireClean(): boolean {
    if (
      this.snapshot.draftSource !== this.snapshot.baselineSource ||
      this.writeOperation !== null ||
      this.ambiguousIntent !== null ||
      this.snapshot.conflict !== null ||
      this.snapshot.error !== null
    )
      return false;
    this.disposed = true;
    this.renameHold = null;
    this.readOperation?.request.resolve?.(false);
    this.readRequest?.resolve?.(false);
    this.readOperation = null;
    this.readRequest = null;
    this.clearDebounce();
    this.clearRetry();
    for (const resolve of this.waiters) resolve(false);
    this.waiters.clear();
    this.listeners.clear();
    return true;
  }

  private update(patch: Partial<MarkdownPersistenceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.publish();
  }

  private publish(): void {
    const needsPublication =
      this.snapshot.draftSource !== this.snapshot.baselineSource ||
      this.snapshot.conflict !== null ||
      this.writeOperation !== null ||
      this.ambiguousIntent !== null;
    const pending = needsPublication || this.renameHold !== null || this.reconciliationDeferred;
    this.snapshot = {
      ...this.snapshot,
      pending,
      publicationSource: this.writeOperation?.intent.source ?? this.ambiguousIntent?.source ?? null,
      editingBlocked: this.renameHold !== null,
      inFlight: this.writeOperation !== null,
      reading: this.readOperation !== null || this.readRequest !== null,
      retrying: this.retryTimer !== null || (!this.connected && needsPublication),
      transitionVersion: this.snapshot.transitionVersion + 1,
      error:
        !this.connected &&
        needsPublication &&
        this.snapshot.error === null &&
        this.snapshot.conflict === null
          ? this.disconnectedError
          : !needsPublication && this.snapshot.error === this.disconnectedError
            ? null
            : this.snapshot.error,
    };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("Markdown persistence observer failed:", error);
      }
    }
    this.settleWaiters();
  }

  private settleWaiters(): void {
    const blocked = this.snapshot.conflict !== null || this.snapshot.error !== null;
    if (
      !blocked &&
      (this.snapshot.pending || this.readOperation !== null || this.readRequest !== null)
    ) {
      return;
    }
    for (const resolve of this.waiters) resolve(!blocked);
    this.waiters.clear();
  }

  private scheduleDraft(): void {
    if (!this.snapshot.pending) {
      this.dirtySince = null;
      this.clearDebounce();
      this.drive();
      return;
    }
    if (this.dirtySince === null) this.dirtySince = Date.now();
    if (
      this.writeOperation !== null ||
      this.readOperation !== null ||
      this.snapshot.error !== null ||
      this.snapshot.conflict !== null ||
      this.retryTimer !== null
    ) {
      return;
    }
    this.clearDebounce();
    if (this.waiters.size > 0) {
      this.drive();
      return;
    }
    const delay = Math.max(
      0,
      Math.min(
        this.options.debounceMs ?? 500,
        this.dirtySince + (this.options.maxWaitMs ?? 2_000) - Date.now(),
      ),
    );
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.drive();
    }, delay);
  }

  private drive(): void {
    if (
      this.disposed ||
      this.renameHold !== null ||
      this.reconciliationDeferred ||
      !this.connected ||
      this.writeOperation !== null ||
      this.readOperation !== null ||
      this.retryTimer !== null
    ) {
      return;
    }
    if (this.readRequest !== null) {
      const request = this.readRequest;
      this.readRequest = null;
      this.startRead(request);
      return;
    }
    if (this.snapshot.conflict !== null || this.snapshot.error !== null) return;
    if (this.verificationNeeded) {
      this.startRead({ purpose: { type: "verify" } });
      return;
    }
    if (this.debounceTimer !== null) return;
    if (this.ambiguousIntent !== null) {
      this.startWrite(this.ambiguousIntent);
    } else if (this.snapshot.draftSource !== this.snapshot.baselineSource) {
      this.startWrite({
        source: this.snapshot.draftSource,
        expectedRevision: this.snapshot.baselineRevision,
        editVersion: this.snapshot.editVersion,
      });
    } else if (this.requestedGeneration > this.reconciledGeneration) {
      this.startRead({ purpose: { type: "freshness" } });
    } else {
      this.dirtySince = null;
      this.settleWaiters();
    }
  }

  private startWrite(intent: MarkdownSaveIntent): void {
    const id = this.nextOperationId++;
    this.writeOperation = { id, intent };
    this.ambiguousIntent = intent;
    this.publish();
    void this.performWrite(id, intent);
  }

  private async performWrite(id: number, intent: MarkdownSaveIntent): Promise<void> {
    try {
      const result = await this.options.write(intent);
      if (this.writeOperation?.id !== id) return;
      this.writeOperation = null;
      this.ambiguousIntent = null;
      this.publicationUncertain = false;
      this.reconciliationCount = 0;
      this.retryCount = 0;
      this.update({
        baselineSource: intent.source,
        baselineRevision: result.revision,
        confirmedEditVersion: Math.max(this.snapshot.confirmedEditVersion, intent.editVersion),
        error: null,
      });
      this.scheduleDraft();
    } catch (error) {
      if (this.writeOperation?.id !== id) return;
      this.writeOperation = null;
      const kind = this.classify(error);
      if (kind === "conflict") {
        this.verificationNeeded = true;
        this.publish();
        this.drive();
      } else {
        this.publicationUncertain = true;
        this.handleFailure(error, kind);
      }
    }
  }

  private requestRead(purpose: ReadPurpose): Promise<boolean> {
    if (this.readRequest !== null || this.readOperation?.request.resolve !== undefined) {
      // A manual refresh may have cleared a backoff timer. Keep the already
      // requested resolution progressing instead of replacing or stranding it.
      this.drive();
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      this.readRequest = { purpose, resolve };
      this.drive();
      if (this.readRequest !== null) this.publish();
    });
  }

  private startRead(request: ReadRequest): void {
    const operation: ActiveRead = {
      id: this.nextOperationId++,
      request,
      generation: this.requestedGeneration,
      editVersion: this.snapshot.editVersion,
    };
    this.readOperation = operation;
    this.publish();
    void this.performRead(operation);
  }

  private async performRead(operation: ActiveRead): Promise<void> {
    try {
      const disk = await this.options.read();
      if (this.readOperation?.id !== operation.id) return;
      this.readOperation = null;
      const purpose = operation.request.purpose;
      const protectedEditVersion =
        purpose.type === "disk" ? purpose.editVersion : operation.editVersion;
      if (
        (purpose.type === "freshness" || purpose.type === "disk") &&
        protectedEditVersion !== this.snapshot.editVersion
      ) {
        // A disk choice protects edits made after the click, including while
        // transient retries or newer watcher generations delayed that choice.
        operation.request.resolve?.(false);
        this.publish();
        this.scheduleDraft();
        return;
      }
      if (operation.generation !== this.requestedGeneration) {
        // A later event may describe bytes not represented by this read.
        this.readRequest ??= operation.request;
        if (this.readRequest !== operation.request) operation.request.resolve?.(false);
        this.publish();
        this.drive();
        return;
      }
      if (disk.truncated || disk.readOnly) {
        operation.request.resolve?.(false);
        this.update({
          error: new Error(
            disk.truncated
              ? "The file is too large to read completely; your local edits remain open."
              : "The file is now read-only; your local edits remain open.",
          ),
        });
        return;
      }
      this.reconciledGeneration = operation.generation;
      this.retryCount = 0;
      const accepted = this.acceptRead(disk, purpose);
      operation.request.resolve?.(accepted);
      this.scheduleDraft();
    } catch (error) {
      if (this.readOperation?.id !== operation.id) return;
      this.readOperation = null;
      const kind = this.classify(error);
      if (this.canRetry(kind)) {
        this.readRequest ??= operation.request;
        this.handleFailure(error, kind);
      } else {
        operation.request.resolve?.(false);
        if (
          operation.request.purpose.type === "freshness" &&
          !this.snapshot.pending &&
          (kind === "transient" || kind === "disconnected")
        ) {
          // A failed background refresh is not an unsaved edit. Leave its
          // generation unreconciled so the next hint/reconnect reads again.
          if (kind === "disconnected") this.connected = false;
          this.retryCount = 0;
          this.update({ error: null });
        } else {
          this.handleFailure(error, kind);
        }
      }
    }
  }

  private acceptRead(disk: MarkdownPersistenceReadResult, purpose: ReadPurpose): boolean {
    const current = this.snapshot;
    if (current.conflict !== null && purpose.type === "verify") {
      this.update({
        conflict: { externalSource: disk.source, externalRevision: disk.revision },
        error: null,
      });
      return false;
    }
    if (purpose.type === "local" && disk.revision !== purpose.expectedRevision) {
      this.ambiguousIntent = null;
      this.verificationNeeded = false;
      this.update({
        conflict: { externalSource: disk.source, externalRevision: disk.revision },
        error: null,
      });
      return false;
    }
    if (purpose.type === "disk") {
      this.ambiguousIntent = null;
      this.verificationNeeded = false;
      this.update({
        recoverySource: current.draftSource,
        baselineSource: disk.source,
        baselineRevision: disk.revision,
        draftSource: disk.source,
        editVersion: current.editVersion + 1,
        confirmedEditVersion: current.editVersion + 1,
        conflict: null,
        error: null,
      });
      return true;
    }
    if (purpose.type === "local") {
      this.ambiguousIntent = null;
      this.verificationNeeded = false;
      this.update({
        baselineSource: disk.source,
        baselineRevision: disk.revision,
        conflict: null,
        error: null,
      });
      return true;
    }
    const attempted = this.ambiguousIntent;
    const matchesDraft = disk.source === current.draftSource;
    const matchesAttempt = attempted !== null && disk.source === attempted.source;
    const matchesBaseline = disk.source === current.baselineSource;
    const clean = !current.pending;
    const canReconcile = !this.publicationUncertain && this.reconciliationCount < 3;
    this.ambiguousIntent = null;
    this.verificationNeeded = false;
    if (matchesDraft || matchesAttempt || matchesBaseline) {
      this.publicationUncertain = false;
      const adopt = matchesDraft || clean;
      this.update({
        baselineSource: disk.source,
        baselineRevision: disk.revision,
        ...(adopt ? { draftSource: disk.source } : {}),
        ...(adopt && disk.source !== current.draftSource
          ? { editVersion: current.editVersion + 1 }
          : {}),
        confirmedEditVersion: adopt
          ? current.editVersion + (disk.source !== current.draftSource ? 1 : 0)
          : matchesAttempt
            ? Math.max(current.confirmedEditVersion, attempted.editVersion)
            : current.confirmedEditVersion,
        conflict: null,
        error: null,
      });
      return true;
    }
    if (canReconcile) {
      const merged = reconcileMarkdown(current.baselineSource, current.draftSource, disk.source);
      if (merged !== null) {
        const update = {
          ...merged,
          previousSource: current.draftSource,
          editVersion: current.editVersion + 1,
        };
        try {
          const prepared = this.options.prepareExternalUpdate?.(update);
          if (this.snapshot.editVersion !== current.editVersion) {
            this.verificationNeeded = true;
            return false;
          }
          if (prepared === "defer") {
            this.reconciliationDeferred = true;
            this.verificationNeeded = true;
            this.publish();
            return false;
          }
          if (prepared !== null) {
            prepared?.();
            if (this.snapshot.editVersion !== current.editVersion) {
              this.verificationNeeded = true;
              return false;
            }
            this.reconciliationCount = clean ? 0 : this.reconciliationCount + 1;
            this.publicationUncertain = false;
            this.update({
              baselineSource: disk.source,
              baselineRevision: disk.revision,
              draftSource: merged.source,
              editVersion: update.editVersion,
              ...(clean ? { confirmedEditVersion: update.editVersion } : {}),
              conflict: null,
              error: null,
            });
            return true;
          }
        } catch {
          // Retain both originals if a view cannot apply the prepared update.
        }
      }
    }
    if (clean) {
      // Preserve the established clean-refresh behavior when an incremental
      // projection is unavailable. No unpublished local content is discarded.
      this.publicationUncertain = false;
      this.reconciliationCount = 0;
      this.update({
        baselineSource: disk.source,
        baselineRevision: disk.revision,
        draftSource: disk.source,
        editVersion: current.editVersion + 1,
        confirmedEditVersion: current.editVersion + 1,
        conflict: null,
        error: null,
      });
      return true;
    }
    this.update({
      conflict: { externalSource: disk.source, externalRevision: disk.revision },
      error: null,
    });
    return false;
  }

  private classify(error: unknown): MarkdownPersistenceFailureKind {
    if (error === this.disconnectedError) return "disconnected";
    try {
      return this.options.classifyFailure(error);
    } catch {
      return "terminal";
    }
  }

  private canRetry(kind: MarkdownPersistenceFailureKind): boolean {
    const delays = this.options.retryDelaysMs ?? [250, 1_000, 3_000];
    const limit = kind === "operation" ? Math.min(2, delays.length) : delays.length;
    return (kind === "transient" || kind === "operation") && this.retryCount < limit;
  }

  private handleFailure(error: unknown, kind: MarkdownPersistenceFailureKind): void {
    this.clearDebounce();
    if (kind === "disconnected") {
      this.connected = false;
      this.update({ error });
      return;
    }
    if (this.canRetry(kind)) {
      const delay = (this.options.retryDelaysMs ?? [250, 1_000, 3_000])[this.retryCount] ?? 0;
      this.retryCount += 1;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.publish();
        this.drive();
      }, delay);
      this.publish();
      return;
    }
    this.update({ error });
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
