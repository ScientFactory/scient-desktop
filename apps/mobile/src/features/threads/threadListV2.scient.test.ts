import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { EnvironmentId, MessageId, RunId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";

import { threadHasUnseenCompletion } from "./threadListV2";

const environmentId = EnvironmentId.make("environment-1");

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return makeThreadShellFixture({
    environmentId,
    ...input,
  });
}

describe("mobile canonical completed-answer prominence", () => {
  const completedAt = "2026-10-04T10:00:00.000Z";
  const latestRun = {
    runId: RunId.make("new-run"),
    status: "completed" as const,
    requestedAt: null,
    startedAt: null,
    completedAt: "2026-10-04T12:00:00.000Z",
    assistantMessageId: null,
  };
  // regression: 2a48f8bac2 refactor(orchestration): publish the qualified V2 alignment tree
  it("retains an earlier unread answer while a newer run is answerless", () => {
    expect(
      threadHasUnseenCompletion(
        makeThread({
          id: ThreadId.make("answer"),
          title: "Answer",
          lastVisitedAt: "2026-10-04T09:00:00.000Z",
          latestRun,
          latestCompletedAnswer: {
            turnId: TurnId.make("old-run"),
            messageId: MessageId.make("old-answer"),
            completedAt,
          },
        }),
      ),
    ).toBe(true);
  });
  // regression: 2a48f8bac2 refactor(orchestration): publish the qualified V2 alignment tree
  it("does not mark an answerless, failed or rolled-back completion unread", () => {
    expect(
      threadHasUnseenCompletion(
        makeThread({
          id: ThreadId.make("answerless"),
          title: "No answer",
          lastVisitedAt: "2026-10-04T09:00:00.000Z",
          latestRun,
          latestCompletedAnswer: null,
        }),
      ),
    ).toBe(false);
  });
  // regression: 2a48f8bac2 refactor(orchestration): publish the qualified V2 alignment tree
  it("keeps legacy completion fallback only for an absent canonical field", () => {
    expect(
      threadHasUnseenCompletion(
        makeThread({
          id: ThreadId.make("legacy"),
          title: "Legacy",
          lastVisitedAt: "2026-10-04T09:00:00.000Z",
          latestRun,
          latestCompletedAnswer: undefined,
        }),
      ),
    ).toBe(true);
  });
});
