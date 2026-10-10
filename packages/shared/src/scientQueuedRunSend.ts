/**
 * SCIENT-OWNED rule for Send on a queued message.
 *
 * Send on any queued message starts it now and resumes the rest of the queue
 * after it. The server's `queue.resume` handler refuses by this rule and stays
 * the authority. The web strip and the mobile queue sheet offer Send by the
 * same rule, so an offered Send is one the server accepts. Clients fail open:
 * they hide Send only when their own data proves the refusal.
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
 * The usage-limit refusal as a client may apply it. A windowed thread snapshot
 * can omit a newer session whose error supersedes the limit, so the snapshot
 * alone cannot prove the limit. The thread shell's error class is computed by
 * the server from every bound session. The client refuses only when both agree,
 * and otherwise offers the control and lets the server decide.
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
  const usageLimited = options?.usageLimited ?? isQueueUsageLimited(projection);
  return !usageLimited && queuedRunSendRefusal(projection, runId) === null;
}
