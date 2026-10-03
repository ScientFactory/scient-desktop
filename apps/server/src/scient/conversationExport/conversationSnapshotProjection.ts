import {
  EventId,
  MessageId,
  OrchestrationThreadActivity,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { ConversationSnapshotThread } from "@scientfactory/conversation";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const historicalActivity = Schema.Struct({
  kind: Schema.String,
  summary: Schema.String,
  tone: OrchestrationThreadActivity.fields.tone,
  payload: Schema.Unknown,
});
const isHistoricalActivity = Schema.is(historicalActivity);

/** Durable visible items feed the portable export format, including frozen inherited history. */
export function conversationSnapshotProjection(
  projection: OrchestrationV2ThreadProjection,
  workspaceRoot: string | null,
): ConversationSnapshotThread {
  const messages: OrchestrationMessage[] = [];
  const activities: OrchestrationThreadActivity[] = [];
  const proposedPlans: ConversationSnapshotThread["proposedPlans"][number][] = [];
  const messageById = new Map(projection.messages.map((message) => [message.id, message]));
  const planById = new Map(projection.plans.map((plan) => [plan.id, plan]));
  const group = (item: OrchestrationV2TurnItem) =>
    item.runId === null
      ? (item.historyTurnId ??
        (item.inheritedFrom?.runId == null ? null : TurnId.make(item.inheritedFrom.runId)))
      : TurnId.make(item.runId);
  for (const { item } of projection.visibleTurnItems.toSorted((a, b) => a.position - b.position)) {
    const createdAt = DateTime.formatIso(item.startedAt ?? item.completedAt ?? item.updatedAt);
    const updatedAt = DateTime.formatIso(item.updatedAt);
    const turnId = group(item);
    const activity = (
      kind: string,
      summary: string,
      payload: unknown,
      tone: OrchestrationThreadActivity["tone"] = "info",
    ) =>
      activities.push({
        id: EventId.make(item.id),
        turnId,
        createdAt,
        kind,
        summary,
        payload,
        tone,
      });
    switch (item.type) {
      case "user_message":
      case "assistant_message": {
        const message = messageById.get(item.messageId);
        messages.push({
          id: item.messageId,
          role: item.type === "user_message" ? "user" : "assistant",
          turnId,
          text: item.text,
          streaming: item.type === "assistant_message" && item.streaming,
          attachments: item.attachments ?? message?.attachments ?? [],
          ...(item.type === "user_message" && item.context !== undefined
            ? { context: item.context }
            : message?.context === undefined
              ? {}
              : { context: message.context }),
          createdAt: message === undefined ? createdAt : DateTime.formatIso(message.createdAt),
          updatedAt,
        });
        break;
      }
      case "reasoning":
        messages.push({
          id: MessageId.make(item.id),
          role: "reasoning",
          turnId,
          text: item.text,
          streaming: item.streaming,
          createdAt,
          updatedAt,
        });
        break;
      case "system_notice":
        messages.push({
          id: MessageId.make(item.id),
          role: "system",
          turnId,
          text: item.message,
          streaming: false,
          createdAt,
          updatedAt,
        });
        break;
      case "proposed_plan":
        proposedPlans.push({
          id: item.planId,
          turnId,
          planMarkdown: item.markdown,
          implementedAt: planById.get(item.planId)?.status === "completed" ? updatedAt : null,
          implementationThreadId: null,
          createdAt,
          updatedAt,
        });
        break;
      case "dynamic_tool":
        if (isHistoricalActivity(item.input)) {
          activity(item.input.kind, item.input.summary, item.input.payload, item.input.tone);
        } else {
          activity(
            "tool.completed",
            item.title ?? item.toolName ?? "Tool call",
            {
              title: item.title ?? item.toolName,
              status: item.status,
              data: {
                toolName: item.toolName,
                item: {
                  input: item.input,
                  aggregatedOutput:
                    typeof item.output === "string" ? item.output : JSON.stringify(item.output),
                },
              },
            },
            "tool",
          );
        }
        break;
      case "command_execution":
        activity(
          "tool.completed",
          item.title ?? "Command",
          {
            title: item.title ?? "Command",
            status: item.status,
            data: {
              item: { command: item.input, aggregatedOutput: item.output, exitCode: item.exitCode },
            },
          },
          "tool",
        );
        break;
      case "file_change":
        activity(
          "tool.completed",
          item.title ?? item.fileName,
          {
            title: item.title ?? item.fileName,
            status: item.status,
            data: { item: { changes: item.changes ?? [{ path: item.fileName }] } },
          },
          "tool",
        );
        break;
      case "file_search":
      case "web_search":
        activity(
          "tool.completed",
          item.title ?? "Search",
          {
            title: item.title ?? "Search",
            status: item.status,
            data: { toolName: item.type, item },
          },
          "tool",
        );
        break;
      case "todo_list":
        activity("turn.plan.updated", item.title ?? "Plan updated", {
          explanation: item.explanation,
          plan: item.steps.map((step) => ({
            step: step.text,
            status: step.status === "running" ? "inProgress" : step.status,
          })),
        });
        break;
      case "compaction":
        activity("context-compaction", item.title ?? "Context compacted", {});
        break;
      case "user_input_request":
        if (item.questionAnswer !== undefined) {
          activity("user-input.answer-submitted", item.title ?? "Question answer submitted", {
            ...item.questionAnswer,
            questionTextById: Object.fromEntries(item.questions.map((q) => [q.id, q.question])),
          });
        }
        break;
      case "error":
        activity("runtime.error", item.failure.message, { message: item.failure.message }, "error");
        break;
    }
  }
  const active = projection.runs.findLast((run) =>
    ["preparing", "starting", "running", "waiting"].includes(run.status),
  );
  const thread = projection.thread;
  return {
    id: thread.id,
    title: thread.title,
    createdAt: DateTime.formatIso(thread.createdAt),
    updatedAt: DateTime.formatIso(thread.updatedAt),
    workspaceRoot,
    worktreePath: thread.worktreePath,
    modelSelection: thread.modelSelection,
    providerName:
      projection.providerSessions.find(
        (session) =>
          session.id ===
          projection.providerThreads.find(
            (providerThread) => providerThread.id === thread.activeProviderThreadId,
          )?.providerSessionId,
      )?.driver ?? null,
    activeTurn:
      active === undefined
        ? null
        : { turnId: TurnId.make(active.id), requestedAt: DateTime.formatIso(active.requestedAt) },
    conversationImport: thread.conversationImport ?? null,
    forkLineage: thread.forkLineage ?? null,
    messages,
    activities,
    proposedPlans,
  };
}
