import { expect, it, vi } from "vite-plus/test";
import { createSnoozeClock } from "./useThreadSnoozeClock";

const epoch = Date.parse("2026-10-21T00:00:00.000Z");
const iso = (ms: number) => new Date(epoch + ms).toISOString();

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
  return { [Symbol.dispose]: () => vi.useRealTimers() };
}

it("caches a clock snapshot until the thread identity changes", () => {
  using _timers = setup();
  const clock = createSnoozeClock();
  const identity = {};
  expect(clock.read(identity)).toBe(iso(0));
  vi.advanceTimersByTime(1234);
  expect(clock.read(identity)).toBe(iso(0));
  expect(clock.read({})).toBe(iso(1234));
});

it("publishes the snooze wake deadline without requiring a minute tick", () => {
  using _timers = setup();
  const clock = createSnoozeClock();
  const identity = {};
  const notify = vi.fn();
  clock.read(identity);
  using _wake = {
    [Symbol.dispose]: clock.subscribe(identity, iso(1000), notify),
  };
  vi.advanceTimersByTime(1049);
  expect(notify).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(notify).toHaveBeenCalledOnce();
  expect(clock.read(identity)).toBe(iso(1050));
  expect(vi.getTimerCount()).toBe(0);
  using _expired = { [Symbol.dispose]: clock.subscribe(identity, iso(1000), notify) };
  vi.advanceTimersByTime(5000);
  expect(notify).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("still wakes if the deadline passes between snapshot read and subscription", () => {
  using _timers = setup();
  const clock = createSnoozeClock();
  const identity = {};
  const notify = vi.fn();
  clock.read(identity);
  vi.advanceTimersByTime(11);
  using _wake = {
    [Symbol.dispose]: clock.subscribe(identity, iso(10), notify),
  };
  vi.advanceTimersByTime(50);
  expect(notify).toHaveBeenCalledOnce();
  expect(Date.parse(clock.read(identity))).toBeGreaterThan(epoch + 10);
});

it("rearms a snooze beyond the platform timer range rather than waking early", () => {
  using _timers = setup();
  const clock = createSnoozeClock();
  const identity = {};
  const notify = vi.fn();
  const maxDelay = 2_147_483_647;
  clock.read(identity);
  using _wake = {
    [Symbol.dispose]: clock.subscribe(identity, iso(maxDelay + 100), notify),
  };
  vi.advanceTimersByTime(maxDelay);
  expect(notify).toHaveBeenCalledOnce();
  expect(clock.read(identity)).toBe(iso(maxDelay));
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(150);
  expect(notify).toHaveBeenCalledTimes(2);
  expect(clock.read(identity)).toBe(iso(maxDelay + 150));
  expect(vi.getTimerCount()).toBe(0);
});

it("disposes a wake subscription and ignores a stale thread's pending wake", () => {
  using _timers = setup();
  const clock = createSnoozeClock();
  const identity = {};
  const notify = vi.fn();
  clock.read(identity);
  const unsubscribe = clock.subscribe(identity, iso(1000), notify);
  unsubscribe();
  expect(vi.getTimerCount()).toBe(0);
  using _wake = {
    [Symbol.dispose]: clock.subscribe(identity, iso(1000), notify),
  };
  const nextIdentity = {};
  clock.read(nextIdentity);
  vi.advanceTimersByTime(1050);
  expect(notify).not.toHaveBeenCalled();
  expect(clock.read(nextIdentity)).toBe(iso(0));
});

it("does not schedule a wake for an absent or invalid deadline", () => {
  using _timers = setup();
  const clock = createSnoozeClock();
  const identity = {};
  const notify = vi.fn();
  clock.read(identity);
  using _absent = { [Symbol.dispose]: clock.subscribe(identity, null, notify) };
  using _invalid = { [Symbol.dispose]: clock.subscribe(identity, "invalid", notify) };
  expect(vi.getTimerCount()).toBe(0);
  expect(notify).not.toHaveBeenCalled();
});

it("does not rearm a long wake disposed by its own notification", () => {
  using _timers = setup();
  const clock = createSnoozeClock();
  const identity = {};
  const notify = vi.fn();
  clock.read(identity);
  let unsubscribe = () => {};
  unsubscribe = clock.subscribe(identity, iso(2_147_483_747), () => {
    notify();
    unsubscribe();
  });
  using _wake = { [Symbol.dispose]: () => unsubscribe() };
  vi.advanceTimersByTime(2_147_483_647);
  expect(notify).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
