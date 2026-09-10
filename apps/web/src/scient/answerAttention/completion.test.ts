import { describe, expect, it } from "vite-plus/test";
import { MessageId, TurnId } from "@t3tools/contracts";
import { completedAnswer, hasUnreadAnswer } from "./completion";

const answer = {
  turnId: TurnId.make("one"),
  messageId: MessageId.make("reply"),
  completedAt: "2026-09-09T10:00:00.000Z",
};
const latestTurn = {
  turnId: TurnId.make("two"),
  assistantMessageId: null,
  requestedAt: answer.completedAt,
  startedAt: answer.completedAt,
  completedAt: null,
  state: "running" as const,
};
describe("unread answers", () => {
  it.each(["running", "interrupted", "error"] as const)(
    "preserves a previous answer while the next turn is %s",
    (state) => {
      expect(
        hasUnreadAnswer(
          { latestCompletedAnswer: answer, latestTurn: { ...latestTurn, state } },
          "2026-09-09T09:00:00.000Z",
        ),
      ).toBe(true);
    },
  );
  it("clears exactly the answer acknowledged, and ignores missing historical read markers", () => {
    expect(hasUnreadAnswer({ latestCompletedAnswer: answer }, answer.completedAt)).toBe(false);
    expect(hasUnreadAnswer({ latestCompletedAnswer: answer }, undefined)).toBe(false);
    expect(hasUnreadAnswer({ latestCompletedAnswer: answer }, "corrupt")).toBe(true);
  });
  it("falls back only for old servers and only for successful answers", () => {
    const completed = {
      ...latestTurn,
      state: "completed" as const,
      assistantMessageId: answer.messageId,
      completedAt: answer.completedAt,
    };
    expect(completedAnswer({ latestTurn: completed })?.messageId).toBe(answer.messageId);
    expect(completedAnswer({ latestCompletedAnswer: null, latestTurn: completed })).toBeNull();
    expect(completedAnswer({ latestTurn: { ...completed, state: "interrupted" } })).toBeNull();
    expect(completedAnswer({ latestTurn: { ...completed, state: "error" } })).toBeNull();
  });
});
