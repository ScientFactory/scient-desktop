import type { NativeModelCapacityOwner } from "./scient-fork/NativeModelContextWindow.ts";
import { makeAssistantStreamingFilter } from "./assistantStreaming.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  isOrchestrationV2WorkActive,
  CommandId,
  type EventId,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ProviderThreadId,
  type ProviderTurnId,
  type RunAttemptId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2RuntimePolicy,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2TurnMessage,
} from "./ProviderAdapter.ts";
import { ProviderAdapterTurnStartError } from "./ProviderAdapter.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import { makeProviderFailure, makeProviderFailureTurnItem } from "./ProviderFailure.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";

export interface ProviderEventRoutingState {
  readonly ownedThreadIds: ReadonlySet<ThreadId>;
  // Set once this run's root turn ended. A child thread created after that
  // belongs to the run that is live then, so this one no longer adopts it.
  readonly rootTurnEnded: boolean;
  readonly ownedProviderThreadIds: ReadonlySet<ProviderThreadId>;
  readonly ownedProviderTurnIds: ReadonlySet<ProviderTurnId>;
  readonly inheritedBackgroundTurnItems: ReadonlyMap<TurnItemId, OrchestrationV2Run["id"]>;
  readonly rootProviderTurnId: ProviderTurnId | null;
  readonly workflowCoordinators: ReadonlyMap<NodeId, OrchestrationV2Subagent>;
  readonly workflowMembers: ReadonlyMap<NodeId, OrchestrationV2Subagent>;
}

export interface ProviderEventRouteIdentity {
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2Run["id"];
  readonly attemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
}

export interface InheritedBackgroundTurnItemRoute {
  readonly id: TurnItemId;
  readonly runId: OrchestrationV2Run["id"];
}

type ProviderTerminalEvent = Extract<ProviderAdapterV2Event, { readonly type: "turn.terminal" }>;

function isTerminalProviderTurnStatus(status: OrchestrationV2ProviderTurn["status"]): boolean {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function isSettledSubagentStatus(status: OrchestrationV2Subagent["status"]): boolean {
  return !isOrchestrationV2WorkActive(status);
}

// Turn item types whose lifecycle can outlive the root turn (background
// commands, monitors/dynamic tools, subagent rows). Ingestion must not stop
// while one of these is still non-terminal, or the late completion event is
// dropped and the item spins forever in the projection.
const isNativeStartReceiptError = Schema.is(ProviderAdapterTurnStartError);

const backgroundCapableTurnItemTypes: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "dynamic_tool",
  "subagent",
]);

function isSettledTurnItemStatus(status: OrchestrationV2TurnItem["status"]): boolean {
  return !isOrchestrationV2WorkActive(status);
}

function isSettledRunEligibleForInheritedBackground(status: OrchestrationV2Run["status"]): boolean {
  return status === "interrupted" || status === "failed" || status === "cancelled";
}

/**
 * Transfer delivery permission for exact live background items whose original
 * run no longer has a subscriber. Provider sessions are runtime containers and
 * can host multiple provider threads, so the durable provider-thread lineage is
 * the discriminator. Completed, rolled-back, and already-terminal items remain
 * excluded.
 */
export function selectInheritedBackgroundTurnItems(input: {
  readonly threadId: ThreadId;
  readonly currentProviderThreadId: ProviderThreadId;
  readonly currentRunOrdinal: number;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): ReadonlyArray<InheritedBackgroundTurnItemRoute> {
  const settledPriorRunIds = new Set(
    input.runs
      .filter(
        (run) =>
          run.threadId === input.threadId &&
          run.ordinal < input.currentRunOrdinal &&
          isSettledRunEligibleForInheritedBackground(run.status),
      )
      .map((run) => run.id),
  );
  return input.turnItems.flatMap((turnItem) =>
    turnItem.threadId === input.threadId &&
    turnItem.providerThreadId === input.currentProviderThreadId &&
    turnItem.runId !== null &&
    settledPriorRunIds.has(turnItem.runId) &&
    backgroundCapableTurnItemTypes.has(turnItem.type) &&
    !isSettledTurnItemStatus(turnItem.status)
      ? [{ id: turnItem.id, runId: turnItem.runId }]
      : [],
  );
}

type SubagentTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "subagent" }>;

type OpenRunOwnedSubagentProjection = {
  readonly subagents: ReadonlyMap<NodeId, OrchestrationV2Subagent>;
  readonly turnItems: ReadonlyMap<NodeId, SubagentTurnItem>;
  readonly childTurnItems: ReadonlyMap<TurnItemId, OrchestrationV2TurnItem>;
  readonly nodes: ReadonlyMap<NodeId, OrchestrationV2ExecutionNode>;
  /** Child threads once linked by a root-run subagent row; kept for cascade. */
  readonly linkedChildThreadIds: ReadonlySet<ThreadId>;
  /** Accepted runless workflow rows remain linked until ownership transfers. */
  readonly linkedWorkflowMemberIds: ReadonlySet<NodeId>;
};

type RunOwnedSubagentTerminalStatus = Extract<
  OrchestrationV2Subagent["status"],
  "interrupted" | "failed" | "cancelled"
>;

function isOpenExecutionNodeStatus(status: OrchestrationV2ExecutionNode["status"]): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function isRunOwnedSubagentTerminalStatus(
  status: ProviderTerminalEvent["status"],
): status is RunOwnedSubagentTerminalStatus {
  return status === "interrupted" || status === "failed" || status === "cancelled";
}

/**
 * Whether a new run takes over a subagent's child thread, so a later message
 * can resume it there. A running subagent stays with the run that launched it,
 * which keeps ingesting until it ends; taking it over too would store its
 * events twice. An interrupted, failed or cancelled one is never resumed.
 */
export function canRouteRelatedSubagent(status: OrchestrationV2Subagent["status"]): boolean {
  return status === "completed";
}

function emptyOpenRunOwnedSubagentProjection(): OpenRunOwnedSubagentProjection {
  return {
    subagents: new Map(),
    turnItems: new Map(),
    childTurnItems: new Map(),
    nodes: new Map(),
    linkedChildThreadIds: new Set(),
    linkedWorkflowMemberIds: new Set(),
  };
}

function withLinkedChildThreadId(
  current: OpenRunOwnedSubagentProjection,
  childThreadId: ThreadId | null,
): OpenRunOwnedSubagentProjection {
  if (childThreadId === null || current.linkedChildThreadIds.has(childThreadId)) {
    return current;
  }
  const linkedChildThreadIds = new Set(current.linkedChildThreadIds);
  linkedChildThreadIds.add(childThreadId);
  return { ...current, linkedChildThreadIds };
}

export function cascadeTerminalizeRunOwnedSubagents(input: {
  readonly run: OrchestrationV2Run;
  readonly open: OpenRunOwnedSubagentProjection;
  readonly status: RunOwnedSubagentTerminalStatus;
  readonly completedAt: DateTime.Utc;
  readonly allocateEventId: () => Effect.Effect<EventId, IdAllocator.IdAllocatorV2AllocationError>;
}): Effect.Effect<
  ReadonlyArray<OrchestrationV2DomainEvent>,
  IdAllocator.IdAllocatorV2AllocationError
