/**
 * The server remains Send authority. Clients hide it only when local evidence proves refusal;
 * shared rules keep offered controls aligned while incomplete client state fails open to the server
 * decision.
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
  readonly thread: Pick<Projection["thread"], "providerInstanceId" | "modelSelection">;
};

export type QueuedRunProjection = Pick<Projection, "runs" | "messages">;

/** Why the server refuses Send on a queued message, before any usage limit. */
export type QueuedRunSendRefusal = "not_queued" | "automatic" | "busy";

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
function isQueueUsageLimited(
  projection: QueueUsageLimitProjection,
  providerInstanceId = projection.thread.providerInstanceId,
): boolean {
  let latestSession: Projection["providerSessions"][number] | undefined;
  for (const session of projection.providerSessions) {
    if (session.providerInstanceId !== providerInstanceId) continue;
    if (
      latestSession === undefined ||
      DateTime.toEpochMillis(session.updatedAt) > DateTime.toEpochMillis(latestSession.updatedAt)
    )
      latestSession = session;
  }
  return (
    usageLimitBlockedRun(projection.runs, projection.turnItems, latestSession?.lastError ?? null)
      ?.providerInstanceId === providerInstanceId
  );
}

/**
 * Why Send on this queued message would be refused, or null when the server
 * accepts it. Automatic deliveries (delegated completions and notifications)
 * are not the user's messages, and a running turn must finish or be steered.
 */
export function queuedRunSendRefusal(
  projection: QueuedRunProjection,
  runId: RunId,
): QueuedRunSendRefusal | null {
  const run = projection.runs.find((candidate) => candidate.id === runId);
  if (run?.status !== "queued") return "not_queued";
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  if (message?.delegatedCompletion !== undefined || message?.notification !== undefined)
    return "automatic";
  if (projection.runs.some(isBlockingRun)) return "busy";
  return null;
}

/**
 * Windowed snapshots can miss a newer session superseding a usage limit. Refuse only when snapshot
 * and server-computed shell agree; otherwise offer Send and let server authority decide.
 */
export function isQueueUsageLimitProven(
  projection: QueueUsageLimitProjection,
  shellLastErrorClass: string | null | undefined,
): boolean {
  return shellLastErrorClass === "usage_limit" && isQueueUsageLimited(projection);
}

/**
 * True when the server accepts Send on this queued message. A client passes
 * `usageLimited` from `isQueueUsageLimitProven`; the default is the server's
 * own check on a full projection.
 */
export function canSendQueuedRun(
  projection: QueueUsageLimitProjection & QueuedRunProjection,
  runId: RunId,
  options?: { readonly usageLimited?: boolean },
): boolean {
  if (queuedRunSendRefusal(projection, runId) !== null) return false;
  const automaticMessageIds = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  const firstAutomatic = projection.runs
    .filter((run) => run.status === "queued" && automaticMessageIds.has(run.userMessageId))
    .sort(
      (left, right) =>
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal,
    )[0];
  const head = firstAutomatic ?? projection.runs.find((run) => run.id === runId);
  const message = projection.messages.find((candidate) => candidate.id === head?.userMessageId);
  // Send cannot select a notification. An automatic completion may follow the current monitor.
  const providerInstanceId =
    message?.notification?.source.kind === "monitor"
      ? projection.thread.modelSelection.instanceId
      : (head?.modelSelection.instanceId ?? projection.thread.providerInstanceId);
  return options?.usageLimited === false || !isQueueUsageLimited(projection, providerInstanceId);
}
