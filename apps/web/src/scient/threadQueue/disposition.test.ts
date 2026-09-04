import { describe, expect, it } from "vite-plus/test";

import { isSteerShortcut, resolveComposerSendDisposition } from "./disposition";

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

describe("isSteerShortcut", () => {
  it("accepts Cmd or Ctrl without Shift", () => {
    expect(isSteerShortcut({ metaKey: true, ctrlKey: false, shiftKey: false })).toBe(true);
    expect(isSteerShortcut({ metaKey: false, ctrlKey: true, shiftKey: false })).toBe(true);
  });

  it("rejects plain Enter and Shift+Cmd+Enter", () => {
    expect(isSteerShortcut({ metaKey: false, ctrlKey: false, shiftKey: false })).toBe(false);
    expect(isSteerShortcut({ metaKey: true, ctrlKey: false, shiftKey: true })).toBe(false);
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
