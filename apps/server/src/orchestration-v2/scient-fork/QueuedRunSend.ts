/**
 * Scient's queue additions around upstream's `queued-run.start`: a direct user send on an idle
 * thread releases a held queue, and an older Scient client's Send is read as `queued-run.start`.
 */
import type { OrchestrationV2Command, OrchestrationV2DomainEvent } from "@t3tools/contracts";

/**
 * Use original Send intent, not the resulting run, to release a held queue. Queue/Steer can start
 * immediately on idle threads without authorizing release; restarts, continuations, and automatic
 * work do not release it either.
 */
export function startsDirectUserRun(
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
  pendingEvents: ReadonlyArray<OrchestrationV2DomainEvent>,
): boolean {
  if (
    command.createdBy !== "user" ||
    command.dispatchMode.type !== "start_immediately" ||
    (command.deliveryIntent !== undefined && command.deliveryIntent !== "auto") ||
    command.delegatedCompletion !== undefined ||
    command.notification !== undefined ||
    command.scheduledTaskId !== undefined ||
    command.manualContinuationOfRunId !== undefined ||
    command.usageLimitContinuationOfRunId !== undefined ||
    command.usageLimitRecoveryRequestId !== undefined ||
    command.restartContinuationOfRunId !== undefined
  )
    return false;
  return pendingEvents.some(
    (event) =>
      event.type === "run.created" &&
      event.threadId === command.threadId &&
      event.payload.userMessageId === command.messageId &&
      event.payload.status !== "queued",
  );
}

/**
 * Scient builds before 0.6.26, and phones built from them, send a held message now as
 * `queue.resume` with its `runId`. That is upstream's `queued-run.start`.
 */
export function withLegacyQueuedRunStart(command: OrchestrationV2Command): OrchestrationV2Command {
  if (command.type !== "queue.resume" || command.runId === undefined) return command;
  return {
    type: "queued-run.start",
    commandId: command.commandId,
    threadId: command.threadId,
    runId: command.runId,
  };
}
