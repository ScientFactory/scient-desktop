import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type ChatAttachment,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as LegacyImporter from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer);
const sink = EventSink.layer.pipe(Layer.provideMerge(stores));
export const nativeExportStorage = LegacyImporter.layer.pipe(Layer.provideMerge(sink));
const at = (index: number) =>
  DateTime.makeUnsafe(Date.parse("2026-09-27T10:00:00.000Z") + index * 1000);

/** Export fixtures commit native journal facts; they have no provider or effect worker. */
export const seedNativeExportThread = Effect.fn("seedNativeExportThread")(function* (input: {
  threadId: ThreadId;
  title: string;
  pairs: number;
  activitiesPerTurn?: number;
  running?: boolean;
  firstUserText?: string;
  reasoning?: boolean;
  attachmentsForPrompt: (pair: number) => ReadonlyArray<ChatAttachment>;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
    VALUES ('project-1', 'Project', '/work/project', '[]', ${DateTime.formatIso(at(0))}, ${DateTime.formatIso(at(0))}, NULL)`;
  const threadId = input.threadId;
  const instanceId = ProviderInstanceId.make("codex");
  const modelSelection = { instanceId, model: "gpt-5" };
  const events: OrchestrationV2DomainEvent[] = [
    {
      id: EventId.make(`${threadId}:created`),
      type: "thread.created",
      threadId,
      occurredAt: at(0),
      payload: {
        id: threadId,
        createdBy: "user",
        creationSource: "web",
        projectId: ProjectId.make("project-1"),
        title: input.title,
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: at(0),
        updatedAt: at(0),
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    },
  ];
  let clock = 1;
  let ordinal = 0;
  let activity = 0;
  const addItem = (item: OrchestrationV2TurnItem) =>
    events.push({
      id: EventId.make(`${item.id}:updated`),
      type: "turn-item.updated",
      threadId,
      occurredAt: item.updatedAt,
      payload: item,
    });
  for (let pair = 1; pair <= input.pairs; pair++) {
    const runId = RunId.make(`turn-${pair}`);
    const requestedAt = at(clock);
    const active = input.running === true && pair === input.pairs;
    const base = () => ({
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      title: null,
      ordinal: ordinal++,
      status: "completed" as const,
      startedAt: at(clock),
      completedAt: at(clock),
      updatedAt: at(clock),
    });
    const userId = MessageId.make(`user-${pair}`);
    const userText = pair === 1 ? (input.firstUserText ?? `Question ${pair}`) : `Question ${pair}`;
    const attachments = input.attachmentsForPrompt(pair);
    events.push({
      id: EventId.make(`message:${userId}:updated`),
      type: "message.updated",
      threadId,
      occurredAt: at(clock),
      payload: {
        id: userId,
        threadId,
        runId,
        nodeId: null,
        role: "user",
        text: userText,
        attachments,
        createdBy: "user",
        creationSource: "web",
        createdAt: at(clock),
        updatedAt: at(clock),
        streaming: false,
      },
    });
    addItem({
      ...base(),
      id: TurnItemId.make(userId),
      type: "user_message",
      messageId: userId,
      createdBy: "user",
      creationSource: "web",
      inputIntent: "turn_start",
      text: userText,
      attachments,
    });
    clock++;
    for (let step = 0; step < (input.activitiesPerTurn ?? 0); step++) {
      activity++;
      addItem({
        ...base(),
        id: TurnItemId.make(`activity-${activity}`),
        type: "dynamic_tool",
        toolName: "command_execution",
        input: {
          kind: "tool.completed",
          summary: "Ran command",
          tone: "tool",
          payload: {
            itemType: "command_execution",
            toolCallId: `call-${activity}`,
            title: "Ran command",
            data: { item: { command: `echo ${activity}` }, token: "sk-hidden" },
          },
        },
        output: null,
      });
      clock++;
    }
    if (input.reasoning) {
      addItem({
        ...base(),
        id: TurnItemId.make(`reasoning-${pair}`),
        type: "reasoning",
        text: `Thinking ${pair}`,
        streaming: false,
      });
      clock++;
    }
    const assistantId = MessageId.make(`assistant-${pair}`);
    events.push({
      id: EventId.make(`message:${assistantId}:updated`),
      type: "message.updated",
      threadId,
      occurredAt: at(clock),
      payload: {
        id: assistantId,
        threadId,
        runId,
        nodeId: null,
        role: "assistant",
        text: `Answer ${pair}`,
        attachments: [],
        createdBy: "agent",
        creationSource: "provider",
        createdAt: at(clock),
        updatedAt: at(clock),
        streaming: active,
      },
    });
    addItem({
      ...base(),
      id: TurnItemId.make(assistantId),
      type: "assistant_message",
      messageId: assistantId,
      text: `Answer ${pair}`,
      streaming: active,
      status: active ? "running" : "completed",
      completedAt: active ? null : at(clock),
    });
    clock++;
    events.push({
      id: EventId.make(`${runId}:updated`),
      type: "run.updated",
      threadId,
      occurredAt: at(clock),
      payload: {
        id: runId,
        threadId,
        ordinal: pair,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: userId,
        rootNodeId: null,
        activeAttemptId: null,
        status: active ? "running" : "completed",
        requestedAt,
        startedAt: requestedAt,
        completedAt: active ? null : at(clock),
        checkpointId: null,
        contextHandoffId: null,
      },
    });
  }
  yield* (yield* EventSink.EventSinkV2).write({ events });
});

export const updateNativeExportThread = Effect.fn("updateNativeExportThread")(function* (
  threadId: ThreadId,
  input: { title?: string; activityPayload?: unknown },
) {
  const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
    threadId,
  );
  const now = yield* DateTime.now;
  const events: OrchestrationV2DomainEvent[] = [];
  if (input.title !== undefined)
    events.push({
      id: EventId.make(`rename:${input.title}`),
      type: "thread.metadata-updated",
      threadId,
      occurredAt: now,
      payload: { ...projection.thread, title: input.title, updatedAt: now },
    });
  for (const item of projection.turnItems) {
    if (input.activityPayload !== undefined && item.type === "dynamic_tool") {
      events.push({
        id: EventId.make(`edit:${item.id}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...item,
          input: {
            kind: "tool.completed",
            summary: "Ran command",
            tone: "tool",
            payload: input.activityPayload,
          },
        },
      });
    }
  }
  yield* (yield* EventSink.EventSinkV2).write({ events });
});
