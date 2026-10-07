import {
  TurnId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadShell,
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
  type ScientThreadReadThread,
  ScientThreadReadToolError,
  ScientThreadsToolkit,
} from "./tools.ts";

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

const payloadText = (payload: unknown): string | null => {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload) ?? null;
  } catch {
    return null;
  }
};

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

function nativeTimelineEntry(row: OrchestrationV2ProjectedTurnItem): TimelineEntry {
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
      "This provider session does not grant read access to Scient threads.",
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
        `Thread ${input.threadId} is not in the calling thread's project. scient_thread_read only reads threads in the calling project.`,
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
  scient_thread_read: (input) => readScientThreadForInvocation(input),
} satisfies Parameters<typeof ScientThreadsToolkit.toLayer>[0];

export const ScientThreadsToolkitHandlersLive = ScientThreadsToolkit.toLayer(handlers);
