import { beforeAll, beforeEach, chai, expect, vi } from "vite-plus/test";
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

// Vitest aborts a timed-out test's signal without stopping its body, and retries can advance the
// next test's fake clock. Bind each wait to its starting test and stop before every advance on
// abort or replacement; Vitest's own waitFor advances before checking pending callbacks.
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

// A poll callback or matcher can settle after its test ends, when another test owns the fake clock.
// Preserve Vitest's chain/matcher behavior but check ownership after each await and before every
// advance; reject with the original abort reason without moving another test's time.
const POLL_UNSUPPORTED = new Set([
  "matchSnapshot",
  "toMatchSnapshot",
  "toMatchInlineSnapshot",
  "toThrowErrorMatchingSnapshot",
  "toThrowErrorMatchingInlineSnapshot",
  "throws",
  "Throw",
  "throw",
  "toThrow",
  "toThrowError",
]);
type PollFlag = (assertion: object, name: string, value?: unknown) => unknown;
const pollFlag: PollFlag = (assertion, name, ...value) =>
  (chai.util.flag as (...args: unknown[]) => unknown)(assertion, name, ...value);

function withStackOf(error: unknown, source: Error) {
  if (error instanceof Error) {
    (error as Error & { cause?: unknown }).cause ??= new Error("Matcher did not succeed in time.");
    if (source.stack !== undefined)
      error.stack = source.stack.replace(source.message, error.message);
  }
  return error;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown } | { ok: "expired" };

