import {
  TurnId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadShell,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DateTime from "effect/DateTime";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { LegacyV1ThreadImporter } from "../../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import {
  THREAD_READ_DEFAULT_LIMIT,
  THREAD_READ_DEFAULT_MAX_CHARS_PER_ITEM,
  type ScientThreadReadInput,
  type ScientThreadReadItem,
  type ScientThreadReadItemType,
  type ScientThreadReadResult,
  type ScientThreadReadThread,
  ScientThreadReadToolError,
  ScientThreadsToolkit,
} from "./tools.ts";

/** V2 parity: the messages view is the conversation, not its machinery. */
const MESSAGES_VIEW_TYPES: ReadonlySet<ScientThreadReadItemType> = new Set([
  "user_message",
  "assistant_message",
  "proposed_plan",
]);

interface TimelineEntry {
  readonly itemId: string;
  readonly type: ScientThreadReadItemType;
  readonly status: ScientThreadReadItem["status"];
  readonly title: string | null;
  readonly activityKind: string | null;
  readonly messageId: ScientThreadReadItem["messageId"];
  readonly turnId: ScientThreadReadItem["turnId"];
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const messageType = (role: OrchestrationMessage["role"]): ScientThreadReadItemType => {
  switch (role) {
    case "user":
      return "user_message";
    case "assistant":
      return "assistant_message";
    case "reasoning":
      return "reasoning";
    case "system":
      return "system_message";
  }
};

const messageEntry = (message: OrchestrationMessage): TimelineEntry => ({
  itemId: message.id,
  type: messageType(message.role),
  status: message.streaming ? "running" : "completed",
  title: null,
  activityKind: null,
  messageId: message.id,
  turnId: message.turnId,
  text: message.text,
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
});

const planEntry = (plan: OrchestrationProposedPlan): TimelineEntry => ({
  itemId: plan.id,
  type: "proposed_plan",
  status: "completed",
  title: null,
  activityKind: null,
  messageId: null,
  turnId: plan.turnId,
  text: plan.planMarkdown,
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
});

const payloadText = (payload: unknown): string | null => {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload) ?? null;
  } catch {
    return null;
  }
};

/** Rendering stays complete; the requested text window bounds each response. */
export function renderActivityText(activity: OrchestrationThreadActivity): string {
  const header = `${activity.kind}: ${activity.summary}`;
  const payload = payloadText(activity.payload);
  return payload === null || payload.length === 0 ? header : `${header}\n${payload}`;
}

const activityEntry = (activity: OrchestrationThreadActivity): TimelineEntry => ({
  itemId: activity.id,
  type: "activity",
  status: "completed",
  title: activity.summary,
  activityKind: activity.kind,
  messageId: null,
  turnId: activity.turnId,
  text: renderActivityText(activity),
  createdAt: activity.createdAt,
  updatedAt: activity.createdAt,
});

/**
 * One chronological timeline over every projected row. Each source keeps its
 * own projection order; sources interleave by creation time, and on a tie
 * messages precede plans, which precede activities. Positions index this full
 * timeline, so a position means the same item in both views.
 */
export function buildThreadTimeline(
  thread: Pick<OrchestrationThread, "messages" | "proposedPlans" | "activities">,
): ReadonlyArray<TimelineEntry> {
  const sources = [
    thread.messages.map(messageEntry),
    thread.proposedPlans.map(planEntry),
    thread.activities.map(activityEntry),
  ];
  const cursors = sources.map(() => 0);
  const timeline: TimelineEntry[] = [];
  for (;;) {
    let next = -1;
    for (let source = 0; source < sources.length; source += 1) {
      const candidate = sources[source]?.[cursors[source] ?? 0];
      if (candidate === undefined) continue;
      const current = next === -1 ? undefined : sources[next]?.[cursors[next] ?? 0];
      if (current === undefined || candidate.createdAt < current.createdAt) next = source;
    }
    if (next === -1) return timeline;
    const entry = sources[next]?.[cursors[next] ?? 0];
    if (entry !== undefined) timeline.push(entry);
    cursors[next] = (cursors[next] ?? 0) + 1;
  }
}