> {
  return Effect.gen(function* () {
    const events: Array<OrchestrationV2DomainEvent> = [];
    // Prefer lifetime linkage over currently-open rows: subagent/turn-item
    // snapshots may terminalize before the linked child-thread node settles.
    const childThreadIds = new Set(input.open.linkedChildThreadIds);
    for (const item of [...input.open.subagents.values(), ...input.open.turnItems.values()]) {
      if (item.childThreadId !== null) {
        childThreadIds.add(item.childThreadId);
      }
    }
    const keys = new Set<NodeId>([
      ...input.open.subagents.keys(),
      ...input.open.turnItems.keys(),
      ...input.open.nodes.keys(),
    ]);
    for (const key of keys) {
      const subagent = input.open.subagents.get(key);
      if (subagent !== undefined && !isSettledSubagentStatus(subagent.status)) {
        events.push({
          id: yield* input.allocateEventId(),
          type: "subagent.updated",
          threadId: subagent.threadId,
          runId: input.run.id,
          nodeId: subagent.id,
          driver: subagent.driver,
          providerInstanceId: subagent.providerInstanceId,
          occurredAt: input.completedAt,
          payload: {
            ...subagent,
            status: input.status,
            completedAt: input.completedAt,
            updatedAt: input.completedAt,
          },
        });
      }
      const node = input.open.nodes.get(key);
      if (
        node !== undefined &&
        ((node.threadId === input.run.threadId &&
          (node.runId === input.run.id || input.open.linkedWorkflowMemberIds.has(node.id))) ||
          childThreadIds.has(node.threadId)) &&
        isOpenExecutionNodeStatus(node.status)
      ) {
        events.push({
          id: yield* input.allocateEventId(),
          type: "node.updated",
          threadId: node.threadId,
          runId: node.runId ?? input.run.id,
          nodeId: node.id,
          providerInstanceId: input.run.providerInstanceId,
          occurredAt: input.completedAt,
          payload: {
            ...node,
            status: input.status,
            completedAt: input.completedAt,
          },
        });
      }
      const turnItem = input.open.turnItems.get(key);
      if (
        turnItem !== undefined &&
        turnItem.runId === input.run.id &&
        !isSettledTurnItemStatus(turnItem.status)
      ) {
        events.push({
          id: yield* input.allocateEventId(),
          type: "turn-item.updated",
          threadId: turnItem.threadId,
          runId: input.run.id,
          ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
          providerInstanceId: input.run.providerInstanceId,
          occurredAt: input.completedAt,
          payload: {
            ...turnItem,
            status: input.status,
            completedAt: input.completedAt,
            updatedAt: input.completedAt,
          },
        });
      }
    }
    for (const turnItem of input.open.childTurnItems.values()) {
      if (!childThreadIds.has(turnItem.threadId) || isSettledTurnItemStatus(turnItem.status)) {
        continue;
      }
      events.push({
        id: yield* input.allocateEventId(),
        type: "turn-item.updated",
        threadId: turnItem.threadId,
        runId: turnItem.runId ?? input.run.id,
        ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: input.completedAt,
        payload: {
          ...turnItem,
          ...("streaming" in turnItem ? { streaming: false } : {}),
          status: input.status,
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        },
      });
    }
    return events;
  });
}

export function finalProviderThreadStatus(
  disposition: ProviderTerminalEvent["threadDisposition"],
): OrchestrationV2ProviderThread["status"] {
  return disposition === "broken" ? "error" : "idle";
}

export function makeProviderEventRoutingState(input: {
  readonly identity: ProviderEventRouteIdentity;
  readonly inheritedBackgroundTurnItems?: ReadonlyArray<InheritedBackgroundTurnItemRoute>;
  readonly providerTurnId: ProviderTurnId | null;
  readonly relatedThreadIds?: ReadonlyArray<ThreadId>;
  readonly relatedProviderThreadIds?: ReadonlyArray<ProviderThreadId>;
}): ProviderEventRoutingState {
  return {
    ownedThreadIds: new Set([input.identity.threadId, ...(input.relatedThreadIds ?? [])]),
    rootTurnEnded: false,
    ownedProviderThreadIds: new Set([
      input.identity.providerThreadId,
      ...(input.relatedProviderThreadIds ?? []),
    ]),
    ownedProviderTurnIds:
      input.providerTurnId === null ? new Set() : new Set([input.providerTurnId]),
    inheritedBackgroundTurnItems: new Map(
      (input.inheritedBackgroundTurnItems ?? []).map((item) => [item.id, item.runId]),
    ),
    rootProviderTurnId: input.providerTurnId,
    workflowCoordinators: new Map(),
    workflowMembers: new Map(),
  };
}

export function routeProviderEvent(
  event: ProviderAdapterV2Event,
  input: ProviderEventRouteIdentity,
  state: ProviderEventRoutingState,
): readonly [boolean, ProviderEventRoutingState] {
  const ownsThread = (threadId: ThreadId): boolean => state.ownedThreadIds.has(threadId);
  const ownsChildThread = (threadId: ThreadId): boolean =>
    threadId !== input.threadId && ownsThread(threadId);
  const ownsRun = (runId: string | null): boolean => runId === input.runId;
  const addProviderThread = (providerThreadId: ProviderThreadId): ProviderEventRoutingState => ({
    ...state,
    ownedProviderThreadIds: new Set([...state.ownedProviderThreadIds, providerThreadId]),
  });
  const addProviderTurn = (
    providerTurnId: ProviderTurnId,
    root: boolean,
  ): ProviderEventRoutingState => ({
    ...state,
    ownedProviderTurnIds: new Set([...state.ownedProviderTurnIds, providerTurnId]),
    rootProviderTurnId: root ? providerTurnId : state.rootProviderTurnId,
  });

  switch (event.type) {
    case "authentication.invalidated":
      // Only the trusted session manager may mutate the instance auth overlay.
      return [false, state];
    case "provider_session.updated":
      // The session manager persists process-wide status once for every
      // attached app thread before broadcasting the adapter event.
      return [false, state];
    case "app_thread.created": {
      if (event.appThread.id === input.threadId) {
        return [true, state];
      }
      const isOwnedSubagent =
        !state.rootTurnEnded &&
        event.appThread.lineage.relationshipToParent === "subagent" &&
        event.appThread.lineage.parentThreadId !== null &&
        ownsThread(event.appThread.lineage.parentThreadId);
      if (!isOwnedSubagent) {
        return [false, state];
      }
      return [
        true,
        {
          ...state,
          ownedThreadIds: new Set([...state.ownedThreadIds, event.appThread.id]),
        },
      ];
    }
    case "provider_thread.updated": {
      const belongs =
        state.ownedProviderThreadIds.has(event.providerThread.id) ||
        (event.providerThread.appThreadId !== null && ownsThread(event.providerThread.appThreadId));
      return belongs ? [true, addProviderThread(event.providerThread.id)] : [false, state];
    }
    case "provider_turn.updated": {
      const isRoot = event.providerTurn.runAttemptId === input.attemptId;
      const belongs =
        isRoot ||
        (event.providerTurn.providerThreadId !== input.providerThreadId &&
          state.ownedProviderThreadIds.has(event.providerTurn.providerThreadId)) ||
        state.ownedProviderTurnIds.has(event.providerTurn.id) ||
        (event.threadId !== undefined && ownsChildThread(event.threadId));
      return belongs ? [true, addProviderTurn(event.providerTurn.id, isRoot)] : [false, state];
    }
    case "node.updated": {
      const member = state.workflowMembers.get(event.node.id);
      const workflowMemberNode =
        member !== undefined &&
        event.driver === member.driver &&
        event.node.threadId === member.threadId &&
        event.node.runId === null &&
        event.node.parentNodeId === member.parentNodeId &&
        event.node.rootNodeId === member.parentNodeId &&
        event.node.status === member.status &&
        event.node.kind === "subagent" &&
        !event.node.countsForRun &&
        event.node.providerThreadId === null &&
        event.node.providerTurnId === null &&
        event.node.nativeItemRef === null &&
        event.node.runtimeRequestId === null &&
        event.node.checkpointScopeId === null;
      const belongs =
        ownsRun(event.node.runId) || ownsChildThread(event.node.threadId) || workflowMemberNode;
      if (!belongs || event.node.providerThreadId === null) {
        return [belongs, state];
      }
      return [true, addProviderThread(event.node.providerThreadId)];
    }
    case "subagent.updated": {
      const task = event.subagent;
      const belongs = ownsRun(task.runId) || ownsChildThread(task.threadId);
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
          ownsRun(task.runId) &&
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
      const memberOwned =
        coordinator !== undefined &&
        task.id !== coordinator.id &&
        task.presentation?.kind === "workflow_agent" &&
        task.presentation.workflowId === coordinator.id &&
        task.threadId === coordinator.threadId &&
        task.runId === null &&
        task.origin === "provider_native" &&
        task.driver === coordinator.driver &&
        event.driver === coordinator.driver &&
        task.providerInstanceId === coordinator.providerInstanceId &&
        task.childThreadId === null &&
        task.providerThreadId === null &&
        task.nativeTaskRef === null &&
        (!isSettledSubagentStatus(coordinator.status) || isSettledSubagentStatus(task.status));
      return memberOwned
        ? [true, { ...state, workflowMembers: new Map(state.workflowMembers).set(task.id, task) }]
        : [false, state];
    }
    case "message.updated":
      return [ownsRun(event.message.runId) || ownsChildThread(event.message.threadId), state];
    case "turn_item.updated": {
      if (ownsRun(event.turnItem.runId) || ownsChildThread(event.turnItem.threadId)) {
        return [true, state];
      }
      const inheritedRunId = state.inheritedBackgroundTurnItems.get(event.turnItem.id);
      // Preserve the item's original ownership while allowing the one live run
      // to deliver an exact carryover identity selected from the projection.
      const isInheritedBackgroundItem =
        event.turnItem.threadId === input.threadId &&
        event.turnItem.runId !== null &&
        event.turnItem.runId === inheritedRunId &&
        backgroundCapableTurnItemTypes.has(event.turnItem.type);
      if (!isInheritedBackgroundItem) {
        return [false, state];
      }
      if (!isSettledTurnItemStatus(event.turnItem.status)) {
        return [true, state];
      }
      const inheritedBackgroundTurnItems = new Map(state.inheritedBackgroundTurnItems);
      inheritedBackgroundTurnItems.delete(event.turnItem.id);
      return [true, { ...state, inheritedBackgroundTurnItems }];
    }
    case "plan.updated":
      return [ownsRun(event.plan.runId) || ownsChildThread(event.plan.threadId), state];
    case "runtime_request.updated":
      return [
        (event.threadId !== undefined && ownsChildThread(event.threadId)) ||
          (event.runtimeRequest.providerTurnId !== null &&
            state.ownedProviderTurnIds.has(event.runtimeRequest.providerTurnId)),
        state,
      ];
    case "turn.terminal":
      return event.providerTurnId === state.rootProviderTurnId
        ? [true, { ...state, rootTurnEnded: true }]
        : [false, state];
  }
}

