// FILE: connectionSupervisor.test.ts
// Purpose: Locks single-owner connection retry, generation, and wake-probe behavior.
// Layer: Web transport lifecycle tests
// Depends on: ConnectionSupervisor and deterministic timers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionSupervisor, type ConnectionSupervisorSession } from "./connectionSupervisor";

interface TestSession {
  readonly id: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function makeHarness(
  connect: (generation: number, signal: AbortSignal) => Promise<TestSession> = async (
    generation,
  ) => ({
    id: generation,
  }),
  timing?: { readonly retryResetAfterMs?: number },
) {
  const closed: Array<ConnectionSupervisorSession<TestSession>> = [];
  const ready: Array<ConnectionSupervisorSession<TestSession>> = [];
  const retries: Array<{ attempt: number; delayMs: number; reason: string }> = [];
  const probe = vi.fn(async () => undefined);
  const supervisor = new ConnectionSupervisor<TestSession>({
    connect,
    close: (session) => {
      closed.push(session);
    },
    probe,
    random: () => 0.5,
    ...timing,
    onReady: (session) => ready.push(session),
    onRetryScheduled: (retry) => retries.push(retry),
  });
  return { closed, probe, ready, retries, supervisor };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ConnectionSupervisor", () => {
  it("shares one validated generation across concurrent waiters", async () => {
    const first = deferred<TestSession>();
    const connect = vi.fn(() => first.promise);
    const harness = makeHarness(connect);

    const left = harness.supervisor.waitForSession();
    const right = harness.supervisor.waitForSession();
    expect(connect).toHaveBeenCalledOnce();

    first.resolve({ id: 10 });

    await expect(left).resolves.toEqual({ generation: 1, value: { id: 10 } });
    await expect(right).resolves.toEqual({ generation: 1, value: { id: 10 } });
    expect(harness.ready).toHaveLength(1);
    expect(harness.supervisor.snapshot.phase).toBe("ready");
  });

  it("backs off 1, 2, 4, 8, and 16 seconds with one retry owner", async () => {
    const connect = vi.fn(async () => {
      throw new Error("offline");
    });
    const harness = makeHarness(connect);

    harness.supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    expect(harness.retries.map(({ delayMs }) => delayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
    expect(connect).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(1);
    harness.supervisor.dispose();
  });

  it("never lets positive jitter exceed the configured retry ceiling", async () => {
    const supervisor = new ConnectionSupervisor<TestSession>({
      connect: async () => {
        throw new Error("offline");
      },
      close: () => undefined,
      probe: async () => undefined,
      random: () => 1,
      retryBaseDelayMs: 16_000,
      retryJitterRatio: 0.2,
      retryMaxDelayMs: 16_000,
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(supervisor.snapshot.retryDelayMs).toBe(16_000);
    supervisor.dispose();
  });

  it("keeps escalating across short-lived ready connections", async () => {
    const harness = makeHarness();
    const first = await harness.supervisor.waitForSession();

    harness.supervisor.invalidate(first.generation, "first short-lived socket");
    await vi.advanceTimersByTimeAsync(1_000);
    const second = await harness.supervisor.waitForSession();
    harness.supervisor.invalidate(second.generation, "second short-lived socket");

    expect(harness.retries.map(({ delayMs }) => delayMs)).toEqual([1_000, 2_000]);
  });

  it("forgives earlier failures after the injectable stable-readiness window", async () => {
    const harness = makeHarness(undefined, { retryResetAfterMs: 25 });
    const first = await harness.supervisor.waitForSession();

    harness.supervisor.invalidate(first.generation, "brief outage");
    await vi.advanceTimersByTimeAsync(1_000);
    const stable = await harness.supervisor.waitForSession();
    await vi.advanceTimersByTimeAsync(25);
    harness.supervisor.invalidate(stable.generation, "later outage");

    expect(harness.retries.map(({ delayMs }) => delayMs)).toEqual([1_000, 1_000]);
  });

  it("times out a wedged connect and closes its late result", async () => {
    const pending = deferred<TestSession>();
    let connectSignal: AbortSignal | undefined;
    const harness = makeHarness((_generation, signal) => {
      connectSignal = signal;
      return pending.promise;
    });

    harness.supervisor.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(harness.retries).toEqual([
      {
        attempt: 0,
        delayMs: 1_000,
        reason: "Connection generation 1 timed out after 15000ms",
      },
    ]);
    expect(connectSignal?.aborted).toBe(true);

    pending.resolve({ id: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.closed).toContainEqual({ generation: 1, value: { id: 1 } });
  });

  it("bounds the whole replacement attempt while old-session cleanup is still pending", async () => {
    const closeFinished = deferred<void>();
    const connect = vi.fn(async (generation: number) => ({ id: generation }));
    const retries: Array<{ attempt: number; delayMs: number; reason: string }> = [];
    const supervisor = new ConnectionSupervisor<TestSession>({
      connect,
      close: () => closeFinished.promise,
      closeTimeoutMs: 5_000,
      connectTimeoutMs: 250,
      probe: async () => undefined,
      random: () => 0.5,
      onRetryScheduled: (retry) => retries.push(retry),
    });
    const first = await supervisor.waitForSession();

    supervisor.invalidate(first.generation, "replace");
    await vi.advanceTimersByTimeAsync(1_250);

    expect(connect).toHaveBeenCalledOnce();
    expect(retries.at(-1)).toMatchObject({
      delayMs: 2_000,
      reason: "Connection generation 2 timed out after 250ms",
    });
    supervisor.dispose();
    closeFinished.resolve();
  });

  it("settles a caller waiting on an unavailable connection without stopping recovery", async () => {
    const neverConnects = deferred<TestSession>();
    const harness = makeHarness(() => neverConnects.promise);
    const waiting = harness.supervisor.waitForSession({ timeoutMs: 250 });
    const rejection = expect(waiting).rejects.toThrow("Connection unavailable after 250ms");

    await vi.advanceTimersByTimeAsync(250);

    await rejection;
    expect(harness.supervisor.snapshot.phase).toBe("connecting");
    harness.supervisor.dispose();
    neverConnects.resolve({ id: 1 });
  });

  it("ignores stale failures after a replacement generation becomes ready", async () => {
    const harness = makeHarness();
    const first = await harness.supervisor.waitForSession();

    expect(harness.supervisor.invalidate(first.generation, "socket closed")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    const second = await harness.supervisor.waitForSession();

    expect(second.generation).toBe(2);
    expect(harness.supervisor.invalidate(first.generation, "late stream exit")).toBe(false);
    expect(harness.supervisor.currentSession).toEqual(second);
    expect(harness.retries).toHaveLength(1);
  });

  it("waits for the old session to close before opening its replacement", async () => {
    const closeFinished = deferred<void>();
    const connect = vi.fn(async (generation: number) => ({ id: generation }));
    const supervisor = new ConnectionSupervisor<TestSession>({
      connect,
      close: () => closeFinished.promise,
      probe: async () => undefined,
      random: () => 0.5,
    });
    const first = await supervisor.waitForSession();

    supervisor.invalidate(first.generation, "socket closed");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledOnce();

    closeFinished.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const second = await supervisor.waitForSession();
    expect(second.generation).toBe(2);
    expect(connect).toHaveBeenCalledTimes(2);
    supervisor.dispose();
  });

  it("recovers after bounded teardown when an old session never disposes", async () => {
    const neverCloses = deferred<void>();
    const onError = vi.fn();
    const connect = vi.fn(async (generation: number) => ({ id: generation }));
    const supervisor = new ConnectionSupervisor<TestSession>({
      connect,
      close: () => neverCloses.promise,
      closeTimeoutMs: 250,
      probe: async () => undefined,
      random: () => 0.5,
      onError,
    });
    const first = await supervisor.waitForSession();

    supervisor.invalidate(first.generation, "socket closed");
    await vi.advanceTimersByTimeAsync(249);
    expect(connect).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(751);
    const second = await supervisor.waitForSession();
    expect(second.generation).toBe(2);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("disposal timed out") }),
      "generation 1 invalidation",
    );

    supervisor.dispose();
    neverCloses.resolve();
  });

  it("probes a ready session and reconnects when the probe fails", async () => {
    const harness = makeHarness();
    const first = await harness.supervisor.waitForSession();
    harness.probe.mockRejectedValueOnce(new Error("stale socket"));

    await harness.supervisor.probe("resume");

    expect(harness.closed).toEqual([first]);
    expect(harness.supervisor.snapshot).toMatchObject({
      phase: "reconnecting",
      retryDelayMs: 1_000,
    });
    await harness.supervisor.probe("window focus");
    const second = await harness.supervisor.waitForSession();
    expect(second.generation).toBe(2);
  });

  it("does not let an old generation's probe suppress probing its replacement", async () => {
    const harness = makeHarness();
    const first = await harness.supervisor.waitForSession();
    const oldProbe = deferred<undefined>();
    harness.probe.mockImplementationOnce(() => oldProbe.promise).mockResolvedValueOnce(undefined);

    const firstProbe = harness.supervisor.probe("first focus");
    harness.supervisor.invalidate(first.generation, "stream closed");
    await vi.advanceTimersByTimeAsync(1_000);
    const second = await harness.supervisor.waitForSession();
    await harness.supervisor.probe("second focus");

    expect(second.generation).toBe(2);
    expect(harness.probe).toHaveBeenCalledTimes(2);
    oldProbe.resolve(undefined);
    await firstProbe;
  });

  it("closes a connect result that arrives after disposal", async () => {
    const pending = deferred<TestSession>();
    let connectSignal: AbortSignal | undefined;
    const harness = makeHarness((_generation, signal) => {
      connectSignal = signal;
      return pending.promise;
    });
    const waiting = harness.supervisor.waitForSession();

    harness.supervisor.dispose();
    expect(connectSignal?.aborted).toBe(true);
    pending.resolve({ id: 1 });

    await expect(waiting).rejects.toThrow("disposed");
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.closed).toEqual([{ generation: 1, value: { id: 1 } }]);
    expect(harness.supervisor.snapshot.phase).toBe("disposed");
  });
});
