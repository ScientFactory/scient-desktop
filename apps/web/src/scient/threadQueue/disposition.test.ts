import { describe, expect, it } from "vite-plus/test";

import { resolveComposerSendDisposition, resolveComposerSteerRequested } from "./disposition";

describe("resolveComposerSendDisposition", () => {
  it("sends immediately when the thread is idle", () => {
    expect(resolveComposerSendDisposition({ threadBusy: false, steerRequested: false })).toBe(
      "send",
    );
  });

  it("queues when the thread is busy", () => {
    expect(resolveComposerSendDisposition({ threadBusy: true, steerRequested: false })).toBe(
      "queue",
    );
  });

  it("steers when the modifier is held, even while busy", () => {
    expect(resolveComposerSendDisposition({ threadBusy: true, steerRequested: true })).toBe("send");
  });
});

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

describe("composer recovery after Stop", () => {
  it("starts an ordinary message while stopped messages wait, then queues while the new answer runs", () => {
    const recovery = { hasQueuedItems: true, awaitingCompletion: true, steerRequested: false };
    expect(resolveComposerSendDisposition({ ...recovery, threadBusy: false })).toBe("send");
    expect(resolveComposerSendDisposition({ ...recovery, threadBusy: true })).toBe("queue");
    expect(
      resolveComposerSendDisposition({ ...recovery, threadBusy: false, awaitingCompletion: false }),
    ).toBe("queue");
  });
  it("requeues an edited item in place even while stopped or with the steer modifier", () => {
    expect(
      resolveComposerSendDisposition({
        threadBusy: false,
        hasQueuedItems: true,
        awaitingCompletion: true,
        editingQueuedItem: true,
        steerRequested: true,
      }),
    ).toBe("queue");
  });
});
