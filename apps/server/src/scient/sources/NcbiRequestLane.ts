// @effect-diagnostics nodeBuiltinImport:off -- NCBI requests need a shared, bounded timer lane.
import * as NodeTimersPromises from "node:timers/promises";

interface SerialRequestLaneOptions {
  readonly minimumStartIntervalMs: number;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export function createSerialRequestLane(options: SerialRequestLaneOptions) {
  const now = options.now ?? Date.now;
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      NodeTimersPromises.setTimeout(milliseconds, undefined, { ref: false }));
  let nextRequestAt = 0;
  let lane: Promise<void> = Promise.resolve();

  return async function runInLane<A>(run: () => Promise<A>): Promise<A> {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = lane;
    lane = previous.catch(() => undefined).then(() => gate);
    await previous.catch(() => undefined);

    try {
      const waitMs = Math.max(0, nextRequestAt - now());
      if (waitMs > 0) await wait(waitMs);
      nextRequestAt = now() + options.minimumStartIntervalMs;
      return await run();
    } finally {
      release?.();
    }
  };
}

export const runWithNcbiRequestLimit = createSerialRequestLane({
  minimumStartIntervalMs: 350,
});
