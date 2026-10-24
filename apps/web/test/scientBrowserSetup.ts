import { beforeAll, beforeEach, expect, vi } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";
import { waitForTestReceipt } from "./receipt";

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

// Under fake timers every vi.waitFor and expect.poll (expect.element) retry advances the
// clock. At its deadline Vitest aborts a test's signal but does not stop its body, so a wait
// it left running would keep moving the next test's clock for up to its timeout. A wait
// belongs to the test running when it starts; once that test's signal aborts, it stops
// retrying.
let testSignal: AbortSignal | undefined;
beforeEach((context) => {
  testSignal = context.signal;
});

const waitForWithFixedDefault = vi.waitFor;
vi.waitFor = ((callback, options) => {
  const timed =
    typeof options === "number" || options?.timeout !== undefined
      ? options
      : { ...options, timeout: BROWSER_WAIT_TIMEOUT_MS };
  const signal = testSignal;
  if (!signal) return waitForWithFixedDefault(callback, timed);
  // After the abort, waitForTestReceipt has already rejected: the value that ends the
  // retries is never read.
  return waitForTestReceipt(
    signal,
    waitForWithFixedDefault(() => (signal.aborted ? (undefined as never) : callback()), timed),
  );
}) as typeof vi.waitFor;

// expect.poll returns a chain, not a promise, so it cannot reject early. A poll function
// that never settles parks the retry loop until the poll's own timeout, advancing nothing.
const pollWithoutOwner = expect.poll;
expect.poll = ((fn, options) => {
  const signal = testSignal;
  if (!signal) return pollWithoutOwner(fn, options);
  return pollWithoutOwner(function (this: unknown, ...args: Parameters<typeof fn>) {
    return signal.aborted ? new Promise<never>(() => {}) : fn.apply(this, args);
  }, options);
}) as typeof expect.poll;
