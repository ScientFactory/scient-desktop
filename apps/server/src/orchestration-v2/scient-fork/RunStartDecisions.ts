/** Pure decisions for starting or steering a run: which attempt runs, and the thread state
 * the run executes under (its captured modes and, for a legacy entry, its first title). */
import type {
  CommandId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

import type { IdAllocatorV2DeriveShape } from "../IdAllocator.ts";

/** A failed attempt is retried as a fresh pending attempt; any other attempt starts as is. */
export function queuedRunStartAttempt(input: {
  readonly queuedRun: OrchestrationV2Run;
  readonly previousAttempt: OrchestrationV2RunAttempt;
  readonly attempts: ReadonlyArray<OrchestrationV2RunAttempt>;
  readonly ids: Pick<IdAllocatorV2DeriveShape, "runAttempt">;
}): OrchestrationV2RunAttempt {
  const { queuedRun, previousAttempt } = input;
  const attemptOrdinal =
    previousAttempt.status === "failed"
      ? Math.max(
          ...input.attempts
            .filter((candidate) => candidate.runId === queuedRun.id)
            .map((candidate) => candidate.attemptOrdinal),
        ) + 1
      : previousAttempt.attemptOrdinal;
  return previousAttempt.status === "failed"
    ? {
        ...previousAttempt,
        id: input.ids.runAttempt({ runId: queuedRun.id, attemptOrdinal }),
        attemptOrdinal,
        providerTurnId: null,
        reason: "retry",
        status: "pending",
        startedAt: null,
        completedAt: null,
      }
    : previousAttempt;
}

/** The thread a queued run executes under: the modes captured when it was queued and,
 * for a legacy entry whose title is still untouched, its seeded first title. */
export function queuedRunExecutionThread(input: {
  readonly projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">;
  readonly queuedRun: OrchestrationV2Run;
  readonly queuedMessage: OrchestrationV2ConversationMessage;
  readonly commandId: CommandId;
  readonly now: DateTime.Utc;
  readonly isNativeMaintenanceCommand: (message: OrchestrationV2ConversationMessage) => boolean;
}) {
  const { projection, queuedRun, queuedMessage, commandId, now, isNativeMaintenanceCommand } =
    input;
  const queuedMessageIds = new Set(
    projection.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId),
  );
  const initialTitleSeed = queuedRun.legacyQueue?.titleSeed;
  const generateInitialTitle =
    initialTitleSeed !== undefined &&
    queuedRun.legacyQueue?.titleAtAdmission === projection.thread.title &&
    !isNativeMaintenanceCommand(queuedMessage) &&
    !projection.messages.some(
      (message) =>
        message.role === "user" &&
        !queuedMessageIds.has(message.id) &&
        !isNativeMaintenanceCommand(message),
    );
  const capturedThread: OrchestrationV2AppThread = {
    ...projection.thread,
    ...(generateInitialTitle
      ? {
          title: initialTitleSeed ?? projection.thread.title,
          titleRegeneration: { requestId: commandId, startedAt: now },
        }
      : {}),
    runtimeMode:
      queuedRun.runtimeMode ?? queuedRun.legacyQueue?.runtimeMode ?? projection.thread.runtimeMode,
    interactionMode:
      queuedRun.interactionMode ??
      queuedRun.legacyQueue?.interactionMode ??
      projection.thread.interactionMode,
  };
  const modesChanged =
    capturedThread.runtimeMode !== projection.thread.runtimeMode ||
    capturedThread.interactionMode !== projection.thread.interactionMode;
  return { capturedThread, generateInitialTitle, modesChanged };
}

/** The modes a steer executes under, and whether they differ from the active run's. */
export function steerExecutionThread(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly targetRun: OrchestrationV2Run;
  readonly runtimeMode: OrchestrationV2Run["runtimeMode"];
  readonly interactionMode: OrchestrationV2Run["interactionMode"];
  readonly delegatedCompletion: OrchestrationV2ConversationMessage["delegatedCompletion"];
}) {
  const { thread, targetRun } = input;
  const executionThread = {
    ...thread,
    runtimeMode:
      input.runtimeMode ??
      (input.delegatedCompletion === undefined ? undefined : targetRun.runtimeMode) ??
      thread.runtimeMode,
    interactionMode:
      input.interactionMode ??
      (input.delegatedCompletion === undefined ? undefined : targetRun.interactionMode) ??
      thread.interactionMode,
  };
  const executionModesChanged =
    // An older active run has no captured policy to prove that a steer can
    // honor explicitly submitted modes. Restart rather than inherit it.
    (input.runtimeMode !== undefined &&
      targetRun.runtimeMode === undefined &&
      targetRun.legacyQueue?.runtimeMode === undefined) ||
    (input.interactionMode !== undefined &&
      targetRun.interactionMode === undefined &&
      targetRun.legacyQueue?.interactionMode === undefined) ||
    executionThread.runtimeMode !==
      (targetRun.runtimeMode ?? targetRun.legacyQueue?.runtimeMode ?? thread.runtimeMode) ||
    executionThread.interactionMode !==
      (targetRun.interactionMode ??
        targetRun.legacyQueue?.interactionMode ??
        thread.interactionMode);
  return { executionThread, executionModesChanged };
}
