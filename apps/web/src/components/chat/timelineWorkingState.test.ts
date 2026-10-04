import { describe, expect, it } from "vite-plus/test";
import {
  nextTurnStartWait,
  resolveTimelineWorking,
  type TurnStartWait,
} from "./timelineWorkingState";

const idle: TurnStartWait = {
  threadKey: "t",
  sendBusy: false,
  sendStartedAt: null,
  turnCompletedAt: "2026-10-04T10:00:00.000Z",
  awaiting: false,
};
const input = {
  threadKey: "t",
  sendBusy: false,
  sendStartedAt: null,
  turnCompletedAt: "2026-10-04T10:00:00.000Z",
  sessionWorking: false,
  failed: false,
};
const sending = nextTurnStartWait(idle, {
  ...input,
  sendBusy: true,
  sendStartedAt: "2026-10-04T11:00:00.000Z",
});

describe("resolveTimelineWorking", () => {
  it("holds the working row back until the sent prompt is in the list", () => {
    const busy = { isWorking: true, onlySendBusy: true, awaitingTurnStart: false };
    expect(resolveTimelineWorking({ ...busy, sentPromptShown: false })).toBe(false);
    expect(resolveTimelineWorking({ ...busy, sentPromptShown: true })).toBe(true);
    // Other work (a running session, worktree setup) shows at once.
    expect(resolveTimelineWorking({ ...busy, onlySendBusy: false, sentPromptShown: false })).toBe(
      true,
    );
  });

  it("keeps showing work while an acknowledged send waits for its turn to start", () => {
    const quiet = { isWorking: false, onlySendBusy: false, sentPromptShown: true };
    expect(resolveTimelineWorking({ ...quiet, awaitingTurnStart: true })).toBe(true);
    expect(resolveTimelineWorking({ ...quiet, awaitingTurnStart: false })).toBe(false);
  });
});

describe("nextTurnStartWait", () => {
  it("waits from the acknowledgement until a session picks the turn up", () => {
    const acknowledged = nextTurnStartWait(sending, input);
    expect(acknowledged.awaiting).toBe(true);
    expect(nextTurnStartWait(acknowledged, input)).toBe(acknowledged);
    expect(nextTurnStartWait(acknowledged, { ...input, sessionWorking: true }).awaiting).toBe(
      false,
    );
  });

  it("does not wait when the send failed, its turn settled, or a session already runs", () => {
    expect(nextTurnStartWait(sending, { ...input, failed: true }).awaiting).toBe(false);
    expect(nextTurnStartWait(sending, { ...input, sessionWorking: true }).awaiting).toBe(false);
    const settled = { ...input, turnCompletedAt: "2026-10-04T11:00:05.000Z" };
    expect(nextTurnStartWait(sending, settled).awaiting).toBe(false);
    // Settled in an earlier render, before the send stopped being busy.
    const completedWhileBusy = nextTurnStartWait(sending, { ...settled, sendBusy: true });
    expect(nextTurnStartWait(completedWhileBusy, settled).awaiting).toBe(false);
  });

  it("ends the wait when a turn settles or the thread changes", () => {
    const acknowledged = nextTurnStartWait(sending, input);
    expect(
      nextTurnStartWait(acknowledged, { ...input, turnCompletedAt: "2026-10-04T11:00:09.000Z" })
        .awaiting,
    ).toBe(false);
    expect(nextTurnStartWait(acknowledged, { ...input, threadKey: "other" }).awaiting).toBe(false);
  });
});
