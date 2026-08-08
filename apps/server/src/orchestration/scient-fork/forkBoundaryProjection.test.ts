import { expect, it } from "vite-plus/test";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";

import { appendConversationForkBoundary } from "./forkBoundaryProjection.ts";

const at = "2026-08-08T07:00:00.000Z";

function threadWith(
  messages: OrchestrationThread["messages"],
  boundaries: NonNullable<OrchestrationThread["conversationForkBoundaries"]>,
): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Fork boundary test",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    titleRegeneration: null,
    deletedAt: null,
    messages,
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    conversationForkBoundaries: boundaries,
    session: null,
  };
}

function userMessage(id: string, turnId: string | null) {
  return {
    id: MessageId.make(id),
    role: "user" as const,
    text: id,
    turnId: turnId === null ? null : TurnId.make(turnId),
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
}

it("associates a completed turn with its user message when a newer turn is active", () => {
  const boundaries = appendConversationForkBoundary(
    threadWith(
      [userMessage("user-completed", null), userMessage("user-active", null)],
      [
        {
          turnId: null,
          conversationTurnCount: 0,
          userMessageId: null,
          assistantMessageId: null,
          completedAt: at,
          checkpointTurnCount: null,
          checkpointStatus: null,
        },
      ],
    ),
    {
      turnId: TurnId.make("turn-completed"),
      assistantMessageId: null,
      completedAt: at,
      checkpointTurnCount: null,
      checkpointStatus: null,
    },
  );

  expect(boundaries.at(-1)?.userMessageId).toBe(MessageId.make("user-completed"));
});

it("never reuses imported baseline messages for a new post-fork turn", () => {
  const baselineTurnId = TurnId.make("baseline-turn");
  const boundaries = appendConversationForkBoundary(
    threadWith(
      [
        userMessage("imported-old", "baseline-turn"),
        userMessage("imported-latest", "baseline-turn"),
        userMessage("new-user", null),
      ],
      [
        {
          turnId: baselineTurnId,
          conversationTurnCount: 0,
          userMessageId: MessageId.make("imported-latest"),
          assistantMessageId: null,
          completedAt: at,
          checkpointTurnCount: null,
          checkpointStatus: null,
        },
      ],
    ),
    {
      turnId: TurnId.make("new-turn"),
      assistantMessageId: null,
      completedAt: at,
      checkpointTurnCount: null,
      checkpointStatus: null,
    },
  );

  expect(boundaries.at(-1)?.userMessageId).toBe(MessageId.make("new-user"));
});
