import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createDelayedStatus,
  STATUS_MIN_VISIBLE_MS,
  STATUS_SHOW_DELAY_MS,
  type ShownStatus,
} from "./delayedStatus.ts";

// SCIENT-OWNED: the optional show delay used by the queue strip's "Queuing…".
describe("createDelayedStatus show delay option", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the given delay, then keeps the usual minimum visible time", () => {
    const changes: Array<ShownStatus<string> | null> = [];
    const status = createDelayedStatus<string>((shown) => changes.push(shown), {
      showDelayMs: 700,
    });
    status.update("row", "queuing");
    vi.advanceTimersByTime(699);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([{ key: "row", value: "queuing" }]);

    status.update("row", null);
    vi.advanceTimersByTime(STATUS_MIN_VISIBLE_MS - 1);
    expect(changes.at(-1)).toEqual({ key: "row", value: "queuing" });
    vi.advanceTimersByTime(1);
    expect(changes.at(-1)).toBeNull();
  });

  it("never shows a status that settles before the given delay", () => {
    const changes: Array<ShownStatus<string> | null> = [];
    const status = createDelayedStatus<string>((shown) => changes.push(shown), {
      showDelayMs: 700,
    });
    status.update("row", "queuing");
    vi.advanceTimersByTime(699);
    status.update("row", null);
    vi.runAllTimers();
    expect(changes).toEqual([]);
  });

  it("keeps the default delay without options", () => {
    const changes: Array<ShownStatus<string> | null> = [];
    const status = createDelayedStatus<string>((shown) => changes.push(shown));
    status.update("row", "syncing");
    vi.advanceTimersByTime(STATUS_SHOW_DELAY_MS);
    expect(changes).toEqual([{ key: "row", value: "syncing" }]);
  });
});
