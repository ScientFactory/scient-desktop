// @effect-diagnostics globalTimers:off -- Framework-neutral UI debounce lane; the caller injects all persistence effects.
// @effect-diagnostics globalConsole:off -- Report host notification defects without importing an Effect runtime into the framework-neutral queue.
import type { MarkdownDocumentSession, MarkdownSaveIntent } from "./session.ts";

export interface MarkdownSaveResult {
  readonly revision: string;
}

export interface MarkdownSaveQueueOptions<A extends MarkdownSaveResult> {
  readonly debounceMs: number;
  readonly persist: (intent: MarkdownSaveIntent) => Promise<A>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onConfirmed: (intent: MarkdownSaveIntent, result: A) => void;
  readonly onFailure: (intent: MarkdownSaveIntent, error: unknown) => void;
}

type MarkdownSaveResolution = { readonly action: "discard" } | { readonly action: "resume" };

interface MarkdownSaveInFlight {
  readonly id: number;
  readonly intent: MarkdownSaveIntent;
  readonly promise: Promise<void>;
  readonly settle: () => void;
}

/**
 * Serial revision-aware save lane for one Markdown document. It coalesces
 * rapid edits, rebases a queued newer edit after an in-flight confirmation,
 * and stops after a failure until an explicit retry or discard.
 */
export class MarkdownSaveQueue<A extends MarkdownSaveResult = MarkdownSaveResult> {
  private readonly options: MarkdownSaveQueueOptions<A>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingIntent: MarkdownSaveIntent | null = null;
  private inFlight: MarkdownSaveInFlight | null = null;
  private deferredResolution: MarkdownSaveResolution | null = null;
  private nextPersistenceId = 1;
  private blocked = false;
  private disposed = false;

  constructor(options: MarkdownSaveQueueOptions<A>) {
    this.options = options;
  }

  get pending(): boolean {
    return this.pendingIntent !== null || this.inFlight !== null;
  }

  get failureBlocked(): boolean {
    return this.blocked;
  }

  /** Synchronize every draft transition, including undo-to-baseline and conflict edits. */
  synchronize(session: MarkdownDocumentSession): void {
    if (this.disposed) return;
    const needsWrite = session.draftSource !== session.baselineSource;
    const needsCompensation =
      this.inFlight !== null && this.inFlight.intent.source !== session.draftSource;
    this.pendingIntent =
      (needsWrite || needsCompensation) && this.inFlight?.intent.source !== session.draftSource
        ? {
            source: session.draftSource,
            expectedRevision: session.baselineRevision,
            editVersion: session.editVersion,
          }
        : null;
    if (session.conflict !== null) this.pause();
    if (this.pendingIntent === null) {
      this.clearTimer();
      if (this.inFlight === null) this.blocked = false;
    } else if (!this.blocked && this.inFlight === null) {
      this.schedule(this.options.debounceMs);
    }
    this.notifyCallback("onPendingChange", () => this.options.onPendingChange(this.pending));
  }

  enqueue(intent: MarkdownSaveIntent): void {
    if (this.disposed) throw new Error("Cannot enqueue a disposed Markdown save queue.");
    if (this.pendingIntent && intent.editVersion <= this.pendingIntent.editVersion) {
      // Same edit rebased against a newer observed revision (unchanged-bytes
      // external refresh): adopt the fresh expected revision so the queued
      // write does not dead-end on a stale compare-and-swap.
      if (intent.editVersion === this.pendingIntent.editVersion) this.pendingIntent = intent;
      return;
    }
    this.pendingIntent = intent;
    this.notifyCallback("onPendingChange", () => this.options.onPendingChange(true));
    if (!this.blocked && this.inFlight === null) this.schedule(this.options.debounceMs);
  }

  async flush(): Promise<void> {
    // Final flush (unmount or dispose) must always attempt the latest draft:
    // a paused queue would otherwise drop the user's edit silently.
    this.clearTimer();
    this.blocked = false;
    while (this.pendingIntent !== null || this.inFlight !== null) {
      if (this.inFlight !== null) {
        await this.inFlight.promise;
        continue;
      }
      const stalled = this.pendingIntent;
      this.startPersist();
      if (this.blocked && this.inFlight === null && this.pendingIntent === stalled) break;
    }
  }

  /** Resume a blocked lane after its owning session has supplied a rebased intent. */
  resume(): void {
    if (this.disposed) return;
    if (this.inFlight !== null) {
      this.deferredResolution = { action: "resume" };
      return;
    }
    if (this.pendingIntent === null) return;
    this.blocked = false;
    if (this.inFlight === null) this.schedule(0);
  }