const threadStatus = (
  latestTurn: OrchestrationThread["latestTurn"],
): ScientThreadReadThread["status"] => {
  if (latestTurn === null) return "idle";
  return latestTurn.state === "error" ? "failed" : latestTurn.state;
};

const threadSummary = (thread: OrchestrationThread, itemCount: number): ScientThreadReadThread => ({
  threadId: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  status: threadStatus(thread.latestTurn),
  providerInstanceId: thread.modelSelection.instanceId,
  model: thread.modelSelection.model,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  parentThreadId: thread.forkLineage?.originThreadId ?? null,
  relationshipToParent: thread.forkLineage ? "fork" : null,
  itemCount,
  archived: thread.archivedAt !== null,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
});

/**
 * V2's page and text-window semantics: afterPosition is exclusive, itemId
 * ignores view and afterPosition, textOffset applies only with itemId, and
 * nextPosition is the last returned position (null only for an empty page).
 */
export function buildThreadReadResult(
  thread: OrchestrationThread,
  input: ScientThreadReadInput,
): ScientThreadReadResult {
  const timeline = buildThreadTimeline(thread);
  const view = input.view ?? "messages";
  const afterPosition = input.afterPosition ?? -1;
  const limit = input.limit ?? THREAD_READ_DEFAULT_LIMIT;
  const maxChars = input.maxCharsPerItem ?? THREAD_READ_DEFAULT_MAX_CHARS_PER_ITEM;
  const offset = input.itemId === undefined ? 0 : (input.textOffset ?? 0);
  const matching = timeline
    .map((entry, position) => ({ entry, position }))
    .filter(({ entry, position }) =>
      input.itemId === undefined
        ? position > afterPosition && (view === "activity" || MESSAGES_VIEW_TYPES.has(entry.type))
        : entry.itemId === input.itemId,
    );
  const page = matching.slice(0, limit);
  return {
    thread: threadSummary(thread, timeline.length),
    items: page.map(({ entry, position }) => {
      const end = offset + maxChars;
      const textTruncated = entry.text.length > end;
      return {
        position,
        itemId: entry.itemId,
        type: entry.type,
        status: entry.status,
        title: entry.title,
        activityKind: entry.activityKind,
        messageId: entry.messageId,
        turnId: entry.turnId,
        text: entry.text.slice(offset, end),
        textTruncated,
        nextTextOffset: textTruncated ? end : null,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      };
    }),
    nextPosition: page.at(-1)?.position ?? null,
    hasMore: matching.length > limit,
  };
}

const toolError = (code: ScientThreadReadToolError["code"], message: string) =>
  new ScientThreadReadToolError({ code, message });

const readFailed = (threadId: ThreadId) => () =>
  toolError("orchestration_error", `Thread ${threadId} could not be read.`);

function nativeThreadSummary(
  thread: OrchestrationV2ThreadShell,
  itemCount: number,
): ScientThreadReadThread {
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    status: thread.status,
    providerInstanceId: thread.modelSelection.instanceId,
    model: thread.modelSelection.model,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    parentThreadId: thread.lineage.parentThreadId,
    relationshipToParent: thread.lineage.relationshipToParent === "fork" ? "fork" : null,
    itemCount,
    archived: thread.archivedAt !== null,
    createdAt: DateTime.formatIso(thread.createdAt),
    updatedAt: DateTime.formatIso(thread.updatedAt),
  };
}

