// @effect-diagnostics globalTimers:off -- Framework-neutral UI debounce lane; the caller injects all persistence effects.
// @effect-diagnostics globalConsole:off -- Report host notification defects without importing an Effect runtime into the framework-neutral queue.
import type { MarkdownSaveIntent } from "./session.ts";

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

type MarkdownSaveResolution =
  | { readonly action: "discard" }
  | { readonly action: "retry"; readonly expectedRevision?: string };

interface MarkdownSaveInFlight {
  readonly id: number;
  readonly intent: MarkdownSaveIntent;
  readonly promise: Promise<void>;
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

  retry(expectedRevision?: string): void {
    if (this.disposed) return;
    if (this.inFlight !== null) {
      this.deferredResolution = {
        action: "retry",
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      };
      return;
    }
    if (this.pendingIntent === null) return;
    if (expectedRevision !== undefined) {
      this.pendingIntent = { ...this.pendingIntent, expectedRevision };
    }
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
   * Retires a save after an authoritative file refresh has already observed
   * the queue's current draft. This is stronger than a timer: the project
   * read proves the bytes were published even if the command response was
   * interrupted or never settled in the renderer.
   */
  acknowledgePersisted(source: string): boolean {
    if (this.disposed) return false;
    const latestIntent = this.pendingIntent ?? this.inFlight?.intent;
    if (!latestIntent || latestIntent.source !== source) return false;
    this.clearTimer();
    this.pendingIntent = null;
    this.inFlight = null;
    this.deferredResolution = null;
    this.blocked = false;
    this.notifyCallback("onPendingChange", () => this.options.onPendingChange(false));
    return true;
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
    const promise = this.persist(intent, persistenceId).then((succeeded) => {
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
      if (resolution?.action === "retry") {
        if (
          !succeeded &&
          resolution.expectedRevision !== undefined &&
          this.pendingIntent !== null
        ) {
          this.pendingIntent = {
            ...this.pendingIntent,
            expectedRevision: resolution.expectedRevision,
          };
        }
        this.blocked = false;
      }
      if (this.blocked) return;
      if (this.pendingIntent !== null) {
        this.schedule(
          resolution?.action === "retry" || this.disposed ? 0 : this.options.debounceMs,
        );
      } else {
        this.notifyCallback("onPendingChange", () => this.options.onPendingChange(false));
      }
    });
    this.inFlight = { id: persistenceId, intent, promise };
  }

  private async persist(intent: MarkdownSaveIntent, persistenceId: number): Promise<boolean> {
    try {
      const result = await this.options.persist(intent);
      // An authoritative refresh may have retired this command while its
      // response was still pending. Its late result must not alter a newer
      // save lane or re-confirm an older revision.
      if (this.inFlight?.id !== persistenceId) return true;
      this.notifyCallback("onConfirmed", () => this.options.onConfirmed(intent, result));
      if (
        this.pendingIntent !== null &&
        this.pendingIntent.editVersion > intent.editVersion &&
        this.pendingIntent.expectedRevision === intent.expectedRevision
      ) {
        this.pendingIntent = { ...this.pendingIntent, expectedRevision: result.revision };
      }
      return true;
    } catch (error) {
      if (this.inFlight?.id !== persistenceId) return false;
      if (
        this.deferredResolution?.action !== "discard" &&
        (this.pendingIntent === null || intent.editVersion >= this.pendingIntent.editVersion)
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
      return false;
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
