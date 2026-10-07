/**
 * SCIENT-OWNED rule for sending a held queue.
 *
 * The server's `queue.resume` handler refuses by this rule and stays the
 * authority. The composer's queue strip offers Send, Retry and Resume queue by
 * the same rule, so an offered action is one the server accepts.
 */
import type {
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { usageLimitBlockedRun } from "./orchestrationV2ThreadError.ts";

type Projection = OrchestrationV2ThreadProjection;

export type QueueUsageLimitProjection = Pick<
  Projection,
  "runs" | "turnItems" | "providerSessions"
> & {
  readonly thread: Pick<Projection["thread"], "providerInstanceId">;
};

export type QueueHeadProjection = Pick<Projection, "runs" | "messages">;

/** A run in one of these states owns the thread, so no queued run may start. */
function isBlockingRun(run: OrchestrationV2Run): boolean {
  return (
    run.status === "preparing" ||
    run.status === "starting" ||
    run.status === "running" ||
    run.status === "waiting"
  );
}

/**
 * True while the subscription limit stopped the thread. Resuming the queue
 * would only send the waiting messages into the same limit.
 */
export function isQueueUsageLimited(projection: QueueUsageLimitProjection): boolean {
  let latestSession: Projection["providerSessions"][number] | undefined;
  for (const session of projection.providerSessions) {
    if (session.providerInstanceId !== projection.thread.providerInstanceId) continue;
    if (
      latestSession === undefined ||
      DateTime.toEpochMillis(session.updatedAt) > DateTime.toEpochMillis(latestSession.updatedAt)
    )
      latestSession = session;
  }
  return (
    usageLimitBlockedRun(
      projection.runs,
      projection.turnItems,
      latestSession?.lastError ?? null,
    ) !== null
  );
}

/**
 * The queued run the server delivers next. Automatic delegated-completion
 * runs go first; the queue strip hides them, so its first row is then not
 * the head.
 */
export function queueDeliveryHead(projection: QueueHeadProjection): OrchestrationV2Run | null {
  const automatic = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  let head: OrchestrationV2Run | null = null;
  for (const run of projection.runs) {
    if (run.status !== "queued") continue;
    if (head === null) {
      head = run;
      continue;
    }
    const priority =
      Number(automatic.has(head.userMessageId)) - Number(automatic.has(run.userMessageId));
    const order =
      priority ||
      (run.queuePosition ?? run.ordinal) - (head.queuePosition ?? head.ordinal) ||
      run.ordinal - head.ordinal;
    if (order < 0) head = run;
  }
  return head;
}

/** True when `runId` is the next queued run and nothing else owns the thread. */
export function isIdleQueueHead(projection: QueueHeadProjection, runId: RunId): boolean {
  return queueDeliveryHead(projection)?.id === runId && !projection.runs.some(isBlockingRun);
}

/** True when the server accepts `queue.resume` for this queued run. */
export function canSendQueueHead(
  projection: QueueUsageLimitProjection & QueueHeadProjection,
  runId: RunId,
): boolean {
  return !isQueueUsageLimited(projection) && isIdleQueueHead(projection, runId);
}
