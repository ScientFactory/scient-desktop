import type { MessageId, OrchestrationForkBoundary, ThreadId } from "@t3tools/contracts";

/**
 * Server-owned fork decision evidence produced by the SQL boundary resolver
 * and required by the pure fork decider.
 */
export interface ResolvedForkBoundaries {
  readonly originThreadId: ThreadId;
  readonly sourceAssistantMessageId: MessageId;
  /** All authoritative boundaries for the origin thread, ordered by turn count. */
  readonly boundaries: ReadonlyArray<OrchestrationForkBoundary>;
  /** The exact boundary matching the clicked completed assistant response. */
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
  return selectedBoundary === null ? null : { ...input, selectedBoundary };
}
