function untilReleased(done: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const canceled = Promise.withResolvers<never>();
  const cancel = () => canceled.reject(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  return Promise.race([done, canceled.promise]).finally(() =>
    signal.removeEventListener("abort", cancel),
  );
}

/** Dictation takes precedence over the next recording window. */
export class WindowPriority {
  private readonly schedule: (expire: () => void) => () => void;

  constructor(schedule: (expire: () => void) => () => void) {
    this.schedule = schedule;
  }

  private dictations = new Set<Promise<void>>();
  private window: { controller: AbortController; done: Promise<void> } | undefined;
  private waitingSince = new Map<Promise<void>, number>();

  waiting(now: number): boolean {
    return Array.from(this.waitingSince.values()).some((since) => now - since >= 2000);
  }

  async dictate<A>(
    now: number,
    signal: AbortSignal,
    run: (admitted: () => void) => Promise<A>,
  ): Promise<A> {
    signal.throwIfAborted();
    const gate = Promise.withResolvers<void>();
    const ahead = [...this.dictations];
    this.dictations.add(gate.promise);
    this.waitingSince.set(gate.promise, now);
    const cancelDeadline = this.schedule(() => this.window?.controller.abort());
    const admitted = () => {
      cancelDeadline();
      this.waitingSince.delete(gate.promise);
    };
    signal.addEventListener("abort", admitted, { once: true });
    try {
      await untilReleased(Promise.all([...ahead, this.window?.done]), signal);
      signal.throwIfAborted();
      return await run(admitted);
    } finally {
      signal.removeEventListener("abort", admitted);
      admitted();
      this.dictations.delete(gate.promise);
      gate.resolve();
    }
  }

  async recognize<A>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<A>): Promise<A> {
    for (;;) {
      signal.throwIfAborted();
      if (this.dictations.size) {
        await untilReleased(Promise.all(this.dictations), signal);
        continue;
      }
      if (this.window) {
        await untilReleased(this.window.done, signal);
        continue;
      }
      const controller = new AbortController();
      const gate = Promise.withResolvers<void>();
      this.window = { controller, done: gate.promise };
      try {
        const attempt = AbortSignal.any([signal, controller.signal]);
        const result = await run(attempt);
        attempt.throwIfAborted();
        return result;
      } catch (error) {
        if (!controller.signal.aborted || signal.aborted) throw error;
      } finally {
        this.window = undefined;
        gate.resolve();
      }
    }
  }
}
