import { vi } from "vite-plus/test";
import { act } from "./render";

/**
 * Vitest aborts timed-out tests without stopping their bodies; advanceTimers drives whichever fake
 * clock is installed. Check ownership around every step so late work throws instead of moving the
 * next test's clock.
 */
export async function advanceTestClock(signal: AbortSignal, ms: number): Promise<void> {
  signal.throwIfAborted();
  await act(() => vi.advanceTimersByTimeAsync(ms));
  signal.throwIfAborted();
}