/**
 * ERRORS
 */
export class RunExecutionStartError extends Schema.TaggedError<RunExecutionStartError>()(
  "RunExecutionStartError",
  {
    commandId: CommandId,
    runId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to start orchestration V2 run execution ${this.runId}.`;
  }
}

export class RunExecutionIngestError extends Schema.TaggedError<RunExecutionIngestError>()(
  "RunExecutionIngestError",
  {
    runId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed while ingesting orchestration V2 run execution ${this.runId}.`;
  }
}

export const RunExecutionServiceV2Error = Schema.Union([
  RunExecutionStartError,
  RunExecutionIngestError,
]);
export type RunExecutionServiceV2Error = typeof RunExecutionServiceV2Error.Type;

/**
 * SERVICE DEFINITION
 */
type RunTerminalOutcome =
  | ProviderTerminalEvent
  | {
      readonly driver: ProviderDriverKind;
      readonly status: "interrupted";
      readonly failure: null;
      readonly threadDisposition: ProviderTerminalEvent["threadDisposition"];
    };

export interface RunExecutionServiceV2StartRootRunInput {
  readonly commandId: CommandId;
  readonly appThread: OrchestrationV2AppThread;
  readonly providerSessionId: ProviderSessionId;
  readonly session: ProviderAdapterV2SessionRuntime;
  readonly nativeModelCapacityOwner?: NativeModelCapacityOwner;
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly checkpointScope: OrchestrationV2CheckpointScope;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly attempt: OrchestrationV2RunAttempt;
  readonly attemptId: RunAttemptId;
  readonly providerTurnOrdinal: number;
  readonly loadInheritedBackgroundTurnItems?: () => Effect.Effect<
    ReadonlyArray<InheritedBackgroundTurnItemRoute>,
    unknown
  >;
  readonly relatedThreadIds?: ReadonlyArray<ThreadId>;
  readonly relatedProviderThreadIds?: ReadonlyArray<ProviderThreadId>;
  readonly shouldStartProviderTurn?: () => Effect.Effect<boolean, never>;
  readonly cancelBeforeProviderTurn?: () => Effect.Effect<
    EventSink.PendingStartOwner | undefined,
    unknown
  >;
  readonly shouldFinalizeRun?: () => Effect.Effect<boolean, never>;
  readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
  readonly message: ProviderAdapterV2TurnMessage;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
}

export interface RunExecutionServiceV2Shape {
  readonly startRootRun: (
    input: RunExecutionServiceV2StartRootRunInput,
  ) => Effect.Effect<void, RunExecutionServiceV2Error>;
}

export class RunExecutionServiceV2 extends Context.Service<
  RunExecutionServiceV2,
  RunExecutionServiceV2Shape
>()("t3/orchestration-v2/RunExecutionService/RunExecutionServiceV2") {}

/**
 * IMPLEMENTATIONS
 */
export const layer: Layer.Layer<
  RunExecutionServiceV2,
  never,
  | CheckpointService.CheckpointServiceV2
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProviderEventIngestor.ProviderEventIngestorV2
  | ServerSettings.ServerSettingsService
