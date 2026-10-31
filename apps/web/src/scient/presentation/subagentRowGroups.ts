import type { AgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";

const EMPTY_SUBAGENT_WORKFLOW_IDS: ReadonlyMap<string, string> = new Map();
const subagentWorkflowIdsCache = new WeakMap<
  AgentPanelModel["workflows"],
  ReadonlyMap<string, string>
>();

/**
 * The workflow each subagent (and each workflow itself) belongs to. Cached per
 * workflows array: row derivation compares its inputs by identity.
 */
export function subagentWorkflowIdsFor(
  model: AgentPanelModel | undefined,
): ReadonlyMap<string, string> {
  if (!model || model.workflows.length === 0) return EMPTY_SUBAGENT_WORKFLOW_IDS;
  const cached = subagentWorkflowIdsCache.get(model.workflows);
  if (cached) return cached;
  const ids = new Map(
    model.workflows.flatMap((group) => [
      [group.workflow.id, group.workflow.id] as const,
      ...group.phases
        .flatMap((phase) => phase.members)
        .map((member) => [member.id, group.workflow.id] as const),
      ...group.unphasedMembers.map((member) => [member.id, group.workflow.id] as const),
    ]),
  );
  subagentWorkflowIdsCache.set(model.workflows, ids);
  return ids;
}

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
