import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";

/**
 * Which adjacent subagent rows join one group: the same source, visibility,
 * run (or, for a turnless spawn, the subagent itself), provider turn and
 * workflow in the agent panel model. Null for rows that are not subagents.
 */
export function subagentRowGroupKey(
  projectedItem: OrchestrationV2ProjectedTurnItem,
  subagentWorkflowIds: ReadonlyMap<string, string> | undefined,
): string | null {
  const { item } = projectedItem;
  if (item.type !== "subagent") return null;
  return [
    projectedItem.sourceThreadId,
    projectedItem.visibility,
    item.runId ?? (item.providerTurnId === null ? item.subagentId : "runless"),
    item.providerTurnId,
    subagentWorkflowIds?.get(item.subagentId) ?? "direct",
  ].join("\u0000");
}
