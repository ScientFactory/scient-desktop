import { describe, expect, it } from "vite-plus/test";

import {
  delayedStatusDeadline,
  shownDelayedStatus,
  stepDelayedStatus,
  type DelayedStatusState,
} from "./delayedStatus.ts";

// SCIENT-OWNED: the queue strip keeps its delayed "Queuing…" presentation.
function step(state: DelayedStatusState<string> | null, value: string | null, now: number) {
  const deadline = state === null ? null : delayedStatusDeadline(state);
  return stepDelayedStatus(
    state,
    { key: "row", value, deadlinePassed: deadline !== null && now >= deadline },
    () => now,
    { showDelayMs: 700 },
  );
}

describe("delayed status show delay option", () => {
  it("waits for the given delay, then keeps the usual minimum visible time", () => {
    const pending = step(null, "queuing", 0);
    expect(shownDelayedStatus(step(pending, "queuing", 699), "row")).toBeNull();
    const shown = step(pending, "queuing", 700);
    expect(shownDelayedStatus(shown, "row")).toBe("queuing");
    expect(shownDelayedStatus(step(shown, null, 1099), "row")).toBe("queuing");
    expect(shownDelayedStatus(step(shown, null, 1100), "row")).toBeNull();
  });

  it("never shows a status that settles before the given delay", () => {
    const pending = step(null, "queuing", 0);
    const cleared = step(pending, null, 699);
    expect(shownDelayedStatus(step(cleared, null, 1000), "row")).toBeNull();
  });

  it("keeps the default delay without options", () => {
    const pending = stepDelayedStatus<string>(
      null,
      { key: "row", value: "syncing", deadlinePassed: false },
      () => 0,
    );
    expect(delayedStatusDeadline(pending)).toBe(400);
    const shown = stepDelayedStatus(
      pending,
      { key: "row", value: "syncing", deadlinePassed: true },
      () => 400,
    );
    expect(shownDelayedStatus(shown, "row")).toBe("syncing");
  });
});
