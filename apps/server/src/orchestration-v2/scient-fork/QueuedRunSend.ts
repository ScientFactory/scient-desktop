/**
 * SCIENT-OWNED queue Send and release decisions.
 *
 * Send on any queued message starts it now and resumes the rest of the queue
 * after it. A message the user starts directly on an idle thread also resumes
 * a held queue. Both are pure plans; the orchestrator emits their events in
 * the same command, so the terminal hold fence sees one release boundary.
 */
import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import { queuedRunSendRefusal } from "@t3tools/shared/scientQueuedRunSend";

import { isAutomaticCompletionRun, queuedRunsInDeliveryOrder } from "../QueuedRunOrder.ts";

const REFUSAL_MESSAGES = {
  not_queued: "The queued message has already started or was removed.",
  automatic: "Automatic deliveries cannot be sent from the queue.",
  busy: "Wait for the current turn to finish, or steer this message into it.",
} as const;

/**
 * Send on `runId`: automatic completion deliveries keep going first, then the
 * chosen message, then the other queued messages in their current order. Every
 * queued run is released. Returns the refusal text when the server refuses.
 */
export function planQueuedRunSend(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
):
  | { readonly refusal: string }
  | { readonly refusal: null; readonly runs: ReadonlyArray<OrchestrationV2Run> } {
  const refusal = queuedRunSendRefusal(projection, runId);
  if (refusal !== null) return { refusal: REFUSAL_MESSAGES[refusal] };
  const queued = queuedRunsInDeliveryOrder(projection);
  const automatic = queued.filter((run) => isAutomaticCompletionRun(projection, run));
  const chosen = queued.filter((run) => run.id === runId);
  const rest = queued.filter((run) => run.id !== runId && !automatic.includes(run));
  return {
    refusal: null,
    runs: [...automatic, ...chosen, ...rest].map((run, index) => ({
      ...run,
      queuePosition: index + 1,
      queueHeld: false,
    })),
  };
}

/**
 * True when this message is a direct user send that starts a run of its own:
 * an ordinary Send (`start_immediately`, no delivery intent or `auto`). Such a
 * message resumes the queue. The original intent decides, not the resulting
 * run: a Queue submission or a Steer that starts at once on an idle thread, a
 * Restart, any continuation, automatic deliveries, notifications and scheduled
 * tasks leave a held queue alone.
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
 * The queued runs a direct user send releases: every queued run, held or not.
 * A failure whose hold reaction has not run yet leaves its queue unheld; the
 * release written here is the boundary that reaction must respect.
 */
export function queuedRunsReleasedByDirectSend(
  runs: ReadonlyArray<OrchestrationV2Run>,
): ReadonlyArray<OrchestrationV2Run> {
  return runs.filter((run) => run.status === "queued");
}
