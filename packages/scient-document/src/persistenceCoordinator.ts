// @effect-diagnostics globalTimers:off -- Framework-neutral persistence lane with an injected transport and deterministic timer tests.
// @effect-diagnostics globalDate:off -- Elapsed debounce deadlines share the timer clock, virtualized in deterministic tests.
// @effect-diagnostics globalConsole:off -- Observer defects must not interrupt publication bookkeeping.
import {
  beginDocumentSave,
  type DocumentExternalConflict,
  type DocumentSaveIntent,
  type DocumentSession,
} from "./session.ts";
import {
  applyDocumentSourcePatches,
  DocumentSourcePatchError,
  type DocumentSourceEdit,
  type DocumentSourceEditOutcome,
  type DocumentSourcePatch,
} from "./sourcePatch.ts";

/** The combined source of a three-way merge, plus any format-specific detail. */
export interface DocumentReconciliation {
  readonly source: string;
}

/**
 * A merge that also says how to reach it from the local draft, so a view that
 * shows the draft can apply the outside change in place instead of reloading.
 */
export interface DocumentPatchReconciliation extends DocumentReconciliation {
  /** Changes from the local draft to `source`, in UTF-16 offsets. */
  readonly patches: ReadonlyArray<DocumentSourcePatch>;
}

/**
 * Format-specific three-way merge of the acknowledged baseline, the local draft,
 * and verified disk bytes. Returns null when the changes cannot be combined
 * safely, which keeps the explicit conflict choices.
 */
export type ReconcileDocument<R extends DocumentReconciliation> = (
  baselineSource: string,
  draftSource: string,
  diskSource: string,
) => R | null;

export type DocumentExternalUpdate<R extends DocumentReconciliation = DocumentReconciliation> =
  R & {
    readonly previousSource: string;
    readonly editVersion: number;
  };
export type PrepareDocumentExternalUpdate<
  R extends DocumentReconciliation = DocumentReconciliation,
> = (update: DocumentExternalUpdate<R>) => (() => void) | "defer" | null;

export type DocumentPersistenceAttention =
  | "recovery_required"
  | "target_changed"
  | "mutation_unavailable"
  | "mutation_intent_conflict"
  | "outcome_unknown";

export type DocumentPersistenceFailureKind =
  | "conflict"
  | "transient"
  | "operation"
  | "disconnected"
  | "terminal"
  | DocumentPersistenceAttention;

export interface DocumentFilePublicationAttention {
  readonly recoveryId: string;
  readonly mutationId: string;
  readonly retainedPaths: readonly string[];
  readonly message: string;
}

export type DocumentPublicationOutcome = "unchanged" | "retained-attention";

export interface DocumentPersistenceReadResult {
  readonly source: string;
  readonly revision: string;
  readonly missing?: false;
  readonly truncated?: boolean;
  readonly readOnly?: boolean;
  readonly publicationAttention?: DocumentFilePublicationAttention | null;
}

/** Absence is reviewed separately; it is never an empty document baseline. */
export type DocumentPersistenceCurrentReview =
  | DocumentPersistenceReadResult
  | {
      readonly missing: true;
      readonly revision: null;
      readonly publicationAttention?: DocumentFilePublicationAttention | null;
      readonly source?: never;
      readonly truncated?: never;
      readonly readOnly?: never;
    };

/** A native resolution already accepted this exact reviewed revision. */
export interface DocumentAuthorizedCurrentReview {
  readonly recoveryId: string;
  readonly currentRevision: string | null;
}

export interface DocumentPersistenceOptions<
  R extends DocumentReconciliation = DocumentReconciliation,
> {
  readonly source: string;
  readonly revision: string;
  readonly draftSource?: string;
  readonly initialConflict?: DocumentExternalConflict;
  readonly initialAttention?: DocumentPersistenceAttention;
  readonly initialPublication?: DocumentSaveIntent;
  readonly initialPublicationAttention?: DocumentFilePublicationAttention;
  readonly initialPublicationOutcome?: DocumentPublicationOutcome;
  readonly initialAttentionMutationId?: string;
  readonly initialCurrentMissing?: boolean;
  readonly initialAuthorizedCurrentReview?: DocumentAuthorizedCurrentReview;
  readonly write: (intent: DocumentSaveIntent) => Promise<{ readonly revision: string }>;
  /** Must begin after earlier writes for this file have settled, without a query cache. */
  readonly read: () => Promise<DocumentPersistenceReadResult>;
  readonly readForReview?: () => Promise<DocumentPersistenceCurrentReview>;
  readonly classifyFailure: (error: unknown) => DocumentPersistenceFailureKind;
  readonly describeAttention?: (
    error: unknown,
    mutationId?: string,
  ) => DocumentFilePublicationAttention | null;
  readonly describeOutcome?: (error: unknown) => DocumentPublicationOutcome | null;
  readonly resolve?: (input: {
    readonly recoveryId: string;
    readonly currentRevision: string | null;
  }) => Promise<{ readonly revision: string | null }>;
  /** Strict journal CAS, for both authorization admission and accepted confirmation settlement. */
  readonly persistAuthorizedCurrentReview?: (
    snapshot: DocumentPersistenceSnapshot,
  ) => Promise<void>;
  /** The format's merge strategy for verified divergence between draft and disk. */
  readonly reconcile: ReconcileDocument<R>;
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly prepareExternalUpdate?: PrepareDocumentExternalUpdate<R>;
}

