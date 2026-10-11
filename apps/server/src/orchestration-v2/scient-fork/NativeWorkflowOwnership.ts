/** A native workflow coordinator owned by the live root run also owns its runless
 * member rows. An authoritative resume may transfer the coordinator to a later run,
 * which revokes every row this run tracked for it. */
import {
  isOrchestrationV2WorkActive,
  type NodeId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
  type ProviderTurnId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import type {
  ProviderEventRouteIdentity,
  ProviderEventRoutingState,
} from "../RunExecutionService.ts";

type SubagentUpdatedEvent = Extract<ProviderAdapterV2Event, { readonly type: "subagent.updated" }>;

/** An accepted runless workflow member's own node, exactly as its member row describes it. */
export function isWorkflowMemberNode(
  node: OrchestrationV2ExecutionNode,
  member: OrchestrationV2Subagent | undefined,
  driver: ProviderDriverKind,
): boolean {
  return (
    member !== undefined &&
    driver === member.driver &&
    node.threadId === member.threadId &&
    node.runId === null &&
    node.parentNodeId === member.parentNodeId &&
    node.rootNodeId === member.parentNodeId &&
    node.status === member.status &&
    node.kind === "subagent" &&
    !node.countsForRun &&
    node.providerThreadId === null &&
    node.providerTurnId === null &&
    node.nativeItemRef === null &&
    node.runtimeRequestId === null &&
    node.checkpointScopeId === null
  );
}

/** Runless workflow members belong only to their exact strong native coordinator. */
export function isWorkflowMemberOwnedBy(
  task: OrchestrationV2Subagent,
  coordinator: OrchestrationV2Subagent | undefined,
  driver: ProviderDriverKind,
): boolean {
  return (
    coordinator !== undefined &&
    coordinator.presentation?.kind === "workflow" &&
    coordinator.origin === "provider_native" &&
    coordinator.nativeTaskRef?.driver === coordinator.driver &&
    coordinator.nativeTaskRef.strength === "strong" &&
    task.id !== coordinator.id &&
    task.parentNodeId === coordinator.id &&
    task.presentation?.kind === "workflow_agent" &&
    task.presentation.workflowId === coordinator.id &&
    task.threadId === coordinator.threadId &&
    task.runId === null &&
    task.origin === "provider_native" &&
    task.driver === coordinator.driver &&
    driver === coordinator.driver &&
    task.providerInstanceId === coordinator.providerInstanceId &&
    task.childThreadId === null &&
    task.providerThreadId === null &&
    task.nativeTaskRef === null &&
    (isOrchestrationV2WorkActive(coordinator.status) || !isOrchestrationV2WorkActive(task.status))
  );
}

/** Route a subagent row, tracking native workflow coordinators and their runless members. */
export function routeWorkflowSubagentEvent(
  event: SubagentUpdatedEvent,
  input: ProviderEventRouteIdentity,
  state: ProviderEventRoutingState,
  ownership: { readonly ownsRun: boolean; readonly ownsChildThread: boolean },
): readonly [boolean, ProviderEventRoutingState] {
  const task = event.subagent;
  const belongs = ownership.ownsRun || ownership.ownsChildThread;
  const nativeWorkflow =
    task.presentation?.kind === "workflow" &&
    task.origin === "provider_native" &&
    task.nativeTaskRef?.strength === "strong" &&
    task.nativeTaskRef.driver === task.driver &&
    event.driver === task.driver &&
    task.driver === input.driver &&
    task.providerInstanceId === input.providerInstanceId;
  if (nativeWorkflow && task.threadId === input.threadId) {
    const coordinators = new Map(state.workflowCoordinators);
    const members = new Map(state.workflowMembers);
    const previous = coordinators.get(task.id);
    const ownedThreadIds = new Set(state.ownedThreadIds);
    const ownedProviderThreadIds = new Set(state.ownedProviderThreadIds);
    if (
      ownership.ownsRun &&
      (previous === undefined ||
        (previous.nativeTaskRef?.nativeId === task.nativeTaskRef?.nativeId &&
          previous.providerInstanceId === task.providerInstanceId &&
          previous.driver === task.driver))
    ) {
      coordinators.set(task.id, task);
    } else if (
      previous?.nativeTaskRef?.nativeId === task.nativeTaskRef?.nativeId &&
      previous?.providerInstanceId === task.providerInstanceId &&
      previous?.driver === task.driver
    ) {
      // An authoritative resume may transfer this task to a later run.
      coordinators.delete(task.id);
      if (previous.childThreadId !== null && previous.childThreadId !== input.threadId) {
        ownedThreadIds.delete(previous.childThreadId);
      }
      if (
        previous.providerThreadId !== null &&
        previous.providerThreadId !== input.providerThreadId
      ) {
        ownedProviderThreadIds.delete(previous.providerThreadId);
      }
      for (const [id, member] of members) {
        if (member.parentNodeId === task.id) members.delete(id);
      }
    }
    return [
      belongs,
      {
        ...state,
        ownedThreadIds,
        ownedProviderThreadIds,
        workflowCoordinators: coordinators,
        workflowMembers: members,
      },
    ];
  }
  if (belongs) return [true, state];
  const coordinator =
    task.parentNodeId === null ? undefined : state.workflowCoordinators.get(task.parentNodeId);
  const memberOwned = isWorkflowMemberOwnedBy(task, coordinator, event.driver);
  return memberOwned
    ? [true, { ...state, workflowMembers: new Map(state.workflowMembers).set(task.id, task) }]
    : [false, state];
}

export interface RevokedWorkflowOwnership {
  readonly ids: ReadonlySet<NodeId>;
  readonly threadIds: ReadonlySet<ThreadId>;
}

/** Workflow rows and child threads one routing step stopped owning. */
export function revokedWorkflowOwnership(
  state: ProviderEventRoutingState,
  next: ProviderEventRoutingState,
): RevokedWorkflowOwnership {
  const revokedIds = new Set<NodeId>([
    ...Array.from(state.workflowCoordinators.keys()).filter(
      (id) => !next.workflowCoordinators.has(id),
    ),
    ...Array.from(state.workflowMembers.keys()).filter((id) => !next.workflowMembers.has(id)),
  ]);
  const revokedThreadIds = new Set(
    Array.from(state.ownedThreadIds).filter((id) => !next.ownedThreadIds.has(id)),
  );
  return { ids: revokedIds, threadIds: revokedThreadIds };
}

interface WorkflowTrackedProjection {
  readonly subagents: ReadonlyMap<NodeId, OrchestrationV2Subagent>;
  readonly turnItems: ReadonlyMap<NodeId, { readonly id: TurnItemId; readonly subagentId: NodeId }>;
  readonly childTurnItems: ReadonlyMap<TurnItemId, OrchestrationV2TurnItem>;
  readonly nodes: ReadonlyMap<NodeId, OrchestrationV2ExecutionNode>;
  readonly linkedChildThreadIds: ReadonlySet<ThreadId>;
  readonly linkedWorkflowMemberIds: ReadonlySet<NodeId>;
}

/** Stop tracking every row a transferred workflow coordinator took with it. */
export const releaseRevokedWorkflowTracking = <Open extends WorkflowTrackedProjection>(
  revoked: RevokedWorkflowOwnership,
  tracked: {
    readonly openRunOwnedSubagents: Ref.Ref<Open>;
    readonly activeBackgroundTurnItems: Ref.Ref<ReadonlySet<OrchestrationV2TurnItem["id"]>>;
    readonly activeChildProviderTurns: Ref.Ref<ReadonlySet<ProviderTurnId>>;
    readonly activeChildSubagents: Ref.Ref<ReadonlySet<NodeId>>;
  },
) =>
  Effect.gen(function* () {
    const { ids: revokedIds, threadIds: revokedThreadIds } = revoked;
    const {
      openRunOwnedSubagents,
      activeBackgroundTurnItems,
      activeChildProviderTurns,
      activeChildSubagents,
    } = tracked;
    const open = yield* Ref.get(openRunOwnedSubagents);
    const revokedItemIds = new Set([
      ...Array.from(open.turnItems.values())
        .filter((item) => revokedIds.has(item.subagentId))
        .map((item) => item.id),
      ...Array.from(open.childTurnItems.values())
        .filter((item) => revokedThreadIds.has(item.threadId))
        .map((item) => item.id),
    ]);
    yield* Ref.update(
      activeBackgroundTurnItems,
      (current) => new Set(Array.from(current).filter((id) => !revokedItemIds.has(id))),
    );
    const revokedTurnIds = new Set(
      Array.from(open.nodes.values()).flatMap((node) =>
        revokedThreadIds.has(node.threadId) && node.providerTurnId !== null
          ? [node.providerTurnId]
          : [],
      ),
    );
    yield* Ref.update(
      activeChildProviderTurns,
      (current) => new Set(Array.from(current).filter((id) => !revokedTurnIds.has(id))),
    );
    yield* Ref.update(
      activeChildSubagents,
      (current) => new Set(Array.from(current).filter((id) => !revokedIds.has(id))),
    );
    yield* Ref.update(openRunOwnedSubagents, (current) => ({
      ...current,
      subagents: new Map(Array.from(current.subagents).filter(([id]) => !revokedIds.has(id))),
      nodes: new Map(
        Array.from(current.nodes).filter(
          ([id, node]) => !revokedIds.has(id) && !revokedThreadIds.has(node.threadId),
        ),
      ),
      turnItems: new Map(Array.from(current.turnItems).filter(([id]) => !revokedIds.has(id))),
      childTurnItems: new Map(
        Array.from(current.childTurnItems).filter(
          ([, item]) => !revokedThreadIds.has(item.threadId),
        ),
      ),
      linkedChildThreadIds: new Set(
        Array.from(current.linkedChildThreadIds).filter((id) => !revokedThreadIds.has(id)),
      ),
      linkedWorkflowMemberIds: new Set(
        Array.from(current.linkedWorkflowMemberIds).filter((id) => !revokedIds.has(id)),
      ),
    }));
  });
