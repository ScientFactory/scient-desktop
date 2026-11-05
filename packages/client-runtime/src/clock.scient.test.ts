import { expect, it, vi } from "vite-plus/test";
import { configureRenderClockScheduling, deadlineStore, secondTick } from "./clock.ts";

it("defers display clocks, catches up once, and leaves deadlines immediate", () => {
  vi.useFakeTimers({ now: 0 });
  let flush: (() => void) | undefined;
  const restore = configureRenderClockScheduling((notify) => {
    flush = notify;
    return () => {
      flush = undefined;
    };
  });
  const listener = vi.fn();
  const unsubscribe = secondTick.subscribe(listener);
  const deadline = deadlineStore(1500);
  const onDeadline = vi.fn();
  const unsubscribeDeadline = deadline.subscribe(onDeadline);
  try {
    vi.advanceTimersByTime(3000);
    expect(secondTick.getSnapshot()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(onDeadline).toHaveBeenCalledOnce();
    expect(deadline.getSnapshot()).toBe(true);
    flush?.();
    expect(secondTick.getSnapshot()).toBe(3000);
    expect(listener).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    unsubscribe();
    expect(flush).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    unsubscribe();
    unsubscribeDeadline();
    restore();
    vi.useRealTimers();
  }
});
