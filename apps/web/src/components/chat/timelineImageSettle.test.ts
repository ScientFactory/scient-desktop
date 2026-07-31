import { afterEach, describe, expect, it, vi } from "vitest";

import { scheduleTimelineImageSettleCorrections } from "./timelineImageSettle";

const setTimer = (callback: () => void, delay: number) =>
  setTimeout(callback, delay) as unknown as number;
const clearTimer = (id: number) => clearTimeout(id);

describe("timeline image settle corrections", () => {
  afterEach(() => vi.useRealTimers());

  it("stops pending corrections when the user scrolls away between callbacks", () => {
    vi.useFakeTimers();
    let isAtEnd = true;
    const scrollToEnd = vi.fn();
    scheduleTimelineImageSettleCorrections({
      isAtEnd: () => isAtEnd,
      scrollToEnd,
      requestFrame: (callback) => setTimer(() => callback(0), 0),
      cancelFrame: clearTimer,
      setTimer,
      clearTimer,
    });

    vi.advanceTimersByTime(1);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    isAtEnd = false;
    vi.advanceTimersByTime(300);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });
});
