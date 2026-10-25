import { beforeAll, beforeEach, expect, vi } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Defined in test/scientCpuThrottle.ts. Applies SCIENT_TEST_CPU_THROTTLE to this page. */
    applyCpuThrottle: () => Promise<number>;
  }
}

// A no-op unless SCIENT_TEST_CPU_THROTTLE is set. Runs before every test file because a
// file may land on a page the pool opened after the previous file finished.
beforeAll(async () => {
  await commands.applyCpuThrottle();
});

// vi.waitFor gives up after 1 s unless a call says otherwise, and has no config option.
// GitHub's runners do layout-heavy work 4-7x slower than a developer Mac, so a wait that
// needs 0.3 s locally can need 2 s there. Calls that name their own timeout keep it;
// expect.poll gets the same default from vite.config.ts (test.expect.poll.timeout).
const BROWSER_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_INTERVAL_MS = 50;

// Under fake timers every vi.waitFor, vi.waitUntil and expect.poll retry advances the
// clock. At its deadline Vitest aborts a test's signal but does not stop its body, and the
// fake clock is whichever is installed: soon the next test's. So a wait belongs to the
// test running when it starts. It stops (rejects, clears its timers) when that test's
// signal aborts or another test starts, and checks that before every advance. Vitest's
// own waitFor cannot do this: its retry interval keeps running after an outer abort, and
// advances fake time before it looks at a callback that is still pending.
let testSignal: AbortSignal | undefined;
// The test whose body installed the current fake clock (undefined: a hook outside any test).
let fakeClockOwner: AbortSignal | undefined;
beforeEach((context) => {
  // A timed-out body suspended inside its fake-timer scope never disposes it. Its tree,
  // if any, was unmounted while those timers were still installed; the next test starts
  // on native timers. (fakeTimers() in test/render.tsx then leaves the next clock alone.)
  if (fakeClockOwner?.aborted && vi.isFakeTimers()) vi.useRealTimers();
  fakeClockOwner = undefined;
  testSignal = context.signal;
});

const useFakeTimersUnowned = vi.useFakeTimers;
vi.useFakeTimers = ((config) => {
  fakeClockOwner = testSignal;
  return useFakeTimersUnowned.call(vi, config);
}) as typeof vi.useFakeTimers;

const realTimers = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
};

function ownerGone(signal: AbortSignal) {
  return signal.aborted || testSignal !== signal;
}

/** Advances fake time by one retry interval, only for the wait's own test. */
function advanceOwnedClock(signal: AbortSignal, interval: number) {
  if (!ownerGone(signal) && vi.isFakeTimers()) vi.advanceTimersByTime(interval);
}

function readWaitOptions(options: number | { timeout?: number; interval?: number } | undefined) {
  const { timeout = BROWSER_WAIT_TIMEOUT_MS, interval = DEFAULT_INTERVAL_MS } =
    typeof options === "number" ? { timeout: options } : (options ?? {});
  return { timeout, interval };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Vitest's waitFor and waitUntil retry loop (advance, then check unless a check is still
 * pending; give up at the timeout), owned by `signal`'s test. `settle` decides each
 * check's result: a value to resolve with, `retry`, or a thrown error.
 */
