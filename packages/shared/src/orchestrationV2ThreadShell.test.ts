import { MessageId, RunId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  completedAnswerTimestamp,
  hasUnreadCompletedAnswer,
} from "./orchestrationV2ThreadShell.ts";

const answer = {
  turnId: TurnId.make("completed-run"),
  messageId: MessageId.make("answer"),
  completedAt: "2026-10-04T10:00:00.000Z",
};
const visit = "2026-10-04T09:00:00.000Z";
describe("canonical completed-answer attention", () => {
  it.each(["running", "failed", "interrupted", "rolled_back", "completed"])(
    "retains the last completed answer across a newer %s run",
    (status) => {
      const source = {
        latestCompletedAnswer: answer,
        latestRun: {
          runId: RunId.make("new-run"),
          status,
          completedAt: "2026-10-04T12:00:00.000Z",
        },
      };
      expect(completedAnswerTimestamp(source)).toBe(answer.completedAt);
      expect(hasUnreadCompletedAnswer(source, visit)).toBe(true);
      expect(hasUnreadCompletedAnswer(source, "2026-10-04T11:00:00.000Z")).toBe(false);
    },
  );
  it("does not resurrect explicit null from run completion timestamps", () => {
    const source = {
      latestCompletedAnswer: null,
      latestRun: { status: "completed", completedAt: answer.completedAt },
    };
    expect(completedAnswerTimestamp(source)).toBeNull();
    expect(hasUnreadCompletedAnswer(source, visit)).toBe(false);
  });
  it("uses legacy run completion only when canonical data is absent and successful", () => {
    expect(
      completedAnswerTimestamp({
        latestRun: { status: "completed", completedAt: answer.completedAt },
      }),
    ).toBe(answer.completedAt);
    expect(
      completedAnswerTimestamp({
        latestRun: { status: "failed", completedAt: answer.completedAt },
      }),
    ).toBeNull();
  });
  it("preserves missing-visit and invalid-date policies", () => {
    const source = { latestCompletedAnswer: answer };
    expect(hasUnreadCompletedAnswer(source, null)).toBe(false);
    expect(hasUnreadCompletedAnswer(source, "broken")).toBe(true);
    expect(
      hasUnreadCompletedAnswer(
        { latestCompletedAnswer: { ...answer, completedAt: "broken" } },
        visit,
      ),
    ).toBe(false);
  });
});