export interface DocumentPersistenceSnapshot extends DocumentSession {
  readonly transitionVersion: number;
  /** Exact owned attempt, retained while its publication may be ambiguous. */
  readonly publicationSource: string | null;
  readonly publicationIntent: DocumentSaveIntent | null;
  /** Includes an ambiguous attempt even if the user has undone back to the old baseline. */
  readonly pending: boolean;
  readonly inFlight: boolean;
  /** Includes a queued read waiting for reconnect or another owned operation. */
  readonly reading: boolean;
  readonly retrying: boolean;
  readonly error: unknown | null;
  /** Terminal mutation outcome; no watcher, equal read, or reconnect may dismiss it. */
  readonly attention: DocumentPersistenceAttention | null;
  readonly publicationAttention: DocumentFilePublicationAttention | null;
  readonly publicationOutcome: DocumentPublicationOutcome | null;
  readonly attentionMutationId: string | null;
  readonly authorizedCurrentReview: DocumentAuthorizedCurrentReview | null;
  readonly currentMissing: boolean;
  /** The last explicitly discarded local draft remains recoverable in this renderer. */
  readonly recoverySource: string | null;
  readonly editingBlocked: boolean;
}

type ReadPurpose =
  | { readonly type: "freshness" }
  | { readonly type: "verify" }
  | { readonly type: "local"; readonly expectedRevision: string }
  | { readonly type: "disk"; readonly editVersion: number }
  | { readonly type: "review"; readonly recoveryId: string }
  | {
      readonly type: "refusal";
      readonly currentRevision: string | null;
      readonly editVersion: number;
    }
  | {
      readonly type: "retained";
      readonly recoveryId: string;
      readonly currentRevision: string | null;
      readonly editVersion: number;
    };

interface ReadRequest {
  readonly purpose: ReadPurpose;
  readonly resolve?: (accepted: boolean) => void;
  readonly review?: (disk: DocumentPersistenceCurrentReview | null) => void;
}

interface ActiveRead {
  readonly id: number;
  readonly request: ReadRequest;
  readonly generation: number;
  readonly editVersion: number;
  readonly externalUpdatesGeneration: number;
}

/**
 * One publication owner for one renderer/file identity. Views lease this owner;
 * they do not own its lifetime. Cached previews and watcher events are never
 * evidence that a write completed. Only matching command results and ordered
 * reads may move the baseline.
 */
export class DocumentPersistenceCoordinator<
  R extends DocumentReconciliation = DocumentReconciliation,
