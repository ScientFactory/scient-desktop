import { describe, expect, it } from "vite-plus/test";

import { resolveComposerSteerRequested } from "./disposition";

describe("resolveComposerSteerRequested", () => {
  it("maps normal and alternate sends to opposite running-turn behaviors", () => {
    expect(
      resolveComposerSteerRequested({
        threadBusy: true,
        followUpBehavior: "queue",
        alternateRequested: false,
      }),
    ).toBe(false);
    expect(
      resolveComposerSteerRequested({
        threadBusy: true,
        followUpBehavior: "queue",
        alternateRequested: true,
      }),
    ).toBe(true);
    expect(
      resolveComposerSteerRequested({
        threadBusy: true,
        followUpBehavior: "steer",
        alternateRequested: false,
      }),
    ).toBe(true);
    expect(
      resolveComposerSteerRequested({
        threadBusy: true,
        followUpBehavior: "steer",
        alternateRequested: true,
      }),
    ).toBe(false);
  });

  it("never requests a steer while the thread is idle", () => {
    expect(
      resolveComposerSteerRequested({
        threadBusy: false,
        followUpBehavior: "steer",
        alternateRequested: false,
      }),
    ).toBe(false);
  });
});
