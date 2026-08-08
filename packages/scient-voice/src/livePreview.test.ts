import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_LIVE_PREVIEW_INITIAL_DELAY_MS,
  LiveVoicePreviewSession,
  type LivePreviewTimers,
  type LiveVoiceSnapshot,
} from "./livePreview.ts";

// Flush the microtask queue a few times so promise chains between a fired timer
// and the next scheduled timer settle before we inspect state.
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

interface FakeClock {
  readonly timers: LivePreviewTimers;
  advance: (ms: number) => Promise<void>;
}

// Deterministic virtual clock: `setTimeout` records tasks, `advance` fires the
// due ones in chronological order and flushes microtasks after each so the loop
// can schedule its next timer within the same advance.
function createFakeClock(): FakeClock {
  let time = 0;
  let seq = 0;
  const tasks = new Map<number, { at: number; run: () => void }>();

  const now = (): number => time;
  const setTimeoutImpl = ((handler: () => void, ms?: number): number => {
    seq += 1;
    tasks.set(seq, { at: time + Math.max(0, ms ?? 0), run: handler });
    return seq;
  }) as unknown as typeof setTimeout;
  const clearTimeoutImpl = ((id?: number): void => {
    if (typeof id === "number") {
      tasks.delete(id);
    }
  }) as unknown as typeof clearTimeout;

  async function advance(ms: number): Promise<void> {
    const target = time + ms;
    for (;;) {
      let dueId: number | undefined;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, task] of tasks) {
        if (task.at <= target && task.at < dueAt) {
          dueAt = task.at;
          dueId = id;
        }
      }
      if (dueId === undefined) {
        break;
      }
      const task = tasks.get(dueId);
      tasks.delete(dueId);
      time = dueAt;
      task?.run();
      await flushMicrotasks();
    }
    time = target;
  }

  return { timers: { setTimeout: setTimeoutImpl, clearTimeout: clearTimeoutImpl, now }, advance };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("LiveVoicePreviewSession", () => {
  it("takes the first snapshot only after the initial delay", async () => {
    const clock = createFakeClock();
    const session = new LiveVoicePreviewSession();
    let calls = 0;

    session.start({
      timers: clock.timers,
      getRecordingDurationMs: () => 5_000,
      transcribeSnapshot: async () => {
        calls += 1;
        return null;
      },
      onPreview: () => undefined,
    });
    await flushMicrotasks();

    await clock.advance(DEFAULT_LIVE_PREVIEW_INITIAL_DELAY_MS - 1);
    expect(calls).toBe(0);

    await clock.advance(1);
    expect(calls).toBe(1);

    await session.stop();
  });

  it("forwards the full provisional text to onPreview (replace, not append)", async () => {
    const clock = createFakeClock();
    const session = new LiveVoicePreviewSession();
    const previews: string[] = [];
    const texts = ["hello", "hello world", "hello world again"];
    let index = 0;

    session.start({
      timers: clock.timers,
      getRecordingDurationMs: () => 5_000,
      transcribeSnapshot: async () => {
        const text = texts[Math.min(index, texts.length - 1)] ?? "";
        index += 1;
        return { text, durationMs: 5_000 };
      },
      onPreview: (text) => previews.push(text),
    });
    await flushMicrotasks();

    // First snapshot after the initial delay, then two more at the base interval.
    await clock.advance(DEFAULT_LIVE_PREVIEW_INITIAL_DELAY_MS);
    await clock.advance(2_500);
    await clock.advance(2_500);

    expect(previews).toStrictEqual(texts);

    await session.stop();
  });

  it("never overlaps snapshots: a slow snapshot delays the next one", async () => {
    const clock = createFakeClock();
    const session = new LiveVoicePreviewSession();
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const pending = deferred<LiveVoiceSnapshot | null>();

    session.start({
      timers: clock.timers,
      getRecordingDurationMs: () => 5_000,
      transcribeSnapshot: async () => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await pending.promise;
        } finally {
          inFlight -= 1;
        }
      },
      onPreview: () => undefined,
    });
    await flushMicrotasks();

    // First snapshot starts and stays in flight.
    await clock.advance(DEFAULT_LIVE_PREVIEW_INITIAL_DELAY_MS);
    expect(calls).toBe(1);

    // Advancing well past the interval must NOT start a second snapshot while
    // the first is still running.
    await clock.advance(60_000);
    expect(calls).toBe(1);
    expect(maxInFlight).toBe(1);

    // Once it resolves, the loop schedules and fires the next snapshot.
    pending.resolve({ text: "done", durationMs: 5_000 });
    await flushMicrotasks();
    await clock.advance(2_500);
    expect(calls).toBe(2);
    expect(maxInFlight).toBe(1);

    await session.stop();
  });

  it("grows the backoff with the snapshot duration", async () => {
    const clock = createFakeClock();
    const session = new LiveVoicePreviewSession();
    let calls = 0;
    // durationMs -> adaptive delay = min(8000, max(2500, durationMs / 6)):
    //   18000 / 6 = 3000; 60000 / 6 = 10000 -> capped at 8000.
    const durations = [18_000, 60_000, 60_000];

    session.start({
      timers: clock.timers,
      getRecordingDurationMs: () => 5_000,
      transcribeSnapshot: async () => {
        const durationMs = durations[Math.min(calls, durations.length - 1)] ?? 0;
        calls += 1;
        return { text: `t${String(calls)}`, durationMs };
      },
      onPreview: () => undefined,
    });
    await flushMicrotasks();

    await clock.advance(DEFAULT_LIVE_PREVIEW_INITIAL_DELAY_MS);
    expect(calls).toBe(1);

    // Next delay is 3000 (from an 18s clip).
    await clock.advance(2_999);
    expect(calls).toBe(1);
    await clock.advance(1);
    expect(calls).toBe(2);

    // Next delay is capped at 8000 (from a 60s clip).
    await clock.advance(7_999);
    expect(calls).toBe(2);
    await clock.advance(1);
    expect(calls).toBe(3);

    await session.stop();
  });

  it("stops taking snapshots once the recording passes the max duration", async () => {
    const clock = createFakeClock();
    const session = new LiveVoicePreviewSession();
    let calls = 0;
    let recordingMs = 5_000;

    session.start({
      timers: clock.timers,
      getRecordingDurationMs: () => recordingMs,
      transcribeSnapshot: async () => {
        calls += 1;
        // After the first snapshot the recording crosses the 30s cap.
        recordingMs = 31_000;
        return { text: "x", durationMs: 12_000 };
      },
      onPreview: () => undefined,
    });
    await flushMicrotasks();

    await clock.advance(DEFAULT_LIVE_PREVIEW_INITIAL_DELAY_MS);
    expect(calls).toBe(1);

    // The next wake sees duration >= max and stops without erroring or snapshotting.
    await clock.advance(60_000);
    expect(calls).toBe(1);

    // The loop has already ended, so stop() resolves immediately.
    await session.stop();
  });

  it("stop() aborts a pending delay and resolves without a snapshot", async () => {
    const clock = createFakeClock();
    const session = new LiveVoicePreviewSession();
    let calls = 0;

    session.start({
      timers: clock.timers,
      getRecordingDurationMs: () => 5_000,
      transcribeSnapshot: async () => {
        calls += 1;
        return null;
      },
      onPreview: () => undefined,
    });
    await flushMicrotasks();

    // Still inside the initial delay wait.
    await clock.advance(DEFAULT_LIVE_PREVIEW_INITIAL_DELAY_MS - 100);
    expect(calls).toBe(0);

    await session.stop();
    expect(calls).toBe(0);

    // Advancing past when the delay would have fired confirms it was cleared.
    await clock.advance(10_000);
    expect(calls).toBe(0);
  });

  it("stop() aborts a mid-flight snapshot (signal.aborted true) and resolves", async () => {
    const clock = createFakeClock();
    const session = new LiveVoicePreviewSession();
    let capturedSignal: AbortSignal | undefined;

    session.start({
      timers: clock.timers,
      getRecordingDurationMs: () => 5_000,
      transcribeSnapshot: (signal) => {
        capturedSignal = signal;
        // Abort-aware snapshot: resolves as soon as the session aborts.
        return new Promise<LiveVoiceSnapshot | null>((resolve) => {
          signal.addEventListener("abort", () => resolve(null), { once: true });
        });
      },
      onPreview: () => undefined,
    });
    await flushMicrotasks();

    await clock.advance(DEFAULT_LIVE_PREVIEW_INITIAL_DELAY_MS);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    await session.stop();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("an error in a snapshot stops the loop and calls onError", async () => {
    const clock = createFakeClock();
    const session = new LiveVoicePreviewSession();
    const boom = new Error("snapshot failed");
    const errors: unknown[] = [];
    let calls = 0;

    session.start({
      timers: clock.timers,
      getRecordingDurationMs: () => 5_000,
      transcribeSnapshot: async () => {
        calls += 1;
        throw boom;
      },
      onPreview: () => undefined,
      onError: (error) => errors.push(error),
    });
    await flushMicrotasks();

    await clock.advance(DEFAULT_LIVE_PREVIEW_INITIAL_DELAY_MS);
    expect(calls).toBe(1);
    expect(errors).toStrictEqual([boom]);

    // Loop stopped: no further snapshots even after a long advance.
    await clock.advance(60_000);
    expect(calls).toBe(1);

    await session.stop();
  });

  it("stop() is safe when the session was never started", async () => {
    const session = new LiveVoicePreviewSession();
    await session.stop();
  });

  it("start() throws when a session is already running", async () => {
    const clock = createFakeClock();
    const session = new LiveVoicePreviewSession();
    const options = {
      timers: clock.timers,
      getRecordingDurationMs: () => 5_000,
      transcribeSnapshot: async () => null,
      onPreview: () => undefined,
    };
    session.start(options);
    expect(() => session.start(options)).toThrow(/already running/u);
    await session.stop();
  });
});
