import type {
  OrchestrationV2ContextTransfer,
  OrchestrationV2ForkInitialization,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

/** Resolve only exact causal facts, never a title, provider equality, or an ancestor query. */
export function resolveForkInitialization(
  item: OrchestrationV2TurnItem,
  transfers?: ReadonlyArray<OrchestrationV2ContextTransfer>,
): OrchestrationV2ForkInitialization | undefined {
  if (item.type !== "handoff") return undefined;
  const origin = item.inheritedFrom ?? item;
  const proof = item.forkInitialization;
  if (proof !== undefined) {
    return proof.contextHandoffId === item.contextHandoffId &&
      proof.threadId === origin.threadId &&
      proof.runId === origin.runId
      ? proof
      : undefined;
  }
  // Older local rows can be qualified at the moment they are frozen. Already
  // copied rows without a cause remain visible; no live ancestor is consulted.
  if (item.inheritedFrom !== undefined || item.runId === null) return undefined;
  const transfer = transfers?.find(
    (candidate) =>
      candidate.type === "fork" &&
      candidate.targetThreadId === item.threadId &&
      candidate.targetRunId === item.runId &&
      candidate.resolution?.strategy === "portable_context" &&
      candidate.resolution.contextHandoffId === item.contextHandoffId,
  );
  return transfer === undefined
    ? undefined
    : {
        transferId: transfer.id,
        contextHandoffId: item.contextHandoffId,
        threadId: item.threadId,
        runId: item.runId,
      };
}