> = Layer.effect(
  RunExecutionServiceV2,
  Effect.gen(function* () {
    const checkpointService = yield* CheckpointService.CheckpointServiceV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const providerEventIngestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const finalizationObserver = yield* RunFinalizationService.RunFinalizationObserver;

    const writeFinalRunEvents = (input: {
      readonly run: OrchestrationV2Run;
      readonly rootNode: OrchestrationV2ExecutionNode;
      readonly checkpointScope: OrchestrationV2CheckpointScope;
      readonly providerThread: OrchestrationV2ProviderThread;
      readonly attempt: OrchestrationV2RunAttempt;
      readonly shouldFinalizeRun?: () => Effect.Effect<boolean, never>;
      readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
      readonly openRunOwnedSubagents?: OpenRunOwnedSubagentProjection;
      readonly terminal: RunTerminalOutcome;
      readonly preserveProviderThread?: boolean;
      readonly pendingStartOwner?: EventSink.PendingStartOwner;
      readonly failedStartReceipt?: OrchestrationV2ProviderTurn;
      readonly failureItemPersisted: boolean;
      readonly refreshAfterTurn: Effect.Effect<void>;
      readonly writeIfRunCurrent?: {
        readonly activeAttemptId: RunAttemptId;
        readonly expectedStatus: OrchestrationV2Run["status"];
      };
    }) =>
      Effect.gen(function* () {
        const completedAt = yield* DateTime.now;
        const finalizedAttempt: OrchestrationV2RunAttempt | null = {
          ...input.attempt,
          status: input.terminal.status,
          completedAt,
        };
        const shouldFinalizeRun =
          input.shouldFinalizeRun === undefined ? true : yield* input.shouldFinalizeRun();
        if (!shouldFinalizeRun) {
          // Superseded attempt (steer / selection restart). Emit
          // run_interrupt_result only when hard Stop left an unpaired request
          // for this run; plain steers and already-paired stops emit nothing.
          if (input.terminal.status === "interrupted") {
            const hasUnpairedRequest =
              input.hasUnpairedRunInterruptRequest === undefined
                ? false
                : yield* input.hasUnpairedRunInterruptRequest();
            if (hasUnpairedRequest) {
              yield* eventSink.writeWithEffects({
                effects: [],
                events: [
                  {
                    id: yield* idAllocator.allocate.event({ threadId: input.run.threadId }),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: makeInterruptResultTurnItem({
                      idAllocator,
                      run: input.run,
                      rootNode: input.rootNode,
                      providerThread: input.providerThread,
                      completedAt,
                    }),
                  },
                ],
              });
              yield* input.refreshAfterTurn;
            }
          }
          return false;
        }
        const allocateEventId = () => idAllocator.allocate.event({ threadId: input.run.threadId });
        const open = input.openRunOwnedSubagents ?? emptyOpenRunOwnedSubagentProjection();
        const hasOpenSubagentProjection =
          open.subagents.size > 0 ||
          open.turnItems.size > 0 ||
          open.childTurnItems.size > 0 ||
          open.nodes.size > 0;
        const cascadedSubagentEvents =
          isRunOwnedSubagentTerminalStatus(input.terminal.status) && hasOpenSubagentProjection
            ? yield* cascadeTerminalizeRunOwnedSubagents({
                run: input.run,
                open,
                status: input.terminal.status,
                completedAt,
                allocateEventId,
              })
            : [];
        const persistedStatus =
          input.terminal.status === "completed" ? "waiting" : input.terminal.status;
        // Completion cohorts are advanced by Orchestrator while a provider
        // turn is in flight. Do not replay the run snapshot captured at start
        // over a newer acknowledgement, successor, or Stop barrier.
        const { delegatedCompletion: _delegatedCompletion, ...runWithoutDelegatedCompletion } =
          input.run;
        const finalizedRun: OrchestrationV2Run = {
          ...runWithoutDelegatedCompletion,
          status: persistedStatus,
          ...(input.terminal.status === "completed" ? { queuePosition: null } : {}),
          completedAt: input.terminal.status === "completed" ? null : completedAt,
        };
        const finalizedRootNode: OrchestrationV2ExecutionNode = {
          ...input.rootNode,
          status: persistedStatus,
          completedAt: input.terminal.status === "completed" ? null : completedAt,
          checkpointScopeId: input.checkpointScope.id,
        };
        const finalizedProviderThread: OrchestrationV2ProviderThread = {
          ...input.providerThread,
          status: finalProviderThreadStatus(input.terminal.threadDisposition),
          updatedAt: completedAt,
        };
        const runEventId = yield* allocateEventId();
        const nodeEventId = yield* allocateEventId();
        const providerThreadEventId = yield* allocateEventId();
        const checkpointCaptureCommandId = CommandId.make(
          `command:effect:checkpoint.capture:${input.run.id}`,
        );
        // Stopped runs capture too: their checkpoint is the rollback point for
        // the next message. The capture is enqueued with these terminal events,
        // ahead of any later run's start on this thread's effect lane.
        const finalization = {
          effects:
            input.terminal.status === "completed" ||
            input.terminal.status === "interrupted" ||
            input.terminal.status === "cancelled"
              ? [
                  {
                    id: `effect:checkpoint.capture:${input.run.id}`,
                    commandId: checkpointCaptureCommandId,
                    threadId: input.run.threadId,
                    request: {
                      type: "checkpoint.capture" as const,
                      runId: input.run.id,
                      scopeId: input.checkpointScope.id,
                    },
                  },
                ]
              : [],
          events: [
            ...(input.failedStartReceipt === undefined
              ? []
              : [
                  {
                    id: yield* allocateEventId(),
                    type: "provider-turn.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: {
                      ...input.failedStartReceipt,
                      status: "failed" as const,
                      completedAt,
                    },
                  },
                ]),
            // Terminalize open run-owned subagent rows before the root run
            // settles so projections never keep a forever-running subagent card.
            ...cascadedSubagentEvents,
            ...(finalizedAttempt === null
              ? []
              : [
                  {
                    id: yield* allocateEventId(),
                    type: "run-attempt.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: finalizedAttempt,
                  },
                ]),
            ...(input.terminal.status === "interrupted"
              ? [
                  {
                    id: yield* allocateEventId(),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: makeInterruptResultTurnItem({
                      idAllocator,
                      run: input.run,
                      rootNode: input.rootNode,
                      providerThread: input.providerThread,
                      completedAt,
                    }),
                  },
                ]
              : []),
            ...(input.terminal.status === "failed" && !input.failureItemPersisted
              ? [
                  {
                    id: yield* allocateEventId(),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: makeProviderFailureTurnItem({
                      idAllocator,
                      driver: input.terminal.driver,
                      threadId: input.run.threadId,
                      runId: input.run.id,
                      nodeId: input.rootNode.id,
                      providerThreadId: input.terminal.providerThreadId,
                      providerTurnId: input.terminal.providerTurnId,
                      itemOrdinal: input.terminal.failureItemOrdinal,
                      failure: input.terminal.failure,
                      occurredAt: completedAt,
                    }),
                  },
                ]
              : []),
            {
              id: runEventId,
              type: "run.updated",
              threadId: input.run.threadId,
              runId: input.run.id,
              nodeId: input.rootNode.id,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedRun,
            },
            {
              id: nodeEventId,
              type: "node.updated",
              threadId: input.run.threadId,
              runId: input.run.id,
              nodeId: input.rootNode.id,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedRootNode,
            },
            ...(input.preserveProviderThread === true
              ? []
              : [
                  {
                    id: providerThreadEventId,
                    type: "provider-thread.updated" as const,
                    threadId: input.run.threadId,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: finalizedProviderThread,
                  },
                ]),
          ],
        } satisfies Parameters<typeof eventSink.writeWithEffects>[0];
        if (input.writeIfRunCurrent !== undefined) {
          const result = yield* eventSink.writeIfRunCurrent({
            threadId: input.run.threadId,
            runId: input.run.id,
            activeAttemptId: input.writeIfRunCurrent.activeAttemptId,
            expectedStatus: input.writeIfRunCurrent.expectedStatus,
            events: finalization.events,
            ...(input.pendingStartOwner === undefined
              ? {}
              : {
                  pendingStartOwner: { ...input.pendingStartOwner, effects: finalization.effects },
                }),
          });
          if (!result.committed) {
            return false;
          }
        } else {
          yield* eventSink.writeWithEffects(finalization);
        }
        yield* input.refreshAfterTurn;
        return true;
      });

    return RunExecutionServiceV2.of({
      startRootRun: (input) =>
        Effect.gen(function* () {
          // Startup failure and stream shutdown can report the same attempt.
          const refreshAfterTurn = yield* Effect.cached(
            finalizationObserver.refreshAfterTurn(input.appThread.projectId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to refresh pull requests after run termination", {
                  threadId: input.run.threadId,
                  runId: input.run.id,
                  cause,
                }),
              ),
            ),
          );
          const cancelledStartOwner = yield* Ref.make<EventSink.PendingStartOwner | undefined>(
            undefined,
          );
          const cancelDeclinedStart = Effect.gen(function* () {
            const stoppedThread = yield* input.cancelBeforeProviderTurn?.() ?? Effect.void;
            if (stoppedThread === undefined) return false;
            const committed = yield* writeFinalRunEvents({
              run: input.run,
              rootNode: input.rootNode,
              checkpointScope: input.checkpointScope,
              providerThread: input.providerThread,
              preserveProviderThread: true,
              pendingStartOwner: stoppedThread,
              attempt: input.attempt,
              terminal: {
                driver: input.session.driver,
                status: "interrupted",
                failure: null,
                threadDisposition: "reusable",
              },
              failureItemPersisted: false,
              refreshAfterTurn,
              writeIfRunCurrent: { activeAttemptId: input.attemptId, expectedStatus: "running" },
            });
            if (committed) yield* Ref.set(cancelledStartOwner, stoppedThread);
            return committed;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new RunExecutionStartError({
                  commandId: input.commandId,
                  runId: input.run.id,
                  cause,
                }),
            ),
          );
          const makeFailedTerminalEvent = (
            failure: OrchestrationV2ProviderFailure,
            failureItemOrdinal: number,
          ): ProviderTerminalEvent => ({
            type: "turn.terminal",
            driver: input.providerThread.driver,
            providerThreadId: input.providerThread.id,
            providerTurnId:
              input.attempt.providerTurnId ??
              idAllocator.derive.providerTurn({
                driver: input.providerThread.driver,
                nativeTurnId: `failed:${input.attempt.id}`,
              }),
            runOrdinal: input.run.ordinal,
            failureItemOrdinal,
            status: "failed",
            failure,
            threadDisposition: "reusable",
          });
          const responseStreamingMode = yield* Effect.gen(function* () {
            const responseStreamingMode = yield* serverSettings.getSettings.pipe(
              Effect.map(
                (settings) =>
                  resolveProjectSettings(settings, input.appThread.projectId).settings
                    .responseStreamingMode,
              ),
            );
            yield* checkpointService
              .captureBaseline({
                scope: input.checkpointScope,
                ordinalWithinScope: Math.max(0, input.run.ordinal - 1),
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning(
                        "orchestration V2 checkpoint baseline capture failed; starting provider without a baseline",
                        { runId: input.run.id },
                      ),
                ),
              );
            if (
              input.shouldStartProviderTurn !== undefined &&
              !(yield* input.shouldStartProviderTurn()) &&
              input.cancelBeforeProviderTurn === undefined
            )
              return null;
            // Owned pre-receipt Stop needs its subscription before interrupting
            // retained work. The second gate still refuses every native offer.
            return responseStreamingMode;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (Cause.hasInterruptsOnly(cause)) {
                  return yield* Effect.failCause(cause);
                }
                yield* Effect.logError("orchestration V2 run preparation failed", {
                  runId: input.run.id,
                  cause,
                });
                yield* writeFinalRunEvents({
                  run: input.run,
                  rootNode: input.rootNode,
                  checkpointScope: input.checkpointScope,
                  providerThread: input.providerThread,
                  attempt: input.attempt,
                  terminal: makeFailedTerminalEvent(
                    makeProviderFailure({
                      cause: Cause.squash(cause),
                      // Keep exact underlying text in the logged cause only;
                      // the persisted turn item gets a bounded curated message.
                      message: "Run preparation failed.",
                      class: "unknown",
                    }),
                    input.providerTurnOrdinal * 100 + 1,
                  ),
                  failureItemPersisted: false,
                  refreshAfterTurn,
                  writeIfRunCurrent: {
                    activeAttemptId: input.attemptId,
                    expectedStatus: "running",
                  },
                });
                return null;
              }),
            ),
            Effect.mapError(
              (cause) =>
                new RunExecutionStartError({
                  commandId: input.commandId,
                  runId: input.run.id,
                  cause,
                }),
            ),
          );
          if (responseStreamingMode === null) {
            yield* cancelDeclinedStart;
            return;
          }
          const terminalEvent = yield* Ref.make<ProviderTerminalEvent | null>(null);
          const latestTurnItemOrdinal = yield* Ref.make(input.providerTurnOrdinal * 100);
          const latestProviderThread = yield* Ref.make(input.providerThread);
          const routeIdentity: ProviderEventRouteIdentity = {
            threadId: input.run.threadId,
            runId: input.run.id,
            attemptId: input.attempt.id,
            providerThreadId: input.providerThread.id,
            driver: input.session.driver,
            providerInstanceId: input.run.providerInstanceId,
          };
          const eventSubscription =
            input.session.subscribeEvents === undefined
              ? { events: input.session.events, close: Effect.void }
              : yield* input.session.subscribeEvents;
          const inheritedBackgroundTurnItems = yield* (
            input.loadInheritedBackgroundTurnItems?.() ?? Effect.succeed([])
          ).pipe(
            Effect.onError(() => eventSubscription.close),
            Effect.mapError(
              (cause) =>
                new RunExecutionStartError({
                  commandId: input.commandId,
                  runId: input.run.id,
                  cause,
                }),
            ),
          );
          const inheritedBackgroundTurnItemsById = new Map(
            inheritedBackgroundTurnItems.map((item) => [item.id, item.runId]),
          );
          const eventRouting = yield* Ref.make<ProviderEventRoutingState>(
            makeProviderEventRoutingState({
              identity: routeIdentity,
              inheritedBackgroundTurnItems,
              providerTurnId: input.attempt.providerTurnId,
              ...(input.relatedThreadIds === undefined
                ? {}
                : { relatedThreadIds: input.relatedThreadIds }),
              ...(input.relatedProviderThreadIds === undefined
                ? {}
                : { relatedProviderThreadIds: input.relatedProviderThreadIds }),
            }),
          );
          const rootTerminalSeen = yield* Ref.make(false);
          const rootRunFinalized = yield* Ref.make(false);
          const providerThreadOwnerLost = yield* Ref.make(false);
          const activeChildProviderTurns = yield* Ref.make<ReadonlySet<ProviderTurnId>>(new Set());
          const activeChildSubagents = yield* Ref.make<ReadonlySet<NodeId>>(new Set());
          const activeBackgroundTurnItems = yield* Ref.make<
            ReadonlySet<OrchestrationV2TurnItem["id"]>
          >(new Set(inheritedBackgroundTurnItemsById.keys()));
          const openRunOwnedSubagents = yield* Ref.make(emptyOpenRunOwnedSubagentProjection());
          const finalizeRootRun = (terminal: ProviderTerminalEvent) =>
            Effect.gen(function* () {
              if (yield* Ref.get(rootRunFinalized)) {
                return;
              }
              const providerThread = yield* Ref.get(latestProviderThread);
              const openSubagents = yield* Ref.get(openRunOwnedSubagents);
              yield* writeFinalRunEvents({
                run: input.run,
                rootNode: input.rootNode,
                checkpointScope: input.checkpointScope,
                providerThread,
                attempt: input.attempt,
                ...(input.shouldFinalizeRun === undefined
                  ? {}
                  : { shouldFinalizeRun: input.shouldFinalizeRun }),
                ...(input.hasUnpairedRunInterruptRequest === undefined
                  ? {}
                  : {
                      hasUnpairedRunInterruptRequest: input.hasUnpairedRunInterruptRequest,
                    }),
                openRunOwnedSubagents: openSubagents,
                terminal,
                failureItemPersisted: terminal.status === "failed",
                refreshAfterTurn,
              }).pipe(
                Effect.mapError(
                  (cause) => new RunExecutionIngestError({ runId: input.run.id, cause }),
                ),
              );
              if (isRunOwnedSubagentTerminalStatus(terminal.status)) {
                yield* Ref.set(openRunOwnedSubagents, emptyOpenRunOwnedSubagentProjection());
              }
              yield* Ref.set(rootRunFinalized, true);
            });
          const trackChildLifecycle = (event: ProviderAdapterV2Event, deliverable: boolean) =>
            Effect.gen(function* () {
              const routing = yield* Ref.get(eventRouting);
              if (event.type === "provider_turn.updated") {
                const isRoot =
                  event.providerTurn.runAttemptId === input.attempt.id ||
                  event.providerTurn.id === routing.rootProviderTurnId;
                if (!isRoot) {
                  yield* Ref.update(activeChildProviderTurns, (current) => {
                    const next = new Set(current);
                    if (isTerminalProviderTurnStatus(event.providerTurn.status)) {
                      next.delete(event.providerTurn.id);
                    } else {
                      next.add(event.providerTurn.id);
                    }
                    return next;
                  });
                }
              }
              if (event.type === "subagent.updated") {
                const belongsToRootRun = event.subagent.runId === input.run.id;
                const belongsToOwnedChildThread =
                  event.subagent.threadId !== input.run.threadId &&
                  routing.ownedThreadIds.has(event.subagent.threadId);
                if (belongsToRootRun || belongsToOwnedChildThread) {
                  yield* Ref.update(activeChildSubagents, (current) => {
                    const next = new Set(current);
                    if (isSettledSubagentStatus(event.subagent.status)) {
                      next.delete(event.subagent.id);
                    } else {
                      next.add(event.subagent.id);
                    }
                    return next;
                  });
                }
                // Snapshot run-owned subagents for interrupt cascade.
                // Preserve childThreadId linkage for the root-run lifetime even
                // after the subagent row terminalizes, so open child-thread
                // nodes can still be proven linked on a later root interrupt.
                if (belongsToRootRun || routing.workflowMembers.has(event.subagent.id)) {
                  yield* Ref.update(openRunOwnedSubagents, (current) => {
                    const withLink = withLinkedChildThreadId(current, event.subagent.childThreadId);
                    const subagents = new Map(withLink.subagents);
                    if (isSettledSubagentStatus(event.subagent.status)) {
                      subagents.delete(event.subagent.id);
                    } else {
                      subagents.set(event.subagent.id, event.subagent);
                    }
                    const linkedWorkflowMemberIds = new Set(withLink.linkedWorkflowMemberIds);
                    if (routing.workflowMembers.has(event.subagent.id)) {
                      linkedWorkflowMemberIds.add(event.subagent.id);
                    }
                    return { ...withLink, subagents, linkedWorkflowMemberIds };
                  });
                }
              }
              if (event.type === "node.updated") {
                const belongsToRootSubagent =
                  event.node.kind === "subagent" && event.node.runId === input.run.id;
                const belongsToOwnedChildThread =
                  event.node.threadId !== input.run.threadId &&
                  routing.ownedThreadIds.has(event.node.threadId);
                if (
                  !belongsToRootSubagent &&
                  !belongsToOwnedChildThread &&
                  !routing.workflowMembers.has(event.node.id)
                ) {
                  return;
                }
                yield* Ref.update(openRunOwnedSubagents, (current) => {
                  const nodes = new Map(current.nodes);
                  if (isOpenExecutionNodeStatus(event.node.status)) {
                    nodes.set(event.node.id, event.node);
                  } else {
                    nodes.delete(event.node.id);
                  }
                  return { ...current, nodes };
                });
              }
              if (event.type === "turn_item.updated") {
                const belongsToRootRun = event.turnItem.runId === input.run.id;
                const belongsToOwnedChildThread =
                  event.turnItem.threadId !== input.run.threadId &&
                  routing.ownedThreadIds.has(event.turnItem.threadId);
                const belongsToInheritedBackgroundItem =
                  event.turnItem.threadId === input.run.threadId &&
                  event.turnItem.runId !== null &&
                  inheritedBackgroundTurnItemsById.get(event.turnItem.id) === event.turnItem.runId;
                if (
                  backgroundCapableTurnItemTypes.has(event.turnItem.type) &&
                  (belongsToRootRun ||
                    belongsToOwnedChildThread ||
                    belongsToInheritedBackgroundItem)
                ) {
                  yield* Ref.update(activeBackgroundTurnItems, (current) => {
                    const next = new Set(current);
                    if (isSettledTurnItemStatus(event.turnItem.status)) {
                      next.delete(event.turnItem.id);
                    } else {
                      next.add(event.turnItem.id);
                    }
                    return next;
                  });
                }
                if (belongsToOwnedChildThread && deliverable) {
                  yield* Ref.update(openRunOwnedSubagents, (current) => {
                    const childTurnItems = new Map(current.childTurnItems);
                    if (isSettledTurnItemStatus(event.turnItem.status)) {
                      childTurnItems.delete(event.turnItem.id);
                    } else {
                      childTurnItems.set(event.turnItem.id, event.turnItem);
                    }
                    return { ...current, childTurnItems };
                  });
                }
                if (belongsToRootRun && event.turnItem.type === "subagent") {
                  const subagentItem = event.turnItem;
                  yield* Ref.update(openRunOwnedSubagents, (current) => {
                    const withLink = withLinkedChildThreadId(current, subagentItem.childThreadId);
                    const turnItems = new Map(withLink.turnItems);
                    if (isSettledTurnItemStatus(subagentItem.status)) {
                      turnItems.delete(subagentItem.subagentId);
                    } else {
                      turnItems.set(subagentItem.subagentId, subagentItem);
                    }
                    return { ...withLink, turnItems };
                  });
                }
              }
            });
          const shouldStopProviderEventIngestion = Effect.gen(function* () {
            if (!(yield* Ref.get(rootTerminalSeen))) {
              return false;
            }
            const terminal = yield* Ref.get(terminalEvent);
            // Non-completed terminals drop background tracking immediately.
            if (terminal !== null && terminal.status !== "completed") {
              return true;
            }
            const childProviderTurns = yield* Ref.get(activeChildProviderTurns);
            if (childProviderTurns.size > 0) {
              return false;
            }
            const childSubagents = yield* Ref.get(activeChildSubagents);
            if (childSubagents.size > 0) {
              return false;
            }
            // Keep ingesting past root settlement while background-capable
            // items owned by this run (or an owned child thread) are still
            // non-terminal, so their late completion events reach the
            // projection (stuck-spinner fix). Only for completed runs:
            // interrupted/failed turns intentionally drop background tracking
            // rather than pinning the stream open. Newly owned items depend on
            // adapters emitting a non-terminal event before the root terminal.
            // Exact inherited items are seeded from their selected durable rows.
            //
            // Owner loss (a newer run claimed lastRunOrdinal) must not close
            // this stream while these sets are non-empty: turn_item.updated
            // writes are not ownership-gated, so late completions still land.
            const backgroundItems = yield* Ref.get(activeBackgroundTurnItems);
            if (backgroundItems.size > 0) {
              return false;
            }
            // Owner loss means do not hold the stream open solely for the
            // roster probe; once background sets are empty, release.
            if (yield* Ref.get(providerThreadOwnerLost)) {
              return true;
            }
            // Claude background Bash has no turn-item projection. Keep the
            // stream open while this root's provider thread still reports
            // pending roster work so late empty updates can clear Waiting.
            // Use only the thread-scoped probe: session-wide pending work
            // (siblings, wake buffers, session subagents) must not pin this
            // root subscription. Session idle release still uses
            // hasPendingBackgroundWork via ProviderSessionManager.
            const latestProviderThreadSnapshot = yield* Ref.get(latestProviderThread);
            if (input.session.hasPendingBackgroundWorkForThread !== undefined) {
              const hasPendingWork = yield* input.session
                .hasPendingBackgroundWorkForThread(latestProviderThreadSnapshot)
                .pipe(Effect.catchCause(() => Effect.succeed(false)));
              if (hasPendingWork) {
                return false;
              }
            }
            return true;
          });
          const filterAssistantEvent = makeAssistantStreamingFilter(responseStreamingMode);
          const providerEventFiber = yield* eventSubscription.events.pipe(
            Stream.mapEffect((event) =>
              Effect.gen(function* () {
                const [accepted, revokedIds, revokedThreadIds] = yield* Ref.modify(
                  eventRouting,
                  (state) => {
                    const [accepted, next] = routeProviderEvent(event, routeIdentity, state);
                    const revokedIds = new Set<NodeId>([
                      ...Array.from(state.workflowCoordinators.keys()).filter(
                        (id) => !next.workflowCoordinators.has(id),
                      ),
                      ...Array.from(state.workflowMembers.keys()).filter(
                        (id) => !next.workflowMembers.has(id),
                      ),
                    ]);
                    const revokedThreadIds = new Set(
                      Array.from(state.ownedThreadIds).filter((id) => !next.ownedThreadIds.has(id)),
                    );
                    return [[accepted, revokedIds, revokedThreadIds] as const, next];
                  },
                );
                if (revokedIds.size > 0) {
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
                    (current) =>
                      new Set(Array.from(current).filter((id) => !revokedItemIds.has(id))),
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
                    (current) =>
                      new Set(Array.from(current).filter((id) => !revokedTurnIds.has(id))),
                  );
                  yield* Ref.update(
                    activeChildSubagents,
                    (current) => new Set(Array.from(current).filter((id) => !revokedIds.has(id))),
                  );
                  yield* Ref.update(openRunOwnedSubagents, (current) => ({
                    ...current,
                    subagents: new Map(
                      Array.from(current.subagents).filter(([id]) => !revokedIds.has(id)),
                    ),
                    nodes: new Map(
                      Array.from(current.nodes).filter(
                        ([id, node]) => !revokedIds.has(id) && !revokedThreadIds.has(node.threadId),
                      ),
                    ),
                    turnItems: new Map(
                      Array.from(current.turnItems).filter(([id]) => !revokedIds.has(id)),
                    ),
                    childTurnItems: new Map(
                      Array.from(current.childTurnItems).filter(
                        ([, item]) => !revokedThreadIds.has(item.threadId),
                      ),
                    ),
                    linkedChildThreadIds: new Set(
                      Array.from(current.linkedChildThreadIds).filter(
                        (id) => !revokedThreadIds.has(id),
                      ),
                    ),
                    linkedWorkflowMemberIds: new Set(
                      Array.from(current.linkedWorkflowMemberIds).filter(
                        (id) => !revokedIds.has(id),
                      ),
                    ),
                  }));
                }
                // Route, persist, and track each frame in one sequential step.
                // Separate filter/tap operators can process a whole chunk's
                // ownership transfers before tracking its earlier accepted rows.
                if (!accepted) return;
                let storedEventCount = 0;
                const deliveredEvent = filterAssistantEvent(
                  event,
                  DateTime.toEpochMillis(yield* DateTime.now),
                );
                if (deliveredEvent) {
                  // Root provider_thread.updated always uses an ownership gate:
                  // pre-terminal writeIfRunCurrent (attempt still running), or
                  // post-terminal writeIfProviderThreadOwner so late roster
                  // clears still land while this attempt owns the run and this
                  // run owns lastRunOrdinal.
                  const rootTerminalAlreadySeen = yield* Ref.get(rootTerminalSeen);
                  const isRootProviderThreadUpdate =
                    event.type === "provider_thread.updated" &&
                    event.providerThread.id === input.providerThread.id;
                  const storedEvents = yield* providerEventIngestor.ingestNormalized({
                    analyticsContext: {
                      modelSelection: input.modelSelection,
                      runtimeMode: input.runtimePolicy.runtimeMode,
                      interactionMode: input.runtimePolicy.interactionMode,
                    },
                    providerSessionId: input.providerSessionId,
                    providerInstanceId: input.run.providerInstanceId,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    event: deliveredEvent,
                    ...(input.nativeModelCapacityOwner === undefined ||
                    rootTerminalAlreadySeen ||
                    deliveredEvent.type !== "provider_turn.updated" ||
                    deliveredEvent.driver !== "codex" ||
                    deliveredEvent.providerTurn.nodeId !== input.rootNode.id ||
                    deliveredEvent.providerTurn.runAttemptId !== input.attempt.id ||
                    deliveredEvent.providerTurn.tokenUsage?.maxTokens == null ||
                    !Number.isFinite(deliveredEvent.providerTurn.tokenUsage.maxTokens) ||
                    deliveredEvent.providerTurn.tokenUsage.maxTokens <= 0
                      ? {}
                      : {
                          nativeModelCapacityOwner: input.nativeModelCapacityOwner,
                          writeIfRunCurrent: {
                            runId: input.run.id,
                            activeAttemptId: input.attempt.id,
                            expectedStatus: "running" as const,
                          },
                        }),
                    ...(isRootProviderThreadUpdate
                      ? rootTerminalAlreadySeen
                        ? {
                            writeIfProviderThreadOwner: {
                              providerThreadId: input.providerThread.id,
                              runId: input.run.id,
                              activeAttemptId: input.attempt.id,
                              expectedLastRunOrdinal: input.run.ordinal,
                            },
                          }
                        : {
                            writeIfRunCurrent: {
                              runId: input.run.id,
                              activeAttemptId: input.attempt.id,
                              expectedStatus: "running" as const,
                            },
                          }
                      : {}),
                  });
                  storedEventCount = storedEvents.length;
                  if (
                    isRootProviderThreadUpdate &&
                    rootTerminalAlreadySeen &&
                    storedEventCount === 0
                  ) {
                    // Ownership lost (or thread row missing). Stop pinning the
                    // stream on this run's background probe.
                    yield* Ref.set(providerThreadOwnerLost, true);
                  }
                }
                if (event.type === "provider_thread.updated") {
                  if (event.providerThread.id === input.providerThread.id && storedEventCount > 0) {
                    yield* Ref.set(latestProviderThread, event.providerThread);
                  }
                }
                if (
                  event.type === "turn_item.updated" &&
                  event.turnItem.providerTurnId ===
                    (yield* Ref.get(eventRouting)).rootProviderTurnId
                ) {
                  yield* Ref.update(latestTurnItemOrdinal, (current) =>
                    Math.max(current, event.turnItem.ordinal),
                  );
                }
                if (event.type === "turn.terminal") {
                  yield* Ref.set(terminalEvent, event);
                  yield* Ref.set(rootTerminalSeen, true);
                  yield* finalizeRootRun(event);
                }
                yield* trackChildLifecycle(event, deliveredEvent !== null);
              }),
            ),
            Stream.takeUntilEffect(() => shouldStopProviderEventIngestion),
            Stream.runDrain,
            Effect.mapError((cause) => new RunExecutionIngestError({ runId: input.run.id, cause })),
            Effect.flatMap(() =>
              Effect.gen(function* () {
                const terminal = yield* Ref.get(terminalEvent);
                if (terminal === null) {
                  return;
                }
                yield* finalizeRootRun(terminal);
              }),
            ),
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause))
                return Effect.failCause(
                  Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)),
                );
              return Ref.get(rootRunFinalized).pipe(
                Effect.flatMap((finalized) =>
                  Effect.logWarning("orchestration V2 provider event ingestion failed", {
                    runId: input.run.id,
                    cause,
                  }).pipe(
                    Effect.andThen(
                      finalized
                        ? Effect.void
                        : Ref.get(latestProviderThread).pipe(
                            Effect.flatMap((providerThread) =>
                              Ref.get(latestTurnItemOrdinal).pipe(
                                Effect.flatMap((latestItemOrdinal) =>
                                  Ref.get(openRunOwnedSubagents).pipe(
                                    Effect.flatMap((openSubagents) =>
                                      writeFinalRunEvents({
                                        run: input.run,
                                        rootNode: input.rootNode,
                                        checkpointScope: input.checkpointScope,
                                        providerThread,
                                        attempt: input.attempt,
                                        ...(input.shouldFinalizeRun === undefined
                                          ? {}
                                          : { shouldFinalizeRun: input.shouldFinalizeRun }),
                                        ...(input.hasUnpairedRunInterruptRequest === undefined
                                          ? {}
                                          : {
                                              hasUnpairedRunInterruptRequest:
                                                input.hasUnpairedRunInterruptRequest,
                                            }),
                                        openRunOwnedSubagents: openSubagents,
                                        terminal: makeFailedTerminalEvent(
                                          makeProviderFailure({
                                            cause: Cause.squash(cause),
                                            class: "unknown",
                                          }),
                                          latestItemOrdinal + 1,
                                        ),
                                        failureItemPersisted: false,
                                        refreshAfterTurn,
                                      }),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                    ),
                    Effect.mapError(
                      (writeCause) =>
                        new RunExecutionIngestError({
                          runId: input.run.id,
                          cause: { ingest: cause, write: writeCause },
                        }),
                    ),
                  ),
                ),
              );
            }),
            Effect.ensuring(eventSubscription.close),
            Effect.forkDetach,
          );

          if (
            input.shouldStartProviderTurn !== undefined &&
            !(yield* input.shouldStartProviderTurn())
          ) {
            if (yield* cancelDeclinedStart) {
              yield* Ref.set(rootTerminalSeen, true);
              yield* Ref.set(rootRunFinalized, true);
              // No native root was started. Without retained background work
              // there is no terminal frame to end this private subscription.
              if (
                (yield* Ref.get(cancelledStartOwner))?.retainedTurn === undefined ||
                (input.providerThread.pendingBackgroundTasks?.length ?? 0) === 0
              ) {
                yield* Fiber.interrupt(providerEventFiber);
              }
            } else {
              yield* Fiber.interrupt(providerEventFiber);
            }
            return;
          }

          // A provider turn is a sign that the session is still alive. Keep
          // its already-issued MCP credential valid even when the agent goes
          // a long time between browser-tool calls.
          yield* McpSessionRegistry.touchActiveMcpThread(input.run.threadId);
          const turnInput = {
            appThread: input.appThread,
            threadId: input.run.threadId,
            runId: input.run.id,
            runOrdinal: input.run.ordinal,
            providerTurnOrdinal: input.providerTurnOrdinal,
            ...(input.run.restartContinuationOfRunId === undefined
              ? {}
              : {
                  restartContinuationOfRunId: input.run.restartContinuationOfRunId,
                }),
            attemptId: input.attemptId,
            rootNodeId: input.rootNode.id,
            providerThread: input.providerThread,
            message: input.message,
            modelSelection: input.modelSelection,
            runtimePolicy: input.runtimePolicy,
            ...(input.shouldStartProviderTurn === undefined
              ? {}
              : { shouldStartProviderTurn: input.shouldStartProviderTurn }),
          };
          const compact =
            input.message.attachments.length === 0 &&
            input.message.text.trim().toLowerCase() === "/compact";
          const startTurn = compact
            ? (input.session.compactThread?.(turnInput) ??
              Effect.fail(
                new ProviderAdapterTurnStartError({
                  driver: input.session.driver,
                  threadId: input.run.threadId,
                  providerThreadId: input.providerThread.id,
                  runId: input.run.id,
                  cause: "This provider does not support context compaction.",
                }),
              ))
            : input.session.startTurn(turnInput);
          yield* startTurn.pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (Cause.hasInterruptsOnly(cause)) {
                  yield* Fiber.interrupt(providerEventFiber);
                  return yield* Effect.failCause(
                    Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)),
                  );
                }
                const error = Cause.squash(cause);
                const receipt =
                  isNativeStartReceiptError(error) &&
                  error.threadId === input.run.threadId &&
                  error.runId === input.run.id &&
                  error.providerThreadId === input.providerThread.id &&
                  error.driver === input.session.driver &&
                  error.providerTurn?.nodeId === input.rootNode.id &&
                  error.providerTurn.runAttemptId === input.attemptId &&
                  error.providerTurn.providerThreadId === input.providerThread.id
                    ? error.providerTurn
                    : undefined;
                return yield* Effect.logError("orchestration V2 provider turn start failed", {
                  runId: input.run.id,
                  cause,
                }).pipe(
                  Effect.andThen(Fiber.interrupt(providerEventFiber)),
                  Effect.andThen(Ref.get(latestProviderThread)),
                  Effect.flatMap((providerThread) =>
                    Ref.get(latestTurnItemOrdinal).pipe(
                      Effect.flatMap((latestItemOrdinal) =>
                        Ref.get(openRunOwnedSubagents).pipe(
                          Effect.flatMap((openSubagents) =>
                            writeFinalRunEvents({
                              run: input.run,
                              rootNode: input.rootNode,
                              checkpointScope: input.checkpointScope,
                              providerThread,
                              attempt: input.attempt,
                              ...(receipt === undefined ? {} : { failedStartReceipt: receipt }),
                              writeIfRunCurrent: {
                                activeAttemptId: input.attemptId,
                                expectedStatus: "running",
                              },
                              ...(input.shouldFinalizeRun === undefined
                                ? {}
                                : { shouldFinalizeRun: input.shouldFinalizeRun }),
                              ...(input.hasUnpairedRunInterruptRequest === undefined
                                ? {}
                                : {
                                    hasUnpairedRunInterruptRequest:
                                      input.hasUnpairedRunInterruptRequest,
                                  }),
                              openRunOwnedSubagents: openSubagents,
                              terminal: makeFailedTerminalEvent(
                                makeProviderFailure({
                                  cause: Cause.squash(cause),
                                  class: "provider_error",
                                }),
                                latestItemOrdinal + 1,
                              ),
                              failureItemPersisted: false,
                              refreshAfterTurn,
                            }),
                          ),
                        ),
                      ),
                    ),
                  ),
                  Effect.mapError(
                    (writeCause) =>
                      new RunExecutionStartError({
                        commandId: input.commandId,
                        runId: input.run.id,
                        cause: { start: cause, write: writeCause },
                      }),
                  ),
                );
              }),
            ),
          );
        }),
    } satisfies RunExecutionServiceV2Shape);
  }),
);

function makeInterruptResultTurnItem(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2Shape;
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly completedAt: DateTime.Utc;
}): OrchestrationV2TurnItem {
  return {
    id: input.idAllocator.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "interrupt-result",
    }),
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.rootNode.id,
    providerThreadId: input.providerThread.id,
    providerTurnId: input.rootNode.providerTurnId,
    nativeItemRef: null,
    parentItemId: input.idAllocator.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "interrupt-request",
    }),
    ordinal: input.run.ordinal * 100 + 98,
    status: "interrupted",
    title: "Interrupted",
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    updatedAt: input.completedAt,
    type: "run_interrupt_result",
    message: "Run interrupted by user",
  };
}
