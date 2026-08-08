import type { MessageId, OrchestrationForkBoundary } from "@t3tools/contracts";

/** Maps each completed user turn to the authoritative boundary before it. */
export function mapForkBoundariesBeforeUserMessages(
  boundaries: ReadonlyArray<OrchestrationForkBoundary>,
): ReadonlyMap<MessageId, OrchestrationForkBoundary> {
  const byUserMessageId = new Map<MessageId, OrchestrationForkBoundary>();
  let previous: OrchestrationForkBoundary | null = null;
  for (const boundary of boundaries) {
    if (boundary.userMessageId !== null && previous !== null) {
      byUserMessageId.set(boundary.userMessageId, previous);
    }
    previous = boundary;
  }
  return byUserMessageId;
}
