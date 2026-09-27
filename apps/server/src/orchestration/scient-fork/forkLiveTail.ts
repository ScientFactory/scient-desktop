/**
 * What a fork taken while the origin agent is still working carries of the
 * running turn: its "latest traces".
 *
 * SCIENT-OWNED. Upstream Orchestration V2 rejects forks from running work
 * ("until active-run semantics are designed"). Scient forks the running turn
 * as it stands: every message after the retained completed prefix (the user's
 * request, reasoning, partial text), the work log of those turns, and the
 * state of unfinished work. Nothing executable is copied: an unfinished tool
 * call is labelled in flight and a pending approval or question is recorded
 * as history only. The source turn keeps running untouched.
 *
 * In V2 terms this is `sourcePoint = { runId, turnItemId: last item at the
 * cut }` plus a relaxed forkable-status guard, isolated here so it can become
 * an upstream proposal or a Scient wrapper when V2 lands.
 */
import type {
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import { isForkCopiedActivity } from "./forkActivityCopy.ts";

export interface ForkLiveTail {
  readonly runningTurnId: TurnId;
  /** Messages after the retained prefix, in timeline order. */
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  /** The source turn each tail message belongs to. */
  readonly turnIdByMessageId: ReadonlyMap<string, string>;
  /** Source ids of messages still streaming at the cut. */
  readonly partialMessageIds: ReadonlySet<string>;
  /** Source turn ids the tail spans (the running turn and any unfinished ones). */
  readonly turnIds: ReadonlySet<string>;
  /** Work-log activities to copy, including the latest row of unfinished tools. */
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly inFlightActivityIds: ReadonlySet<string>;
  readonly pendingRequests: ReadonlyArray<string>;
  readonly touchedFiles: ReadonlyArray<string>;
}

const FILE_KEYS = new Set(["path", "file_path", "filePath", "filename"]);
const MAX_TOUCHED_FILES = 50;
const MAX_PENDING_REQUESTS = 20;
const MAX_REQUEST_SUMMARY_CHARS = 300;
const TOOL_KINDS = new Set(["tool.started", "tool.updated", "tool.completed", "tool.denied"]);

const payloadRecord = (activity: OrchestrationThreadActivity) =>
  Predicate.isObject(activity.payload) ? (activity.payload as Record<string, unknown>) : undefined;

function toolCallIdOf(activity: OrchestrationThreadActivity): string | undefined {
  const toolCallId = payloadRecord(activity)?.toolCallId;
  return typeof toolCallId === "string" ? toolCallId : undefined;
}

function requestIdOf(activity: OrchestrationThreadActivity): string | undefined {
  const requestId = payloadRecord(activity)?.requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

function collectFilePaths(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 5 || into.size >= MAX_TOUCHED_FILES || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectFilePaths(item, into, depth + 1);
    return;
  }
  if (!Predicate.isObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FILE_KEYS.has(key) && typeof entry === "string" && entry.trim().length > 0) {
      into.add(entry.trim());
    } else {
      collectFilePaths(entry, into, depth + 1);
    }
  }
}

/**
 * Everything the origin produced after the retained completed prefix. The
 * running turn's buffered text is flushed to the event store before the fork
 * command is decided, so the persisted rows are its latest state.
 */
export function collectForkLiveTail(input: {
  readonly origin: Pick<OrchestrationThread, "messages" | "activities">;
  readonly retainedMessageIds: ReadonlySet<string>;
  /** Completed turns already copied with the prefix; their work log is copied there. */
  readonly retainedTurnIds: ReadonlySet<string>;
  readonly runningTurnId: TurnId;
  /** User requests are stored without a turn; this binds each to the turn it started. */
  readonly turnRequests: ReadonlyArray<{
    readonly turnId: TurnId;
    readonly userMessageId: string | null;
  }>;
}): ForkLiveTail {
  const lastRetainedIndex = input.origin.messages.findLastIndex((message) =>
    input.retainedMessageIds.has(message.id),
  );
  const messages = input.origin.messages
    .slice(lastRetainedIndex + 1)
    .filter((message) => message.role !== "system" && !input.retainedMessageIds.has(message.id));
  const turnByRequest = new Map(
    input.turnRequests.flatMap((turn) =>
      turn.userMessageId === null ? [] : [[turn.userMessageId, turn.turnId] as const],
    ),
  );
  // A request the provider has not bound to a turn yet belongs to the running turn.
  const turnIdByMessageId = new Map(
    messages.map((message) => [
      message.id,
      message.turnId ?? turnByRequest.get(message.id) ?? input.runningTurnId,
    ]),
  );
  const turnIds = new Set<string>([input.runningTurnId]);
  for (const turnId of turnIdByMessageId.values()) {
    if (!input.retainedTurnIds.has(turnId)) turnIds.add(turnId);
  }

  const tailActivities = input.origin.activities.filter(
    (activity) => activity.turnId !== null && turnIds.has(activity.turnId),
  );

  // A tool call is unfinished when nothing reported its completion.
  const finishedToolCalls = new Set(
    tailActivities.flatMap((activity) =>
      activity.kind === "tool.completed" || activity.kind === "tool.denied"
        ? [toolCallIdOf(activity)].filter((id): id is string => id !== undefined)
        : [],
    ),
  );
  const latestUnfinished = new Map<string, OrchestrationThreadActivity>();
  for (const activity of tailActivities) {
    if (activity.kind !== "tool.started" && activity.kind !== "tool.updated") continue;
    const toolCallId = toolCallIdOf(activity);
    if (toolCallId === undefined || finishedToolCalls.has(toolCallId)) continue;
    latestUnfinished.set(toolCallId, activity);
  }
  const inFlightActivityIds = new Set(
    [...latestUnfinished.values()].map((activity) => activity.id),
  );
  const activities = tailActivities.filter(
    (activity) => isForkCopiedActivity(activity) || inFlightActivityIds.has(activity.id),
  );

  const resolvedRequests = new Set(
    tailActivities.flatMap((activity) =>
      activity.kind === "approval.resolved" || activity.kind === "user-input.resolved"
        ? [requestIdOf(activity)].filter((id): id is string => id !== undefined)
        : [],
    ),
  );
  const pendingRequests = tailActivities
    .filter(
      (activity) =>
        (activity.kind === "approval.requested" || activity.kind === "user-input.requested") &&
        !resolvedRequests.has(requestIdOf(activity) ?? ""),
    )
    .map((activity) => activity.summary.slice(0, MAX_REQUEST_SUMMARY_CHARS))
    .slice(0, MAX_PENDING_REQUESTS);

  const touchedFiles = new Set<string>();
  for (const activity of tailActivities) {
    if (!TOOL_KINDS.has(activity.kind)) continue;
    collectFilePaths(payloadRecord(activity)?.data, touchedFiles);
  }

  return {
    runningTurnId: input.runningTurnId,
    messages,
    turnIdByMessageId,
    partialMessageIds: new Set(
      messages.filter((message) => message.streaming).map((message) => message.id),
    ),
    turnIds,
    activities,
    inFlightActivityIds,
    pendingRequests,
    touchedFiles: [...touchedFiles].slice(0, MAX_TOUCHED_FILES),
  };
}