> {
  private readonly options: DocumentPersistenceOptions<R>;
  private snapshot: DocumentPersistenceSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly waiters = new Set<(saved: boolean) => void>();
  private writeOperation: { readonly id: number; readonly intent: DocumentSaveIntent } | null =
    null;
  private ambiguousIntent: DocumentSaveIntent | null = null;
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
  private renameRelease: (() => void) | null = null;
  /** Where saves and reads go; replaced only by the holder of a rename. */
  private io: Pick<
    DocumentPersistenceOptions<R>,
    | "write"
    | "read"
    | "readForReview"
    | "classifyFailure"
    | "describeAttention"
    | "describeOutcome"
    | "resolve"
    | "persistAuthorizedCurrentReview"
  >;
  private publicationUncertain = false;
  private reconciliationCount = 0;
  private reconciliationDeferred = false;
  private missingCreationHold = false;
  private readonly externalUpdateHolds = new Set<object>();
  private externalUpdatesGeneration = 0;

  /**
   * Keep pending input outside the accepted source safe from refreshes. Accepted
   * writes already in flight can acknowledge, but new operations wait for every
   * holder. Existing files require an ordered reread; reviewed absence remains
   * pending and can only be recreated through an exclusive new intent.
   */
  suspendExternalUpdates(): () => void {
    if (this.disposed) return () => {};
    const hold = {};
    this.externalUpdateHolds.add(hold);
    this.externalUpdatesGeneration += 1;
    this.clearDebounce();
    this.publish();
    return () => {
      if (this.disposed || !this.externalUpdateHolds.delete(hold)) return;
      this.externalUpdatesGeneration += 1;
      if (this.externalUpdateHolds.size === 0 && this.snapshot.attention === null) {
        this.requestedGeneration += 1;
        if (!this.snapshot.currentMissing) {
          this.verificationNeeded = true;
          this.readRequest ??= { purpose: { type: "verify" } };
        }
      }
      this.publish();
      this.drive();
    };
  }

  resumeExternalUpdates(): void {
    if (!this.reconciliationDeferred || this.disposed) return;
    this.reconciliationDeferred = false;
    this.verificationNeeded = true;
    this.drive();
  }

  constructor(options: DocumentPersistenceOptions<R>) {
    this.options = options;
    this.io = {
      write: options.write,
      read: options.read,
      ...(options.readForReview ? { readForReview: options.readForReview } : {}),
      classifyFailure: options.classifyFailure,
      ...(options.describeAttention ? { describeAttention: options.describeAttention } : {}),
      ...(options.describeOutcome ? { describeOutcome: options.describeOutcome } : {}),
      ...(options.resolve ? { resolve: options.resolve } : {}),
      ...(options.persistAuthorizedCurrentReview
        ? { persistAuthorizedCurrentReview: options.persistAuthorizedCurrentReview }
        : {}),
    };
    this.ambiguousIntent = options.initialPublication ?? null;
    this.publicationUncertain = this.ambiguousIntent !== null;
    this.missingCreationHold =
      options.initialCurrentMissing === true && this.ambiguousIntent === null;
    const draftSource = options.draftSource ?? options.source;
    this.snapshot = {
      mode: "write",
      baselineSource: options.source,
      baselineRevision: options.revision,
      draftSource,
      editVersion: Math.max(
        draftSource === options.source ? 0 : 1,
        (options.initialPublication?.editVersion ?? 0) +
          (options.initialPublication && draftSource !== options.initialPublication.source ? 1 : 0),
      ),
      confirmedEditVersion: 0,
      conflict: options.initialConflict ?? null,
      currentMissing: options.initialCurrentMissing === true,
      transitionVersion: 0,
      publicationSource: options.initialPublication?.source ?? null,
      publicationIntent: options.initialPublication ?? null,
      pending:
        draftSource !== options.source ||
        options.initialConflict !== undefined ||
        options.initialAttention !== undefined ||
        options.initialPublicationAttention !== undefined ||
        options.initialCurrentMissing === true ||
        options.initialPublication !== undefined,
      inFlight: false,
      reading: false,
      retrying: false,
      error: options.initialPublicationAttention
        ? new Error(options.initialPublicationAttention.message)
        : options.initialAttention
          ? new Error("A previous file mutation requires attention. Review the retained versions.")
          : null,
      attention: options.initialPublicationAttention
        ? "recovery_required"
        : (options.initialAttention ?? null),
      publicationAttention: options.initialPublicationAttention ?? null,
      publicationOutcome: options.initialPublicationAttention
        ? "retained-attention"
        : (options.initialPublicationOutcome ?? null),
      attentionMutationId:
        options.initialPublicationAttention?.mutationId ??
        options.initialAttentionMutationId ??
        options.initialPublication?.mutationId ??
        null,
      authorizedCurrentReview:
        options.initialAuthorizedCurrentReview?.recoveryId ===
        options.initialPublicationAttention?.recoveryId
          ? (options.initialAuthorizedCurrentReview ?? null)
          : null,
      recoverySource: null,
      editingBlocked: false,
    };
    if (this.snapshot.pending) this.scheduleDraft();
  }

  getSnapshot = (): DocumentPersistenceSnapshot => this.snapshot;

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

  /**
   * Take one planned edit. It becomes the working source only when it was
   * planned against the current working source and every patch is safe;
   * otherwise nothing changes and the reason is returned.
   */
  applyEdit(edit: DocumentSourceEdit): DocumentSourceEditOutcome {
    if (this.disposed || this.renameHold !== null)
      return { accepted: false, reason: "unavailable" };
    if (edit.basedOnVersion !== this.snapshot.editVersion)
      return { accepted: false, reason: "version" };
    let source: string;
    try {
      source = applyDocumentSourcePatches(this.snapshot.draftSource, edit.patches);
    } catch (error) {
      if (error instanceof DocumentSourcePatchError)
        return { accepted: false, reason: error.problem };
      throw error;
    }
    return this.change(source, edit.basedOnVersion)
      ? { accepted: true }
      : { accepted: false, reason: "unavailable" };
  }

  noteFreshnessHint(_reason?: string): void {
    if (this.disposed) return;
    this.requestedGeneration += 1;
    this.drive();
  }

  /** Flushing never unblocks a verified conflict or a terminal failure. */
  flushNow(): Promise<boolean> {
    if (
      this.disposed ||
      this.externalUpdateHolds.size > 0 ||
      this.snapshot.conflict !== null ||
      this.snapshot.attention !== null ||
      this.missingCreationHold ||
      this.snapshot.error !== null
    ) {
      return Promise.resolve(false);
    }
    this.clearDebounce();
    return new Promise((resolve) => {
      this.waiters.add(resolve);
      this.drive();
      this.settleWaiters();
    });
  }

  /** A distinct user action recreates reviewed absence with an exclusive new intent. */
  recreateMissingCurrent(): Promise<boolean> {
    if (
      !this.snapshot.currentMissing ||
      this.disposed ||
      this.snapshot.attention !== null ||
      this.snapshot.error !== null ||
      this.externalUpdateHolds.size > 0 ||
      this.renameHold !== null ||
      this.ambiguousIntent !== null ||
      this.writeOperation !== null ||
      this.readOperation !== null ||
      !this.connected
    )
      return Promise.resolve(false);
    this.missingCreationHold = false;
    this.verificationNeeded = false;
    this.update({ editVersion: this.snapshot.editVersion + 1 });
    return this.flushNow();
  }

  retry(): Promise<boolean> {
    if (this.disposed || this.snapshot.conflict !== null || this.snapshot.attention !== null)
      return Promise.resolve(false);
    this.retryCount = 0;
    this.clearRetry();
    if (this.verificationNeeded) this.readRequest = { purpose: { type: "verify" } };
    this.update({ error: null });
    return this.flushNow();
  }

  async refresh(): Promise<boolean> {
    if (this.disposed || this.snapshot.attention !== null) return false;
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

  /** A held external mutation failed without a confirmed success acknowledgement. */
  noteMutationFailure(error: unknown, mutationId?: string): void {
    if (this.disposed) return;
    const kind = this.classify(error);
    const attention =
      kind === "recovery_required" ||
      kind === "target_changed" ||
      kind === "mutation_unavailable" ||
      kind === "mutation_intent_conflict"
        ? kind
        : "outcome_unknown";
    this.clearDebounce();
    this.clearRetry();
    this.verificationNeeded = false;
    this.readRequest?.resolve?.(false);
    this.readRequest?.review?.(null);
    this.readRequest = null;
    this.update({
      attention,
      error,
      publicationAttention:
        this.io.describeAttention?.(error, mutationId) ?? this.snapshot.publicationAttention,
      publicationOutcome: this.snapshot.publicationAttention
        ? "retained-attention"
        : (this.io.describeOutcome?.(error) ?? null),
      attentionMutationId: mutationId ?? this.snapshot.attentionMutationId,
      authorizedCurrentReview: null,
    });
  }

  private observePublicationAttention(attention: DocumentFilePublicationAttention): void {
    if (this.disposed) return;
    this.clearDebounce();
    this.clearRetry();
    this.verificationNeeded = false;
    this.update({
      attention: "recovery_required",
      publicationAttention: attention,
      publicationOutcome: "retained-attention",
      attentionMutationId: attention.mutationId,
      authorizedCurrentReview: null,
      error: new Error(attention.message),
    });
  }

  /** A proven unchanged refusal is released only by explicit exact-revision review. */
  reviewUnchangedRefusal(currentRevision: string | null): Promise<boolean> {
    if (
      this.disposed ||
      this.snapshot.attention === null ||
      this.snapshot.publicationOutcome !== "unchanged" ||
      this.externalUpdateHolds.size > 0 ||
      this.renameHold !== null ||
      !this.connected
    )
      return Promise.resolve(false);
    return this.requestRead({
      type: "refusal",
      currentRevision,
      editVersion: this.snapshot.editVersion,
    });
  }

  /** Display disk bytes without adopting them or releasing retained attention. */
  reviewRetainedCurrent(recoveryId: string): Promise<DocumentPersistenceCurrentReview | null> {
    if (
      this.disposed ||
      this.snapshot.attention === null ||
      (this.snapshot.publicationAttention !== null &&
        this.snapshot.publicationAttention.recoveryId !== recoveryId) ||
      this.readRequest !== null ||
      this.readOperation !== null ||
      this.externalUpdateHolds.size > 0 ||
      this.renameHold !== null ||
      !this.connected
    )
      return Promise.resolve(null);
    const { promise, resolve } = Promise.withResolvers<DocumentPersistenceCurrentReview | null>();
    this.readRequest = { purpose: { type: "review", recoveryId }, review: resolve };
    this.drive();
    return promise;
  }

  /** Accept reviewed current bytes only after the server durably authorizes the exact revision. */
  resolveRetainedAttention(recoveryId: string, currentRevision: string | null): Promise<boolean> {
    const attention = this.snapshot.publicationAttention;
    const authorized = this.snapshot.authorizedCurrentReview;
    if (
      this.disposed ||
      this.snapshot.attention === null ||
      (attention !== null && attention.recoveryId !== recoveryId) ||
      this.io.resolve === undefined ||
      this.io.persistAuthorizedCurrentReview === undefined ||
      (authorized !== null &&
        (authorized.recoveryId !== recoveryId || authorized.currentRevision !== currentRevision)) ||
      this.externalUpdateHolds.size > 0 ||
      this.renameHold !== null ||
      !this.connected
    )
      return Promise.resolve(false);
    return this.requestRead({
      type: "retained",
      recoveryId,
      currentRevision,
      editVersion: this.snapshot.editVersion,
    });
  }

  async resolveWithLocal(expectedPresentedRevision: string): Promise<boolean> {
    if (
      this.disposed ||
      this.snapshot.attention !== null ||
      this.snapshot.conflict?.externalRevision !== expectedPresentedRevision
    ) {
      return false;
    }
    const accepted = await this.requestRead({
      type: "local",
      expectedRevision: expectedPresentedRevision,
    });
    return accepted ? this.flushNow() : false;
  }

  resolveWithDisk(): Promise<boolean> {
    if (this.disposed || this.snapshot.attention !== null || this.snapshot.conflict === null)
      return Promise.resolve(false);
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
      this.externalUpdateHolds.size > 0 ||
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
    const release = () => {
      if (this.disposed || this.renameHold !== hold) return;
      this.renameHold = null;
      this.renameRelease = null;
      this.publish();
      this.drive();
    };
    this.renameRelease = release;
    return release;
  }

  /** Replays only a separately journaled namespace intent, never a save intent. */
  holdForRecoveredRename(mutationId: string, expectedRevision: string): (() => void) | null {
    if (
      this.disposed ||
      this.renameHold !== null ||
      this.externalUpdateHolds.size > 0 ||
      this.snapshot.attentionMutationId !== mutationId ||
      this.snapshot.baselineRevision !== expectedRevision ||
      this.snapshot.publicationIntent !== null ||
      this.writeOperation !== null ||
      this.ambiguousIntent !== null ||
      this.readOperation !== null ||
      this.readRequest !== null
    )
      return null;
    const hold = {};
    this.renameHold = hold;
    this.clearDebounce();
    this.clearRetry();
    this.publish();
    const release = () => {
      if (this.disposed || this.renameHold !== hold) return;
      this.renameHold = null;
      this.renameRelease = null;
      this.publish();
      this.drive();
    };
    this.renameRelease = release;
    return release;
  }

  /** An exact namespace receipt releases its attention, without replacing working input. */
  acknowledgeRecoveredRename(renameRelease: () => void, mutationId: string): boolean {
    if (
      this.disposed ||
      this.renameHold === null ||
      this.renameRelease !== renameRelease ||
      this.snapshot.publicationIntent !== null ||
      (this.snapshot.attentionMutationId !== null &&
        this.snapshot.attentionMutationId !== mutationId)
    )
      return false;
    this.verificationNeeded = false;
    this.missingCreationHold = false;
    this.reconciliationDeferred = false;
    this.update({
      attention: null,
      error: null,
      publicationAttention: null,
      publicationOutcome: null,
      attentionMutationId: null,
      currentMissing: false,
    });
    return true;
  }

  /**
   * The file was renamed while held: saves and reads go to the new path from
   * now on. Only the current rename's holder may do this, and only while held.
   */
  replaceIo(
    renameRelease: () => void,
    io: Pick<
      DocumentPersistenceOptions<R>,
      | "write"
      | "read"
      | "readForReview"
      | "classifyFailure"
      | "describeAttention"
      | "describeOutcome"
      | "resolve"
      | "persistAuthorizedCurrentReview"
    >,
  ): boolean {
    if (this.disposed || this.renameHold === null || this.renameRelease !== renameRelease)
      return false;
    this.io = { ...io };
    return true;
  }

  /**
   * Pending only because a rename holds the document: nothing unsaved, no
   * deferred reconciliation, no other hold. Recovery copies have nothing to keep.
   */
  pendingOnlyForRename(): boolean {
    return (
      this.renameHold !== null &&
      this.snapshot.draftSource === this.snapshot.baselineSource &&
      !this.snapshot.currentMissing &&
      this.snapshot.conflict === null &&
      this.snapshot.attention === null &&
      this.writeOperation === null &&
      this.ambiguousIntent === null &&
      !this.reconciliationDeferred &&
      this.externalUpdateHolds.size === 0
    );
  }

  setConnected(connected: boolean): void {
    if (this.disposed || connected === this.connected) return;
    this.connected = connected;
    if (connected) {
      this.requestedGeneration += 1;
      this.clearRetry();
      if (
        this.snapshot.attention === null &&
        this.snapshot.error !== null &&
        this.classify(this.snapshot.error) === "disconnected"
      ) {
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
      this.externalUpdateHolds.size > 0 ||
      this.writeOperation !== null ||
      this.ambiguousIntent !== null ||
      this.snapshot.conflict !== null ||
      this.snapshot.attention !== null ||
      this.snapshot.error !== null
    )
      return false;
    this.disposed = true;
    this.renameHold = null;
    this.renameRelease = null;
    this.readOperation?.request.resolve?.(false);
    this.readOperation?.request.review?.(null);
    this.readRequest?.resolve?.(false);
    this.readRequest?.review?.(null);
    this.readOperation = null;
    this.readRequest = null;
    this.clearDebounce();
    this.clearRetry();
    for (const resolve of this.waiters) resolve(false);
    this.waiters.clear();
    this.listeners.clear();
    return true;
  }

  private update(patch: Partial<DocumentPersistenceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.publish();
  }

  private publish(): void {
    const needsPublication =
      this.snapshot.draftSource !== this.snapshot.baselineSource ||
      this.snapshot.conflict !== null ||
      this.writeOperation !== null ||
      this.ambiguousIntent !== null ||
      this.snapshot.currentMissing ||
      this.snapshot.attention !== null ||
      this.snapshot.authorizedCurrentReview !== null;
    const pending =
      needsPublication ||
      this.renameHold !== null ||
      this.reconciliationDeferred ||
      this.externalUpdateHolds.size > 0;
    this.snapshot = {
      ...this.snapshot,
      pending,
      publicationSource: this.writeOperation?.intent.source ?? this.ambiguousIntent?.source ?? null,
      publicationIntent: this.writeOperation?.intent ?? this.ambiguousIntent,
      editingBlocked: this.renameHold !== null,
      inFlight: this.writeOperation !== null,
      reading: this.readOperation !== null || this.readRequest !== null,
      retrying:
        this.snapshot.attention === null &&
        (this.retryTimer !== null || (!this.connected && needsPublication)),
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
        console.error("Document persistence observer failed:", error);
      }
    }
    this.settleWaiters();
  }

  private settleWaiters(): void {
    const blocked =
      this.snapshot.attention !== null ||
      this.snapshot.conflict !== null ||
      this.snapshot.error !== null;
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
      this.externalUpdateHolds.size > 0 ||
      this.readOperation !== null ||
      this.snapshot.error !== null ||
      this.snapshot.attention !== null ||
      this.snapshot.conflict !== null ||
      this.missingCreationHold ||
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
      this.externalUpdateHolds.size > 0 ||
      this.renameHold !== null ||
      this.reconciliationDeferred ||
      !this.connected ||
      this.writeOperation !== null ||
      this.readOperation !== null ||
      this.retryTimer !== null
    ) {
      return;
    }
    if (
      this.snapshot.attention !== null &&
      this.readRequest?.purpose.type !== "refusal" &&
      this.readRequest?.purpose.type !== "retained" &&
      this.readRequest?.purpose.type !== "review"
    )
      return;
    if (this.readRequest !== null) {
      const request = this.readRequest;
      this.readRequest = null;
      this.startRead(request);
      return;
    }
    if (this.snapshot.conflict !== null || this.snapshot.error !== null) return;
    if (this.missingCreationHold) return;
    if (this.verificationNeeded) {
      this.startRead({ purpose: { type: "verify" } });
      return;
    }
    if (this.debounceTimer !== null) return;
    if (this.ambiguousIntent !== null) {
      this.startWrite(this.ambiguousIntent);
    } else if (
      this.snapshot.currentMissing ||
      this.snapshot.draftSource !== this.snapshot.baselineSource
    ) {
      this.startWrite(beginDocumentSave(this.snapshot)!);
    } else if (this.requestedGeneration > this.reconciledGeneration) {
      this.startRead({ purpose: { type: "freshness" } });
    } else {
      this.dirtySince = null;
      this.settleWaiters();
    }
  }

  private startWrite(intent: DocumentSaveIntent): void {
    const id = this.nextOperationId++;
    this.writeOperation = { id, intent };
    this.ambiguousIntent = intent;
    this.publish();
    void this.performWrite(id, intent);
  }

  private async performWrite(id: number, intent: DocumentSaveIntent): Promise<void> {
    try {
      const result = await this.io.write(intent);
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
        currentMissing: false,
      });
      this.scheduleDraft();
    } catch (error) {
      if (this.writeOperation?.id !== id) return;
      this.writeOperation = null;
      const kind = this.classify(error);
      if (kind === "conflict" && !this.publicationUncertain) {
        this.verificationNeeded = true;
        this.publish();
        this.drive();
      } else {
        this.publicationUncertain = true;
        this.handleFailure(error, kind === "conflict" ? "outcome_unknown" : kind);
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
      externalUpdatesGeneration: this.externalUpdatesGeneration,
    };
    this.readOperation = operation;
    this.publish();
    void this.performRead(operation);
  }

  private async performRead(operation: ActiveRead): Promise<void> {
    try {
      if (operation.request.purpose.type === "retained") {
        await this.performRetainedRead(operation);
        return;
      }
      const disk = await (operation.request.purpose.type === "refusal" ||
      operation.request.purpose.type === "review"
        ? (this.io.readForReview?.() ?? this.io.read())
        : this.io.read());
      if (operation.request.purpose.type === "refusal") {
        const purpose = operation.request.purpose;
        if (this.readOperation?.id !== operation.id) return;
        this.readOperation = null;
        if (disk.publicationAttention) {
          this.observePublicationAttention(disk.publicationAttention);
          operation.request.resolve?.(false);
          return;
        }
        const accepted =
          this.snapshot.publicationOutcome === "unchanged" &&
          this.externalUpdateHolds.size === 0 &&
          operation.externalUpdatesGeneration === this.externalUpdatesGeneration &&
          operation.generation === this.requestedGeneration &&
          purpose.editVersion === this.snapshot.editVersion &&
          disk.revision === purpose.currentRevision &&
          (purpose.currentRevision === null ? disk.missing === true : disk.missing !== true) &&
          !disk.truncated &&
          !disk.readOnly;
        if (accepted) {
          this.ambiguousIntent = null;
          this.publicationUncertain = false;
          this.verificationNeeded = false;
          this.reconciledGeneration = operation.generation;
          this.missingCreationHold = disk.missing === true;
          this.update({
            ...(disk.missing
              ? { currentMissing: true, conflict: null }
              : {
                  currentMissing: false,
                  baselineSource: disk.source,
                  baselineRevision: disk.revision,
                  conflict:
                    disk.source === this.snapshot.draftSource
                      ? null
                      : { externalSource: disk.source, externalRevision: disk.revision },
                }),
            attention: null,
            publicationOutcome: null,
            attentionMutationId: null,
            error: null,
          });
        } else this.publish();
        operation.request.resolve?.(accepted);
        return;
      }
      if (operation.request.purpose.type === "review") {
        if (this.readOperation?.id !== operation.id) {
          operation.request.review?.(null);
          return;
        }
        if (disk.publicationAttention && this.snapshot.publicationAttention === null)
          this.observePublicationAttention(disk.publicationAttention);
        const valid =
          this.readOperation?.id === operation.id &&
          this.externalUpdateHolds.size === 0 &&
          operation.externalUpdatesGeneration === this.externalUpdatesGeneration &&
          !disk.truncated &&
          !disk.readOnly &&
          (disk.publicationAttention == null ||
            disk.publicationAttention.recoveryId === operation.request.purpose.recoveryId);
        this.readOperation = null;
        operation.request.review?.(valid ? disk : null);
        this.publish();
        return;
      }
      if (disk.missing) throw new Error("Missing current files require explicit readonly review.");
      if (this.readOperation?.id !== operation.id) return;
      this.readOperation = null;
      if (
        this.externalUpdateHolds.size > 0 ||
        operation.externalUpdatesGeneration !== this.externalUpdatesGeneration
      ) {
        this.deferHeldRead(operation);
        return;
      }
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
      if (operation.request.purpose.type === "review") {
        operation.request.review?.(null);
        this.publish();
        return;
      }
      if (
        this.externalUpdateHolds.size > 0 ||
        operation.externalUpdatesGeneration !== this.externalUpdatesGeneration
      ) {
        this.deferHeldRead(operation);
        return;
      }
      if (
        operation.request.purpose.type === "retained" ||
        operation.request.purpose.type === "refusal"
      ) {
        operation.request.resolve?.(false);
        this.publish();
        return;
      }
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

  private async performRetainedRead(operation: ActiveRead): Promise<void> {
    const purpose = operation.request.purpose;
    if (purpose.type !== "retained") return;
    let initialAttention = this.snapshot.publicationAttention;
    const isCurrent = () =>
      !this.disposed &&
      this.connected &&
      this.readOperation?.id === operation.id &&
      this.externalUpdateHolds.size === 0 &&
      operation.externalUpdatesGeneration === this.externalUpdatesGeneration &&
      operation.generation === this.requestedGeneration &&
      this.snapshot.attention !== null &&
      this.snapshot.publicationAttention === initialAttention &&
      (initialAttention === null || initialAttention.recoveryId === purpose.recoveryId);
    const persist = this.io.persistAuthorizedCurrentReview;
    if (!isCurrent() || persist === undefined) {
      this.readOperation = null;
      operation.request.resolve?.(false);
      this.publish();
      return;
    }
    let authorized = this.snapshot.authorizedCurrentReview;
    if (authorized === null) {
      const disk = await (this.io.readForReview?.() ?? this.io.read());
      const attention = disk.publicationAttention ?? initialAttention;
      if (
        !isCurrent() ||
        purpose.editVersion !== this.snapshot.editVersion ||
        disk.readOnly ||
        disk.truncated ||
        disk.revision !== purpose.currentRevision ||
        (purpose.currentRevision === null ? disk.missing !== true : disk.missing === true) ||
        attention?.recoveryId !== purpose.recoveryId ||
        this.io.resolve === undefined
      ) {
        this.readOperation = null;
        operation.request.resolve?.(false);
        if (
          disk.publicationAttention &&
          disk.publicationAttention.recoveryId !== purpose.recoveryId
        )
          this.observePublicationAttention(disk.publicationAttention);
        else this.publish();
        return;
      }
      if (initialAttention === null && attention !== null) {
        initialAttention = attention;
        this.update({
          publicationAttention: attention,
          attention: "recovery_required",
          publicationOutcome: "retained-attention",
          attentionMutationId: attention.mutationId,
        });
      }
      const resolved = await this.io.resolve({
        recoveryId: purpose.recoveryId,
        currentRevision: purpose.currentRevision,
      });
      if (
        this.snapshot.publicationAttention !== initialAttention ||
        this.snapshot.attention === null ||
        resolved.revision !== purpose.currentRevision
      ) {
        this.readOperation = null;
        operation.request.resolve?.(false);
        this.publish();
        return;
      }
      authorized = { recoveryId: purpose.recoveryId, currentRevision: purpose.currentRevision };
      this.update({ authorizedCurrentReview: authorized });
    }
    if (
      authorized.recoveryId !== purpose.recoveryId ||
      authorized.currentRevision !== purpose.currentRevision
    ) {
      this.readOperation = null;
      operation.request.resolve?.(false);
      this.publish();
      return;
    }
    // Restored and failed admissions must re-prove journal ownership, but never
    // issue a second native resolution for the already authorized revision.
    await persist(this.snapshot);
    if (!isCurrent() || this.snapshot.authorizedCurrentReview !== authorized) {
      this.readOperation = null;
      operation.request.resolve?.(false);
      this.publish();
      return;
    }
    const verified = await (this.io.readForReview?.() ?? this.io.read());
    if (
      !isCurrent() ||
      verified.readOnly ||
      verified.truncated ||
      verified.publicationAttention != null ||
      verified.revision !== authorized.currentRevision ||
      (authorized.currentRevision === null ? verified.missing !== true : verified.missing === true)
    ) {
      this.readOperation = null;
      operation.request.resolve?.(false);
      if (verified.publicationAttention)
        this.observePublicationAttention(verified.publicationAttention);
      else this.publish();
      return;
    }
    let accepted: DocumentPersistenceSnapshot;
    do {
      const current = this.snapshot;
      accepted = {
        ...current,
        ...(verified.missing
          ? { currentMissing: true, conflict: null }
          : {
              currentMissing: false,
              baselineSource: verified.source,
              baselineRevision: verified.revision,
              conflict:
                verified.source === current.draftSource
                  ? null
                  : { externalSource: verified.source, externalRevision: verified.revision },
            }),
        authorizedCurrentReview: null,
        publicationSource: null,
        publicationIntent: null,
        attention: null,
        publicationAttention: null,
        publicationOutcome: null,
        attentionMutationId: null,
        error: null,
        pending: verified.missing === true || verified.source !== current.draftSource,
      };
      // Clear the phase and attention in the same strict journal transaction.
      // Typing during that transaction must also be durable before settlement.
      await persist(accepted);
      if (!isCurrent() || this.snapshot.authorizedCurrentReview !== authorized) {
        await persist(this.snapshot);
        this.readOperation = null;
        operation.request.resolve?.(false);
        this.publish();
        return;
      }
    } while (accepted.editVersion !== this.snapshot.editVersion);
    this.readOperation = null;
    this.ambiguousIntent = null;
    this.verificationNeeded = false;
    this.publicationUncertain = false;
    this.reconciledGeneration = operation.generation;
    this.missingCreationHold = verified.missing === true;
    this.update(accepted);
    operation.request.resolve?.(true);
  }

  private deferHeldRead(operation: ActiveRead): void {
    if (this.snapshot.attention !== null) {
      operation.request.resolve?.(false);
      this.publish();
      return;
    }
    this.verificationNeeded = true;
    this.readRequest ??= operation.request;
    if (this.readRequest !== operation.request) operation.request.resolve?.(false);
    this.publish();
    this.drive();
  }

  private acceptRead(disk: DocumentPersistenceReadResult, purpose: ReadPurpose): boolean {
    const current = this.snapshot;
    if (disk.publicationAttention) {
      this.observePublicationAttention(disk.publicationAttention);
      return false;
    }
    if (current.attention !== null) return false;
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
      this.missingCreationHold = false;
      this.update({
        conflict: { externalSource: disk.source, externalRevision: disk.revision },
        currentMissing: false,
        error: null,
      });
      return false;
    }
    if (purpose.type === "disk") {
      this.ambiguousIntent = null;
      this.verificationNeeded = false;
      this.missingCreationHold = false;
      this.update({
        recoverySource: current.draftSource,
        baselineSource: disk.source,
        baselineRevision: disk.revision,
        currentMissing: false,
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
      this.missingCreationHold = false;
      this.update({
        baselineSource: disk.source,
        baselineRevision: disk.revision,
        currentMissing: false,
        conflict: null,
        error: null,
      });
      return true;
    }
    const attempted = this.ambiguousIntent;
    if (this.publicationUncertain && attempted !== null) {
      // A read cannot identify the object published by an ambiguous operation.
      // Rejoin its durable receipt before acknowledging or creating a new intent.
      this.verificationNeeded = false;
      this.update({ error: null });
      return false;
    }
    if (current.currentMissing) {
      this.missingCreationHold = false;
      this.verificationNeeded = false;
      this.update({
        currentMissing: false,
        baselineSource: disk.source,
        baselineRevision: disk.revision,
        error: null,
        conflict:
          disk.source === current.draftSource
            ? null
            : { externalSource: disk.source, externalRevision: disk.revision },
      });
      return disk.source === current.draftSource;
    }
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
      const merged = this.reconcile(current.baselineSource, current.draftSource, disk.source);
      if (this.externalUpdateHolds.size > 0) {
        this.verificationNeeded = true;
        return false;
      }
      if (merged !== null) {
        const update: DocumentExternalUpdate<R> = {
          ...merged,
          previousSource: current.draftSource,
          editVersion: current.editVersion + 1,
        };
        try {
          const prepared = this.options.prepareExternalUpdate?.(update);
          if (
            this.externalUpdateHolds.size > 0 ||
            this.snapshot.editVersion !== current.editVersion
          ) {
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
            if (
              this.externalUpdateHolds.size > 0 ||
              this.snapshot.editVersion !== current.editVersion
            ) {
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
    if (this.externalUpdateHolds.size > 0) {
      this.verificationNeeded = true;
      return false;
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

  /** A strategy defect keeps the explicit conflict choices instead of failing the read. */
  private reconcile(baselineSource: string, draftSource: string, diskSource: string): R | null {
    try {
      return this.options.reconcile(baselineSource, draftSource, diskSource);
    } catch (error) {
      console.error("Document reconciliation failed:", error);
      return null;
    }
  }

  private classify(error: unknown): DocumentPersistenceFailureKind {
    if (error === this.disconnectedError) return "disconnected";
    try {
      return this.io.classifyFailure(error);
    } catch {
      return "terminal";
    }
  }

  private canRetry(kind: DocumentPersistenceFailureKind): boolean {
    const delays = this.options.retryDelaysMs ?? [250, 1_000, 3_000];
    return kind === "transient" && this.retryCount < delays.length;
  }

  private handleFailure(error: unknown, kind: DocumentPersistenceFailureKind): void {
    this.clearDebounce();
    if (
      kind === "recovery_required" ||
      kind === "target_changed" ||
      kind === "mutation_unavailable" ||
      kind === "mutation_intent_conflict" ||
      kind === "outcome_unknown" ||
      ((kind === "operation" || kind === "terminal") &&
        this.ambiguousIntent !== null &&
        this.publicationUncertain)
    ) {
      this.verificationNeeded = false;
      this.clearRetry();
      this.readRequest?.resolve?.(false);
      this.readRequest?.review?.(null);
      this.readRequest = null;
      this.update({
        attention: kind === "operation" || kind === "terminal" ? "outcome_unknown" : kind,
        error,
        publicationAttention:
          this.io.describeAttention?.(error, this.ambiguousIntent?.mutationId) ??
          this.snapshot.publicationAttention,
        publicationOutcome: this.snapshot.publicationAttention
          ? "retained-attention"
          : (this.io.describeOutcome?.(error) ?? null),
        attentionMutationId: this.ambiguousIntent?.mutationId ?? this.snapshot.attentionMutationId,
        authorizedCurrentReview: null,
      });
      return;
    }
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
