import {
  ProviderThreadId,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import type { IdAllocatorV2DeriveShape } from "../IdAllocator.ts";

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
