// test/scientBrowserSetup.ts and fakeTimers() (test/render.tsx): a wait and a fake clock
// belong to the test that started them. At its deadline Vitest aborts a test but does not
// stop its body; what the body left running must not reach the next test. Each pair runs
// in order: the first test leaves something behind, the second checks its own clock.
import { expect, it, vi } from "vite-plus/test";
import { fakeTimers } from "../../../test/render";

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realDelay = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

/** The next test: real time passes while its fake clock must stand still. */
async function expectClockUntouched() {
  using _clock = fakeTimers();
  const start = vi.getMockedSystemTime()!.getTime();
  const fired = vi.fn();
  setTimeout(fired, 100);
  await realDelay(500);
  expect(
    vi.getMockedSystemTime()!.getTime() - start,
    "fake time moved by a previous test's wait",
  ).toBe(0);
  expect(fired).not.toHaveBeenCalled();
}

// The deadline lands while the wait's async callback is still pending, the case in which
// Vitest's own retry loop keeps advancing fake time without calling back.
// oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- the deadline is the scenario.
it.fails("times out while vi.waitFor's async callback is pending", { timeout: 200 }, async () => {
  using _clock = fakeTimers();
  await vi.waitFor(() => new Promise<never>(() => {}), { timeout: 10_000, interval: 50 });
});
it("keeps its own clock after a timed-out test's vi.waitFor", expectClockUntouched);

// oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- the deadline is the scenario.
it.fails("times out while vi.waitUntil retries", { timeout: 200 }, async () => {
  using _clock = fakeTimers();
  await vi.waitUntil(() => false, { timeout: 10_000, interval: 50 });
});
it("keeps its own clock after a timed-out test's vi.waitUntil", expectClockUntouched);

// oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- the deadline is the scenario.
it.fails("times out while expect.poll retries", { timeout: 200 }, async () => {
  using _clock = fakeTimers();
  await expect.poll(() => 1, { timeout: 10_000, interval: 50 }).toBe(2);
});
it("keeps its own clock after a timed-out test's expect.poll", expectClockUntouched);

// A test that passes but leaves a wait running: the next test's start ends it.
it("leaves a vi.waitFor running when it passes", () => {
  using _clock = fakeTimers();
  void vi
    .waitFor(() => new Promise<never>(() => {}), { timeout: 10_000, interval: 50 })
    .catch(() => {});
});
it("keeps its own clock after a passed test's leftover vi.waitFor", expectClockUntouched);

// A timed-out body suspended inside its fake-timer scope never disposes it: the next test
// still starts on native timers.
// oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- the deadline is the scenario.
it.fails("times out holding fake timers", { timeout: 200 }, async () => {
  using _clock = fakeTimers();
  await new Promise<never>(() => {});
});
it("starts on native timers after a timed-out test held fake ones", () => {
  expect(vi.isFakeTimers()).toBe(false);
});

// A timed-out body that unwinds late disposes its fake timers then: that must not remove
// the clock the next test has installed meanwhile.
// oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- the deadline is the scenario.
it.fails("times out and disposes its fake timers late", { timeout: 200 }, async () => {
  using _clock = fakeTimers();
  await realDelay(400);
});
it("keeps its fake clock when a timed-out test disposes its own late", async () => {
  using _clock = fakeTimers();
  await realDelay(600);
  expect(vi.isFakeTimers()).toBe(true);
});
