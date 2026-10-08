import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  FORK_LANDING_TIMEOUT_MS,
  isForkLandingPending,
  isForkLandingReady,
  markForkLanding,
  settleForkLanding,
  subscribeForkLanding,
} from "./forkLanding";

const fork = "env:fork";

afterEach(() => {
  settleForkLanding(fork);
  vi.useRealTimers();
});

describe("fork landing", () => {
  it("is pending only for the marked destination until it settles", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeForkLanding(listener);
    markForkLanding(fork);
    expect(isForkLandingPending(fork)).toBe(true);
    expect(isForkLandingPending("env:origin")).toBe(false);
    expect(isForkLandingPending(null)).toBe(false);
    settleForkLanding(fork);
    expect(isForkLandingPending(fork)).toBe(false);
    // Settling twice notifies once.
    settleForkLanding(fork);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("can never stay hidden: the mark expires on its own", () => {
    vi.useFakeTimers();
    markForkLanding(fork);
    vi.advanceTimersByTime(FORK_LANDING_TIMEOUT_MS - 1);
    expect(isForkLandingPending(fork)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isForkLandingPending(fork)).toBe(false);
  });

  it("restarts the timeout when the same fork is marked again", () => {
    vi.useFakeTimers();
    markForkLanding(fork);
    vi.advanceTimersByTime(FORK_LANDING_TIMEOUT_MS - 10);
    markForkLanding(fork);
    vi.advanceTimersByTime(FORK_LANDING_TIMEOUT_MS - 10);
    expect(isForkLandingPending(fork)).toBe(true);
    vi.advanceTimersByTime(10);
    expect(isForkLandingPending(fork)).toBe(false);
  });
});

describe("isForkLandingReady", () => {
  const loaded = {
    threadKey: fork,
    threadExists: true,
    threadDeleted: false,
    detailLoaded: true,
    displayedThreadKey: fork,
    timelineEmpty: false,
    positionedThreadKey: fork,
  };

  it("waits for the fork's own rows to be loaded and positioned", () => {
    expect(isForkLandingReady(loaded)).toBe(true);
    expect(isForkLandingReady({ ...loaded, threadExists: false })).toBe(false);
    expect(isForkLandingReady({ ...loaded, detailLoaded: false })).toBe(false);
    expect(isForkLandingReady({ ...loaded, positionedThreadKey: null })).toBe(false);
    // The list positioned the origin's rows, not the fork's.
    expect(isForkLandingReady({ ...loaded, positionedThreadKey: "env:origin" })).toBe(false);
    // Another thread's rows are on screen.
    expect(
      isForkLandingReady({
        ...loaded,
        displayedThreadKey: "env:origin",
        positionedThreadKey: "env:origin",
      }),
    ).toBe(false);
  });

  it("shows an empty fork once its detail is known, and a deleted fork at once", () => {
    expect(isForkLandingReady({ ...loaded, timelineEmpty: true, positionedThreadKey: null })).toBe(
      true,
    );
    expect(isForkLandingReady({ ...loaded, timelineEmpty: true, detailLoaded: false })).toBe(false);
    expect(
      isForkLandingReady({
        ...loaded,
        threadDeleted: true,
        threadExists: false,
        detailLoaded: false,
        positionedThreadKey: null,
      }),
    ).toBe(true);
  });
});