  pause(): void {
    this.clearTimer();
    this.blocked = true;
  }

  discard(): void {
    this.clearTimer();
    this.pendingIntent = null;
    this.blocked = false;
    if (this.inFlight !== null) {
      this.deferredResolution = { action: "discard" };
      return;
    }
    this.notifyCallback("onPendingChange", () => this.options.onPendingChange(false));
  }

  /**
   * Retires a known save intent after an authoritative file refresh observes
   * its bytes. This is stronger than a timer: the project read proves those
   * bytes were published even if the command response was interrupted or
   * never settled in the renderer.
   */
  acknowledgePublished(source: string, expectedRevision: string): MarkdownSaveIntent | null {
    if (this.disposed || this.deferredResolution !== null) return null;
    const intent = this.inFlight?.intent ?? this.pendingIntent;
    if (
      intent === null ||
      intent.source !== source ||
      intent.expectedRevision !== expectedRevision
    ) {
      return null;
    }
    // Never retire a compensating draft merely because it matches the old
    // disk bytes while a different write can still publish afterward.
    if (this.inFlight !== null) {
      this.inFlight.settle();
      this.inFlight = null;
    } else {
      this.pendingIntent = null;
    }
    this.clearTimer();
    this.blocked = false;
    this.notifyCallback("onPendingChange", () => this.options.onPendingChange(this.pending));
    return intent;
  }

  async dispose(options: { readonly flush?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    if (options.flush ?? true) await this.flush();
    this.disposed = true;
    this.clearTimer();
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.startPersist();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private startPersist(): void {
    if (this.blocked || this.inFlight !== null || this.pendingIntent === null) return;
    const intent = this.pendingIntent;
    this.pendingIntent = null;
    const persistenceId = this.nextPersistenceId;
    this.nextPersistenceId += 1;
    let settle!: () => void;
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.inFlight = { id: persistenceId, intent, promise, settle };
    void this.persist(intent, persistenceId)
      .then(() => {
        if (this.inFlight?.id !== persistenceId) return;
        this.inFlight = null;
        const resolution = this.deferredResolution;
        this.deferredResolution = null;
        if (resolution?.action === "discard") {
          this.pendingIntent = null;
          this.blocked = false;
          this.notifyCallback("onPendingChange", () => this.options.onPendingChange(false));
          return;
        }
        if (resolution?.action === "resume") {
          this.blocked = false;
        }
        if (this.blocked) return;
        if (this.pendingIntent !== null) {
          this.schedule(
            resolution?.action === "resume" || this.disposed ? 0 : this.options.debounceMs,
          );
        } else {
          this.notifyCallback("onPendingChange", () => this.options.onPendingChange(false));
        }
      })
      .finally(settle);
  }

  private async persist(intent: MarkdownSaveIntent, persistenceId: number): Promise<void> {
    try {
      const result = await this.options.persist(intent);
      // An authoritative refresh may have retired this command while its
      // response was still pending. Its late result must not alter a newer
      // save lane or re-confirm an older revision.
      if (this.inFlight?.id !== persistenceId) return;
      this.notifyCallback("onConfirmed", () => this.options.onConfirmed(intent, result));
      if (
        this.pendingIntent !== null &&
        this.pendingIntent.editVersion > intent.editVersion &&
        this.pendingIntent.expectedRevision === intent.expectedRevision
      ) {
        this.pendingIntent = { ...this.pendingIntent, expectedRevision: result.revision };
      }
    } catch (error) {
      if (this.inFlight?.id !== persistenceId) return;
      if (
        this.deferredResolution?.action !== "discard" &&
        (this.pendingIntent === null || intent.editVersion > this.pendingIntent.editVersion)
      ) {
        this.pendingIntent = intent;
      }
      this.blocked = true;
      // A resolution chosen while this write was running supersedes its
      // failure. Applying it after settlement avoids reopening a conflict the
      // user has already resolved or leaving the retry lane paused.
      if (this.deferredResolution === null) {
        this.notifyCallback("onFailure", () => this.options.onFailure(intent, error));
      }
    }
  }

  private notifyCallback(name: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      // Host callbacks are notifications, not persistence. A rendering or
      // cache callback must never strand the serial lane after a completed
      // write.
      console.error(`MarkdownSaveQueue ${name} callback failed:`, error);
    }
  }
}
