import { vi } from "vite-plus/test";
import { act } from "./render";

/**
 * Advances the fake clock by `ms`, inside act, for the test that owns `signal`.
 *
 * At its deadline Vitest aborts a test's signal but does not stop its body, and
 * `vi.advanceTimers*` drive whichever fake clock is installed: soon the next
 * test's. Checking the signal around every step makes a loop that drives the
 * clock throw the abort reason instead of moving another test's time.
 */
export async function advanceTestClock(signal: AbortSignal, ms: number): Promise<void> {
  signal.throwIfAborted();
  await act(() => vi.advanceTimersByTimeAsync(ms));
  signal.throwIfAborted();
}
