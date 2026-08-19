import { describe, expect, it } from "vite-plus/test";

import {
  isSteerShortcut,
  resolveComposerSendDisposition,
  shouldDispatchNextQueuedMessage,
} from "./disposition";

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

describe("shouldDispatchNextQueuedMessage", () => {
  it("advances the first queued message after the active turn settles", () => {
    expect(
      shouldDispatchNextQueuedMessage({
        threadReady: true,
        hasQueuedItem: true,
        dispatchBlocked: false,
      }),
    ).toBe(true);
  });

  it("does not overlap an active turn or a previous dispatch", () => {
    expect(
      shouldDispatchNextQueuedMessage({
        threadReady: false,
        hasQueuedItem: true,
        dispatchBlocked: false,
      }),
    ).toBe(false);
    expect(
      shouldDispatchNextQueuedMessage({
        threadReady: true,
        hasQueuedItem: true,
        dispatchBlocked: true,
      }),
    ).toBe(false);
  });
});
