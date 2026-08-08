import { isForkBaselineBoundary } from "@t3tools/contracts";
import type {
  OrchestrationForkBoundary,
  OrchestrationThread,
  ThreadForkedPayload,
  TurnId,
} from "@t3tools/contracts";

export function forkBaselineBoundary(payload: ThreadForkedPayload): OrchestrationForkBoundary {
  return {
    turnId: payload.baselineTurnId,
    conversationTurnCount: 0,
    userMessageId: payload.baselineUserMessageId,
    assistantMessageId: payload.baselineAssistantMessageId,
    completedAt: payload.createdAt,
    checkpointTurnCount: payload.sourceCheckpointTurnCount === null ? null : 0,
    checkpointStatus: payload.sourceCheckpointTurnCount === null ? null : "ready",
  };
}

export function appendConversationForkBoundary(
  thread: OrchestrationThread,
  input: {
    readonly turnId: TurnId;
    readonly assistantMessageId: OrchestrationForkBoundary["assistantMessageId"];
    readonly completedAt: string;
    readonly checkpointTurnCount: OrchestrationForkBoundary["checkpointTurnCount"];
    readonly checkpointStatus: OrchestrationForkBoundary["checkpointStatus"];
  },
): ReadonlyArray<OrchestrationForkBoundary> {
  const existing = thread.conversationForkBoundaries ?? [];
  if (existing.some((boundary) => boundary.turnId === input.turnId)) {
    return existing.map((boundary) =>
      boundary.turnId === input.turnId
        ? {
            ...boundary,
            assistantMessageId: input.assistantMessageId,
            completedAt: input.completedAt,
            checkpointTurnCount: input.checkpointTurnCount,
            checkpointStatus: input.checkpointStatus,
          }
        : boundary,
    );
  }

  const boundaries =
    existing.length > 0
      ? existing
      : [
          {
            turnId: null,
            conversationTurnCount: 0,
            userMessageId: null,
            assistantMessageId: null,
            completedAt: thread.createdAt,
            checkpointTurnCount: null,
            checkpointStatus: null,
          } satisfies OrchestrationForkBoundary,
        ];
  const claimedUserMessageIds = new Set(
    boundaries.flatMap((boundary) =>
      boundary.userMessageId === null ? [] : [boundary.userMessageId],
    ),
  );
  const baselineTurnIds = new Set(
    boundaries.flatMap((boundary) => (isForkBaselineBoundary(boundary) ? [boundary.turnId] : [])),
  );
  const eligibleUserMessages = thread.messages.filter(
    (message) =>
      message.role === "user" &&
      !claimedUserMessageIds.has(message.id) &&
      (message.turnId === null || !baselineTurnIds.has(message.turnId)),
  );
  const exactUserMessage = eligibleUserMessages.find((message) => message.turnId === input.turnId);
  const assistantIndex = thread.messages.findIndex(
    (message) => message.id === input.assistantMessageId,
  );
  const userBeforeAssistant =
    assistantIndex < 0
      ? undefined
      : eligibleUserMessages.findLast(
          (message) => thread.messages.indexOf(message) < assistantIndex,
        );
  const userMessage = exactUserMessage ?? userBeforeAssistant ?? eligibleUserMessages[0];
  const conversationTurnCount =
    Math.max(...boundaries.map((boundary) => boundary.conversationTurnCount)) + 1;
  return [
    ...boundaries,
    {
      turnId: input.turnId,
      conversationTurnCount,
      userMessageId: userMessage?.id ?? null,
      assistantMessageId: input.assistantMessageId,
      completedAt: input.completedAt,
      checkpointTurnCount: input.checkpointTurnCount,
      checkpointStatus: input.checkpointStatus,
    },
  ];
}