function ownedRetry<T>(
  signal: AbortSignal,
  options: number | { timeout?: number; interval?: number } | undefined,
  check: () => unknown,
  settle: (result: unknown) => T | typeof retry,
  rejectOnThrow: boolean,
  timeoutMessage: string,
): Promise<T> {
  const { timeout, interval } = readWaitOptions(options);
  const stackTraceError = new Error("STACK_TRACE_ERROR");
  return new Promise<T>((resolve, reject) => {
    let lastError: unknown;
    let pending = false;
    let done = false;
    let timeoutId: ReturnType<typeof realTimers.setTimeout> | undefined;
    let intervalId: ReturnType<typeof realTimers.setInterval> | undefined;
    const finish = () => {
      done = true;
      if (timeoutId !== undefined) realTimers.clearTimeout(timeoutId);
      if (intervalId !== undefined) realTimers.clearInterval(intervalId);
      signal.removeEventListener("abort", stop);
    };
    const succeed = (value: T) => {
      finish();
      resolve(value);
    };
    const fail = (error: unknown) => {
      finish();
      reject(error);
    };
    function stop() {
      if (!done)
        fail(
          signal.aborted ? signal.reason : new Error("The test that started this wait has ended."),
        );
    }
    const onResult = (result: unknown) => {
      const settled = settle(result);
      if (settled !== retry) succeed(settled);
    };
    const onError = (error: unknown) => {
      if (rejectOnThrow) fail(error);
      else lastError = error;
    };
    const tick = () => {
      if (done) return;
      if (ownerGone(signal)) return stop();
      advanceOwnedClock(signal, interval);
      if (pending || done) return;
      try {
        const result = check();
        if (isThenable(result)) {
          pending = true;
          result.then(
            (value) => {
              pending = false;
              if (!done) onResult(value);
            },
            (error: unknown) => {
              pending = false;
              if (!done) onError(error);
            },
          );
        } else onResult(result);
      } catch (error) {
        onError(error);
      }
    };
    signal.addEventListener("abort", stop, { once: true });
    tick();
    if (done) return;
    timeoutId = realTimers.setTimeout(() => {
      if (lastError !== undefined) return fail(lastError);
      const error = new Error(timeoutMessage);
      if (stackTraceError.stack)
        error.stack = stackTraceError.stack.replace(stackTraceError.message, error.message);
      fail(error);
    }, timeout);
    intervalId = realTimers.setInterval(tick, interval);
  });
}
const retry = Symbol("retry");

const waitForUnowned = vi.waitFor;
vi.waitFor = ((callback, options) => {
  const signal = testSignal;
  if (!signal) {
    const timed =
      typeof options === "number" || options?.timeout !== undefined
        ? options
        : { ...options, timeout: BROWSER_WAIT_TIMEOUT_MS };
    return waitForUnowned(callback, timed);
  }
  return ownedRetry(signal, options, callback, (value) => value, false, "Timed out in waitFor!");
}) as typeof vi.waitFor;

const waitUntilUnowned = vi.waitUntil;
vi.waitUntil = ((callback, options) => {
  const signal = testSignal;
  if (!signal) {
    const timed =
      typeof options === "number" || options?.timeout !== undefined
        ? options
        : { ...options, timeout: BROWSER_WAIT_TIMEOUT_MS };
    return waitUntilUnowned(callback, timed);
  }
  return ownedRetry(
    signal,
    options,
    callback,
    (value) => (value ? value : retry),
    true,
    "Timed out in waitUntil!",
  );
}) as typeof vi.waitUntil;

// expect.poll keeps Vitest's loop (it carries the matchers and expect.element), but with a
// zero interval, so Vitest itself never advances fake time by more than zero. The real
// pause and the advance happen here, before each retry, only while the poll's test owns
// the clock. Once that test is gone the function never settles and the loop parks until
// the poll's own timeout, advancing nothing: checked before the callback runs and again
// when it settles, since a rejection reaching Vitest's retry step would advance (by zero,
// enough to fire the next test's zero-delay timers) whatever clock is installed then.
const pollUnowned = expect.poll;
expect.poll = ((fn, options) => {
  const signal = testSignal;
  if (!signal) return pollUnowned(fn, options);
  const interval = options?.interval ?? DEFAULT_INTERVAL_MS;
  let first = true;
  return pollUnowned(
    async function (this: unknown, ...args: Parameters<typeof fn>) {
      if (!first) {
        await new Promise<void>((resolve) => realTimers.setTimeout(resolve, interval));
        advanceOwnedClock(signal, interval);
      }
      first = false;
      if (ownerGone(signal)) return new Promise<never>(() => {});
      const settled = await Promise.resolve()
        .then(() => fn.apply(this, args))
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      if (ownerGone(signal)) return new Promise<never>(() => {});
      if (!settled.ok) throw settled.error;
      return settled.value;
    },
    { ...options, interval: 0 },
  );
}) as typeof expect.poll;
