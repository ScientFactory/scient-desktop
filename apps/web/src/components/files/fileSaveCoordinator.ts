import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

type AtomCommandFailure<A, E> = Extract<AtomCommandResult<A, E>, { readonly _tag: "Failure" }>;

export interface FileSaveCoordinatorOptions<A, E> {
  readonly debounceMs: number;
  readonly initialRevision: string;
  readonly persist: (
    contents: string,
    expectedRevision: string,
  ) => Promise<AtomCommandResult<A, E>>;
  readonly revisionFromResult: (value: A) => string;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onConfirmed: (contents: string, value: A) => void;
  readonly onFailure?: (contents: string, result: AtomCommandFailure<A, E>) => void;
  readonly onResolutionApplied?: (action: FileSaveResolutionAction) => void;
}

export type FileSaveResolutionAction = "discard" | "retry";

type PendingResolution =
  | { readonly _tag: "discard"; readonly revision: string }
  | { readonly _tag: "retry"; readonly revision: string };

export class FileSaveCoordinator<A = unknown, E = unknown> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private latestRevision = 0;
  private confirmedEditRevision = 0;
  private lastChangeAt = 0;
  private saving = false;
  private suspended = false;
  private disposed = false;
  private pendingResolution: PendingResolution | null = null;
  private activePersist: Promise<void> | null = null;
  private debounceMs: number;
  private confirmedFileRevision: string;

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {
    this.debounceMs = options.debounceMs;
    this.confirmedFileRevision = options.initialRevision;
  }

  change(contents: string, debounceMs = this.debounceMs): void {
    if (this.disposed) return;
    this.debounceMs = debounceMs;
    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
    if (!this.suspended) this.schedule(this.debounceMs);
  }

  get hasPendingChanges(): boolean {
    return this.latestRevision > this.confirmedEditRevision;
  }

  /**
   * Hold persistence while a higher-level edit transaction is incomplete.
   * The latest buffer remains pending and a final release or disposal still
   * flushes it.
   */
  setSuspended(suspended: boolean): void {
    if (this.disposed || this.suspended === suspended) return;
    this.suspended = suspended;
    if (suspended) {
      this.clearTimer();
      return;
    }
    if (!this.hasPendingChanges || this.saving) return;
    this.schedule(Math.max(0, this.debounceMs - (Date.now() - this.lastChangeAt)));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    void this.flush();
  }

  /**
   * Attempt to persist the newest accepted buffer immediately. The result is
   * `false` when persistence failed and the buffer must remain recoverable.
   */
  async flush(): Promise<boolean> {
    this.clearTimer();
    if (this.activePersist !== null) {
      const active = this.activePersist;
      await active;
      if (this.activePersist === active) this.activePersist = null;
    }
    if (!this.hasPendingChanges) return true;
    await this.startPersist(true);
    return !this.hasPendingChanges;
  }

  syncConfirmedFileRevision(revision: string): void {
    if (!this.saving && this.latestRevision === this.confirmedEditRevision) {
      this.confirmedFileRevision = revision;
    }
  }

  /** Discard the unsaved buffer and adopt the authoritative on-disk revision. */
  discardPending(revision: string): void {
    this.resolvePending({ _tag: "discard", revision });
  }

  /**
   * Explicitly retry the local buffer against a newly read disk revision.
   * The compare-and-swap write still rejects a third concurrent change.
   */
  retryPending(revision: string): void {
    this.resolvePending({ _tag: "retry", revision });
  }

  private resolvePending(resolution: PendingResolution): void {
    this.clearTimer();
    if (this.saving) {
      this.pendingResolution = resolution;
      return;
    }
    this.applyResolution(resolution);
  }

  private applyResolution(resolution: PendingResolution): void {
    this.confirmedFileRevision = resolution.revision;
    if (resolution._tag === "discard") {
      this.confirmedEditRevision = this.latestRevision;
      this.options.onPendingChange(false);
      this.options.onResolutionApplied?.(resolution._tag);
      return;
    }
    this.schedule(0);
    this.options.onResolutionApplied?.(resolution._tag);
  }

  private schedule(delay: number): void {
    this.clearTimer();
    if (this.suspended && !this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.startPersist(false);
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private startPersist(force: boolean): Promise<void> {
    if (this.activePersist !== null) return this.activePersist;
    if (!this.hasPendingChanges || (this.suspended && !this.disposed && !force)) {
      return Promise.resolve();
    }
    const operation = this.persistLatest(force);
    this.activePersist = operation;
    void operation.finally(() => {
      if (this.activePersist === operation) this.activePersist = null;
    });
    return operation;
  }

  private async persistLatest(force: boolean): Promise<void> {
    if (this.saving || !this.hasPendingChanges || (this.suspended && !this.disposed && !force))
      return;

    this.saving = true;
    const contents = this.latestContents;
    const revision = this.latestRevision;
    const result = await this.options.persist(contents, this.confirmedFileRevision);
    const succeeded = result._tag === "Success";
    if (result._tag === "Success") {
      this.confirmedFileRevision = this.options.revisionFromResult(result.value);
      this.confirmedEditRevision = revision;
      this.options.onConfirmed(contents, result.value);
    } else {
      this.options.onFailure?.(contents, result);
    }

    this.saving = false;
    if (this.pendingResolution !== null) {
      const resolution = this.pendingResolution;
      this.pendingResolution = null;
      this.applyResolution(resolution);
      return;
    }
    if (revision === this.latestRevision) {
      if (succeeded) this.options.onPendingChange(false);
      return;
    }

    const remainingDebounce = Math.max(0, this.debounceMs - (Date.now() - this.lastChangeAt));
    if (this.disposed) {
      await this.persistLatest(true);
    } else {
      this.schedule(remainingDebounce);
    }
  }
}