export function nativeTimelineEntry(row: OrchestrationV2ProjectedTurnItem): TimelineEntry {
  const { item } = row;
  let text: string;
  let type: ScientThreadReadItemType = "activity";
  let messageId: ScientThreadReadItem["messageId"] = null;
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      type = item.type;
      messageId = item.messageId;
      text = item.text;
      break;
    case "reasoning":
      type = "reasoning";
      text = item.text;
      break;
    case "proposed_plan":
      type = "proposed_plan";
      text = item.markdown;
      break;
    case "system_notice":
      type = "system_message";
      text = item.message;
      break;
    case "dynamic_tool":
      text = [item.title ?? item.toolName, payloadText(item.input), payloadText(item.output)]
        .filter((part) => part !== null)
        .join("\n");
      break;
    case "command_execution":
      text = [item.input, item.output].filter((part) => part !== undefined).join("\n");
      break;
    case "notification":
      text = [item.summary, item.detail].filter((part) => part !== undefined).join("\n");
      break;
    case "error":
      text = item.failure.message;
      break;
    default:
      text = payloadText(item) ?? "";
  }
  return {
    itemId: row.sourceItemId,
    type,
    status: ["pending", "running", "waiting"].includes(item.status) ? "running" : "completed",
    title: item.title,
    activityKind: type === "activity" ? item.type : null,
    messageId,
    turnId: item.runId === null ? (item.historyTurnId ?? null) : TurnId.make(item.runId),
    text,
    createdAt: DateTime.formatIso(item.startedAt ?? item.completedAt ?? item.updatedAt),
    updatedAt: DateTime.formatIso(item.updatedAt),
  };
}

/**
 * Authority comes from the host-issued invocation, never from the input: a
 * thread may read itself or another non-deleted thread in its own project.
 */
export const readScientThreadForInvocation = Effect.fn("ScientThreadsToolkit.read")(function* (
  input: ScientThreadReadInput,
) {
  const invocation = yield* AgentInvocationContext.AgentInvocationContext;
  if (!invocation.capabilities.has("threads:read")) {
    return yield* toolError(
      "capability_denied",
      "This provider session does not grant read access to T3 threads.",
    );
  }
  const projections = yield* ProjectionStoreV2;
  const importer = yield* LegacyV1ThreadImporter;
  const target = yield* projections
    .getThreadShell(input.threadId)
    .pipe(Effect.mapError(readFailed(input.threadId)));
  if (target === null) {
    return yield* toolError(
      "thread_not_found",
      `Thread ${input.threadId} does not exist or is no longer available.`,
    );
  }
  if (input.threadId !== invocation.threadId) {
    const caller = yield* projections
      .getThreadShell(invocation.threadId)
      .pipe(Effect.mapError(readFailed(input.threadId)));
    if (caller === null || caller.projectId !== target.projectId) {
      return yield* toolError(
        "thread_outside_project",
        `Thread ${input.threadId} is not in the calling thread's project. t3_thread_read only reads threads in the calling project.`,
      );
    }
  }
  yield* importer
    .ensureTranscript(input.threadId)
    .pipe(Effect.mapError(readFailed(input.threadId)));
  const page = yield* projections
    .getTimelinePage(input.threadId, {
      ...(input.afterPosition === undefined ? {} : { afterPosition: input.afterPosition }),
      ...(input.itemId === undefined ? {} : { itemId: TurnItemId.make(input.itemId) }),
      view: input.view ?? "messages",
      limit: input.limit ?? THREAD_READ_DEFAULT_LIMIT,
    })
    .pipe(Effect.mapError(readFailed(input.threadId)));
  const offset = input.itemId === undefined ? 0 : (input.textOffset ?? 0);
  const end = offset + (input.maxCharsPerItem ?? THREAD_READ_DEFAULT_MAX_CHARS_PER_ITEM);
  return {
    thread: nativeThreadSummary(target, page.totalItems),
    items: page.items.map((row) => {
      const entry = nativeTimelineEntry(row);
      return {
        ...entry,
        position: row.position,
        text: entry.text.slice(offset, end),
        textTruncated: entry.text.length > end,
        nextTextOffset: entry.text.length > end ? end : null,
      };
    }),
    nextPosition: page.items.at(-1)?.position ?? null,
    hasMore: page.hasMore,
  };
});

const handlers = {
  t3_thread_read: (input) => readScientThreadForInvocation(input),
} satisfies Parameters<typeof ScientThreadsToolkit.toLayer>[0];

export const ScientThreadsToolkitHandlersLive = ScientThreadsToolkit.toLayer(handlers);
