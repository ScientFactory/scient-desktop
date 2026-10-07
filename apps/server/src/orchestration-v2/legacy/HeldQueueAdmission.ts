import {
  isProviderNativeSubagentThread,
  ProviderThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import type { IdAllocatorV2DeriveShape } from "../IdAllocator.ts";
import { queuedRunsInDeliveryOrder } from "../QueuedRunOrder.ts";

/** Why a held legacy entry cannot be admitted, or undefined when it can. Its source stays intact. */
export function legacyQueueImportRefusal(input: {
  readonly command: Extract<OrchestrationV2InternalCommand, { type: "legacy-queue.import" }>;
  readonly projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">;
}): string | undefined {
  const { command, projection } = input;
  if (projection.thread.deletedAt !== null || isProviderNativeSubagentThread(projection.thread)) {
    return "This thread cannot admit queued work. Its source remains intact.";
  }
  if (
    projection.runs.some((run) => run.userMessageId === command.messageId) ||
    projection.messages.some((message) => message.id === command.messageId)
  ) {
    return "The legacy queue message already belongs to V2 work. Its source remains intact.";
  }
  return undefined;
}

/** Pure admission. Native sessions, checkpoints and provider delivery wait for Resume. */
export function planHeldQueueAdmission(input: {
  readonly command: Extract<OrchestrationV2InternalCommand, { type: "legacy-queue.import" }>;
  readonly projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">;
  readonly ids: IdAllocatorV2DeriveShape;
}) {
  const { command, projection, ids } = input;
  const modelSelection = command.modelSelection ?? projection.thread.modelSelection;
  const ordinal = Math.max(0, ...projection.runs.map((run) => run.ordinal)) + 1;
  const runId = ids.run({ threadId: command.threadId, ordinal });
  const rootNodeId = ids.rootNode({ runId });
  const attemptId = ids.runAttempt({ runId, attemptOrdinal: 1 });
  // Allocate an app-owned placeholder identity without looking up a runtime.
  // The provider-thread record is materialized only on explicit delivery.
  const providerThreadId = ProviderThreadId.make(`legacy-queue:${runId}`);
  const run: OrchestrationV2Run = {
    id: runId,
    threadId: command.threadId,
    ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: providerThreadId,
    userMessageId: command.messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "queued",
    queueHeld: true,
    queuePosition:
      Math.max(
        0,
        ...projection.runs
          .filter((run) => run.status === "queued")
          .map((run) => run.queuePosition ?? run.ordinal),
      ) + 1,
    requestedAt: command.createdAt,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    legacyQueue: {
      queueItemId: command.queueItemId,
      ...(command.runtimeMode === undefined ? {} : { runtimeMode: command.runtimeMode }),
      ...(command.interactionMode === undefined
        ? {}
        : { interactionMode: command.interactionMode }),
      ...(command.titleSeed === undefined
        ? {}
        : { titleSeed: command.titleSeed, titleAtAdmission: projection.thread.title }),
      ...(command.sourceProposedPlan === undefined
        ? {}
        : { sourceProposedPlan: command.sourceProposedPlan }),
    },
  };
  const attempt: OrchestrationV2RunAttempt = {
    id: attemptId,
    runId,
    attemptOrdinal: 1,
    rootNodeId,
    providerInstanceId: modelSelection.instanceId,
    providerThreadId: providerThreadId,
    providerTurnId: null,
    reason: "initial",
    status: "pending",
    startedAt: null,
    completedAt: null,
  };
  const node: OrchestrationV2ExecutionNode = {
    id: rootNodeId,
    threadId: command.threadId,
    runId,
    parentNodeId: null,
    rootNodeId,
    kind: "root_turn",
    status: "pending",
    countsForRun: true,
    providerThreadId: providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: null,
    completedAt: null,
  };
  const message: OrchestrationV2ConversationMessage = {
    id: command.messageId,
    threadId: command.threadId,
    runId,
    nodeId: rootNodeId,
    createdBy: "user",
    creationSource: "server",
    role: "user",
    text: command.text,
    attachments: command.attachments,
    ...(command.context === undefined ? {} : { context: command.context }),
    ...(command.selectedScientSkillNames === undefined
      ? {}
      : { selectedScientSkillNames: command.selectedScientSkillNames }),
    ...(command.composerSnapshot === undefined
      ? {}
      : { composerSnapshot: command.composerSnapshot }),
    streaming: false,
    createdAt: command.createdAt,
    updatedAt: command.createdAt,
  };
  return { run, attempt, node, message };
}

/** The records an admitted held entry commits, in commit order. */
export function heldQueueAdmissionEvents(input: {
  readonly command: Extract<OrchestrationV2InternalCommand, { type: "legacy-queue.import" }>;
  readonly projection: Pick<OrchestrationV2ThreadProjection, "thread">;
  readonly plan: ReturnType<typeof planHeldQueueAdmission>;
}): ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">> {
  const { command, projection, plan } = input;
  const modelSelection = command.modelSelection ?? projection.thread.modelSelection;
  const common = {
    threadId: command.threadId,
    runId: plan.run.id,
    nodeId: plan.node.id,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: command.createdAt,
  };
  return [
    { ...common, type: "run.created", payload: plan.run },
    { ...common, type: "run-attempt.created", payload: plan.attempt },
    { ...common, type: "node.updated", payload: plan.node },
    { ...common, type: "message.updated", payload: plan.message },
  ];
}

/** Reorder only legacy-owned queue entries; other native work keeps its position.
 * Returns the runs whose position changes, or undefined when the queue changed under the request. */
export function planLegacyQueueReorder(input: {
  readonly command: Extract<OrchestrationV2InternalCommand, { type: "legacy-queue.reorder" }>;
  readonly projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">;
}): ReadonlyArray<OrchestrationV2Run> | undefined {
  const { command, projection } = input;
  const queued = queuedRunsInDeliveryOrder(projection);
  const owned = queued.filter((run) => run.legacyQueue !== undefined);
  const requested = new Set(command.queueItemIds);
  if (
    projection.thread.deletedAt !== null ||
    projection.thread.archivedAt !== null ||
    requested.size !== owned.length ||
    requested.size !== command.queueItemIds.length ||
    owned.some((run) => !requested.has(run.legacyQueue!.queueItemId))
  )
    return undefined;
  const ordered = command.queueItemIds.map((id) =>
    owned.find((run) => run.legacyQueue!.queueItemId === id)!,
  );
  let next = 0;
  const moved: Array<OrchestrationV2Run> = [];
  for (const [index, original] of queued.entries()) {
    // Other native work keeps its position; the compatibility request owns only legacy entries.
    const run = original.legacyQueue === undefined ? original : ordered[next++]!;
    if (run.queuePosition === index + 1) continue;
    moved.push({ ...run, queuePosition: index + 1 });
  }
  return moved;
}

/** The provider-thread record a held entry's placeholder identity materializes on delivery. */
export function heldQueueProviderThread(input: {
  readonly providerThreadId: ProviderThreadId;
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  const { now } = input;
  return {
    id: input.providerThreadId,
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: null,
    appThreadId: input.threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
}
