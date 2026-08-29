// @effect-diagnostics globalTimers:off -- Framework-neutral UI debounce lane; the caller injects all persistence effects.
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

/**
 * Serial revision-aware save lane for one Markdown document. It coalesces
 * rapid edits, rebases a queued newer edit after an in-flight confirmation,
 * and stops after a failure until an explicit retry or discard.
 */
export class MarkdownSaveQueue<A extends MarkdownSaveResult = MarkdownSaveResult> {
  private readonly options: MarkdownSaveQueueOptions<A>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingIntent: MarkdownSaveIntent | null = null;
  private inFlight: Promise<void> | null = null;
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
    this.options.onPendingChange(true);
    if (!this.blocked && this.inFlight === null) this.schedule(this.options.debounceMs);
  }

  async flush(): Promise<void> {
    // Final flush (unmount or dispose) must always attempt the latest draft:
    // a paused queue would otherwise drop the user's edit silently.
    this.clearTimer();
    this.blocked = false;
    while (this.pendingIntent !== null || this.inFlight !== null) {
      if (this.inFlight !== null) {
        await this.inFlight;
        continue;
      }
      const stalled = this.pendingIntent;
      this.startPersist();
      if (this.blocked && this.inFlight === null && this.pendingIntent === stalled) break;
    }
  }

  retry(expectedRevision?: string): void {
    if (this.pendingIntent === null || this.disposed) return;
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
    if (this.inFlight === null) this.options.onPendingChange(false);
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
    this.inFlight = this.persist(intent).finally(() => {
      this.inFlight = null;
      if (this.blocked) return;
      if (this.pendingIntent !== null) {
        this.schedule(this.disposed ? 0 : this.options.debounceMs);
      } else {
        this.options.onPendingChange(false);
      }
    });
  }

  private async persist(intent: MarkdownSaveIntent): Promise<void> {
    try {
      const result = await this.options.persist(intent);
      this.options.onConfirmed(intent, result);
      if (
        this.pendingIntent !== null &&
        this.pendingIntent.editVersion > intent.editVersion &&
        this.pendingIntent.expectedRevision === intent.expectedRevision
      ) {
        this.pendingIntent = { ...this.pendingIntent, expectedRevision: result.revision };
      }
    } catch (error) {
      if (this.pendingIntent === null || intent.editVersion >= this.pendingIntent.editVersion) {
        this.pendingIntent = intent;
      }
      this.blocked = true;
      this.options.onFailure(intent, error);
    }
  }
}