const pollUnowned = expect.poll;
expect.poll = ((
  fn: (this: unknown, context: { signal: AbortSignal }) => unknown,
  options: { interval?: number; timeout?: number; message?: string } = {},
) => {
  const signal = testSignal;
  if (!signal) return pollUnowned(fn as never, options);
  // The browser project's expect.poll defaults (vite.config.ts), as Vitest would read them.
  const { interval = DEFAULT_INTERVAL_MS, timeout = BROWSER_WAIT_TIMEOUT_MS, message } = options;
  const assertion = (
    expect(null, message) as unknown as { withContext(context: object): object }
  ).withContext({ poll: true });
  const bound = fn.bind(assertion);
  pollFlag(assertion, "_poll.fn", bound);
  pollFlag(assertion, "_poll.timeout", timeout);
  pollFlag(assertion, "_poll.interval", interval);
  const test = pollFlag(assertion, "vitest-test") as { onFinished?: (() => void)[] } | undefined;
  if (!test) throw new Error("expect.poll() must be called inside a test");
  const proxy: object = new Proxy(assertion, {
    get(target, key, receiver) {
      const assertionFunction: unknown = Reflect.get(target, key, receiver);
      if (typeof assertionFunction !== "function")
        return assertionFunction instanceof chai.Assertion ? proxy : assertionFunction;
      if (key === "assert") return assertionFunction;
      if (typeof key === "string" && POLL_UNSUPPORTED.has(key))
        throw new SyntaxError(
          `expect.poll() is not supported in combination with .${key}(). Use vi.waitFor() if your assertion condition is unstable.`,
        );
      const matcher = assertionFunction as (...args: unknown[]) => unknown;
      return function pollChain(...args: unknown[]) {
        const stackTraceError = new Error("STACK_TRACE_ERROR");
        const run = async () => {
          pollFlag(assertion, "_name", key);
          pollFlag(assertion, "error", stackTraceError);
          const onStart = pollFlag(assertion, "_poll.onStart") as
            | ((event: { assertion: object }) => Promise<void> | void)
            | undefined;
          const onSettled = pollFlag(assertion, "_poll.onSettled") as
            | ((event: { assertion: object; status: "pass" | "fail" }) => Promise<void> | void)
            | undefined;
          await onStart?.({ assertion });
          if (Object.getOwnPropertyDescriptor(matcher, "__vitest_poll_takeover__")?.value) {
            // A matcher that owns its own retries (toMatchScreenshot): as Vitest runs it.
            try {
              const output = await matcher.apply(assertion, args);
              await onSettled?.({ assertion, status: "pass" });
              return output;
            } catch (error) {
              await onSettled?.({ assertion, status: "fail" });
              throw withStackOf(error, stackTraceError);
            }
          }
          const expiry = new AbortController();
          const expired = Promise.withResolvers<{ ok: "expired" }>();
          const gone = Promise.withResolvers<never>();
          const stop = () => gone.reject(signal.reason);
          gone.promise.catch(() => {});
          const timeoutId = realTimers.setTimeout(() => {
            expiry.abort();
            expired.resolve({ ok: "expired" });
          }, timeout);
          signal.addEventListener("abort", stop, { once: true });
          /** One step of the attempt, unless the poll expires or its test goes first. */
          const step = <T>(work: () => T | PromiseLike<T>): Promise<Settled<T>> =>
            Promise.race([
              Promise.resolve()
                .then(work)
                .then(
                  (value): Settled<T> => ({ ok: true, value }),
                  (error: unknown): Settled<T> => ({ ok: false, error }),
                ),
              expired.promise,
              gone.promise,
            ]);
          const ensureOwner = () => {
            if (ownerGone(signal))
              throw signal.aborted
                ? signal.reason
                : new Error("The test that started this poll has ended.");
          };
          let lastError: unknown;
          try {
            while (true) {
              ensureOwner();
              const called = await step(() => bound({ signal: expiry.signal }));
              ensureOwner();
              if (called.ok === "expired") {
                lastError ??= new Error("expect.poll() function didn't resolve in time.");
                break;
              }
              if (called.ok) {
                pollFlag(assertion, "object", called.value);
                const asserted = await step(() => matcher.apply(assertion, args));
                ensureOwner();
                if (asserted.ok === "expired") {
                  lastError ??= new Error("expect.poll() assertion didn't resolve in time.");
                  break;
                }
                if (asserted.ok) {
                  await onSettled?.({ assertion, status: "pass" });
                  return asserted.value;
                }
                lastError = asserted.error;
              } else lastError = called.error;
              // As in Vitest: a screenshot match owns its retries once its element resolved.
              if (key === "toMatchScreenshot") break;
              const paused = await step(
                () => new Promise<void>((resolve) => realTimers.setTimeout(resolve, interval)),
              );
              if (paused.ok === "expired") break;
              advanceOwnedClock(signal, interval);
            }
          } finally {
            realTimers.clearTimeout(timeoutId);
            signal.removeEventListener("abort", stop);
          }
          await onSettled?.({ assertion, status: "fail" });
          throw withStackOf(lastError, stackTraceError);
        };
        let awaited = false;
        (test.onFinished ??= []).push(() => {
          if (awaited) return;
          const negated = pollFlag(assertion, "negate") ? "not." : "";
          const shown = `expect.${pollFlag(assertion, "_poll.element") ? "element(locator)" : "poll(assertion)"}.${negated}${String(key)}()`;
          throw withStackOf(
            new Error(
              `${shown} was not awaited. This assertion is asynchronous and must be awaited; otherwise, it is not executed to avoid unhandled rejections:\n\nawait ${shown}\n`,
            ),
            stackTraceError,
          );
        });
        let result: Promise<unknown> | undefined;
        const wrap = pollFlag(assertion, "_poll.wrap") as
          | ((promise: Promise<unknown>, stack: Error) => Promise<unknown>)
          | undefined;
        const start = () => (result ??= wrap ? wrap(run(), stackTraceError) : run());
        // Vitest's poll result: a thenable that starts the poll when awaited.
        return {
          // oxlint-disable-next-line unicorn/no-thenable -- expect.poll's contract is a lazy thenable.
          then(
            onFulfilled?: (value: unknown) => unknown,
            onRejected?: (error: unknown) => unknown,
          ) {
            awaited = true;
            return start().then(onFulfilled, onRejected);
          },
          catch(onRejected?: (error: unknown) => unknown) {
            awaited = true;
            return start().catch(onRejected);
          },
          finally(onFinally?: () => void) {
            awaited = true;
            return start().finally(onFinally);
          },
          [Symbol.toStringTag]: "Promise",
        };
      };
    },
  });
  return proxy;
}) as unknown as typeof expect.poll;
