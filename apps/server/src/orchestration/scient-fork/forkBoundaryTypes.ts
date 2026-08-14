import type { MessageId, OrchestrationForkBoundary, ThreadId, TurnId } from "@t3tools/contracts";

/**
 * Server-owned fork decision evidence produced by the SQL boundary resolver
 * and required by the pure fork decider.
 */
export interface ResolvedForkBoundaries {
  readonly originThreadId: ThreadId;
  readonly forkPoint:
    | { readonly kind: "assistant-response"; readonly messageId: MessageId }
    | { readonly kind: "user-message"; readonly messageId: MessageId };
  /** All authoritative boundaries for the origin thread, ordered by turn count. */
  readonly boundaries: ReadonlyArray<OrchestrationForkBoundary>;
  /** The retained completed boundary at or immediately before the fork point. */
  readonly selectedBoundary: OrchestrationForkBoundary;
}

export function resolveForkBoundariesFromList(input: {
  readonly originThreadId: ThreadId;
  readonly sourceAssistantMessageId: MessageId;
  readonly boundaries: ReadonlyArray<OrchestrationForkBoundary>;
}): ResolvedForkBoundaries | null {
  const selectedBoundary =
    input.boundaries.find(
      (boundary) => boundary.assistantMessageId === input.sourceAssistantMessageId,
    ) ?? null;
  return selectedBoundary === null
    ? null
    : {
        originThreadId: input.originThreadId,
        forkPoint: { kind: "assistant-response", messageId: input.sourceAssistantMessageId },
        boundaries: input.boundaries,
        selectedBoundary,
      };
}

export function resolveUserForkBoundariesFromList(input: {
  readonly originThreadId: ThreadId;
  readonly sourceUserMessageId: MessageId;
  readonly sourceUserCreatedAt: string;
  readonly orderedTurns: ReadonlyArray<{
    readonly turnId: TurnId;
    readonly userMessageId: MessageId | null;
    readonly requestedAt: string;
  }>;
  readonly boundaries: ReadonlyArray<OrchestrationForkBoundary>;
}): ResolvedForkBoundaries | null {
  // A completed copied or native turn exposes the user message directly on
  // its logical boundary. Forking from that message keeps the preceding
  // boundary and stages the clicked message as an unsent composer draft.
  const completedBoundaryIndex = input.boundaries.findIndex(
    (boundary) => boundary.userMessageId === input.sourceUserMessageId,
  );
  if (completedBoundaryIndex >= 0) {
    const selectedBoundary = input.boundaries[completedBoundaryIndex - 1];
    if (selectedBoundary === undefined) return null;
    return {
      originThreadId: input.originThreadId,
      forkPoint: { kind: "user-message", messageId: input.sourceUserMessageId },
      boundaries: input.boundaries,
      selectedBoundary,
    };
  }

  const selectedTurnIndex = input.orderedTurns.findIndex(
    (turn) => turn.userMessageId === input.sourceUserMessageId,
  );

  const turnIndexById = new Map(
    input.orderedTurns.map((turn, index) => [turn.turnId, index] as const),
  );
  const selectedBoundary = input.boundaries.findLast((boundary) => {
    if (boundary.conversationTurnCount === 0 && boundary.assistantMessageId === null) {
      return true;
    }
    if (boundary.turnId === null) return false;
    const boundaryTurnIndex = turnIndexById.get(boundary.turnId);
    if (boundaryTurnIndex === undefined) return false;
    if (selectedTurnIndex >= 0) return boundaryTurnIndex < selectedTurnIndex;
    // Some historical projections did not associate the pending user message
    // with its turn. Their authoritative requested timestamp still lets us
    // exclude the selected turn and everything after it. Equal timestamps are
    // treated conservatively as not-before so an answer is never retained by
    // accident.
    return input.orderedTurns[boundaryTurnIndex]!.requestedAt < input.sourceUserCreatedAt;
  });
  if (selectedBoundary === undefined) return null;

  return {
    originThreadId: input.originThreadId,
    forkPoint: { kind: "user-message", messageId: input.sourceUserMessageId },
    boundaries: input.boundaries,
    selectedBoundary,
  };
}
