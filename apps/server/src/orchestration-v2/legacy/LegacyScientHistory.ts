import {
  EventId,
  NodeId,
  PlanId,
  RuntimeRequestId,
  UserInputAttachmentAnswerPayload,
  TurnItemId,
  TurnId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { EventSinkV2Shape } from "../EventSink.ts";
import { readInheritedTurnIds } from "./LegacyConversationOriginReader.ts";
import { decodeTurnItemRow } from "../scient-fork/projectionRowJson.ts";
import {
  groupToolLifecycles,
  mergeToolLifecyclePayloads,
  toolLifecycleOutcome,
  type ToolLifecycleOutcome,
} from "@scientfactory/conversation";

interface HistoryRow {
  readonly item_id: string;
  readonly turn_id: string | null;
  readonly source: "message" | "reasoning" | "system" | "activity" | "answer" | "approval" | "plan";
  readonly created_at: string;
  readonly updated_at: string;
  readonly ordinal: number;
  readonly record_json: string;
  /** Activity rows: the V1 kind and `payload.toolCallId`, to fold one tool call into one item. */
  readonly kind: string | null;
  readonly tool_call_id: string | null;
  /** A folded tool call: its merged record and how it ended. */
  readonly folded?: {
    readonly record: typeof Activity.Type;
    readonly status: ToolLifecycleOutcome;
  };
}

const Activity = Schema.Struct({
  activityId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  tone: Schema.String,
  kind: Schema.String,
  summary: Schema.String,
  sequence: Schema.NullOr(Schema.Number),
  payload: Schema.fromJsonString(Schema.Unknown),
});
const Approval = Schema.Struct({
  requestId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  status: Schema.String,
  decision: Schema.NullOr(Schema.String),
  resolvedAt: Schema.NullOr(Schema.String),
});
const Plan = Schema.Struct({
  planId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  markdown: Schema.String,
  implementedAt: Schema.NullOr(Schema.String),
});
const SystemMessage = Schema.Struct({
  messageId: Schema.String,
  text: Schema.String,
  attachments: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  context: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
});
const Reasoning = Schema.Struct({
  text: Schema.String,
  isStreaming: Schema.Literals([0, 1]),
});
class LegacyHistoryPositionError extends Schema.TaggedError<LegacyHistoryPositionError>()(
  "LegacyHistoryPositionError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return "Historical items exceed the reserved transcript position range.";
  }
}
const decodeActivity = Schema.decodeUnknownEffect(Schema.fromJsonString(Activity));
const decodeAnswer = Schema.decodeUnknownEffect(UserInputAttachmentAnswerPayload);
const decodeApproval = Schema.decodeUnknownEffect(Schema.fromJsonString(Approval));
const decodePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(Plan));
const decodeSystem = Schema.decodeUnknownEffect(Schema.fromJsonString(SystemMessage));
const decodeReasoning = Schema.decodeUnknownEffect(Schema.fromJsonString(Reasoning));
const toolIdentity = Schema.decodeUnknownOption(Schema.Struct({ toolName: Schema.String }));

/** V1 telemetry with no meaning in a V2 conversation: the context meter reads live usage. */
const DROPPED_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "context-window.updated",
  "checkpoint.captured",
]);

/**
 * One item per tool call: V1 stored a call as a started row, a row per
 * progress report and a completed row; V2 keeps one item per call. The folded
 * item takes the first row's id and place, ends at the last row, and keeps the
 * merged content of all of them. Telemetry rows are dropped.
 *
 * A thread an earlier build imported row by row, even partly, keeps that
 * shape: folding it would leave existing items without positions, or skip the
 * rest of a call whose first row was already imported.
 */
const foldToolCalls = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  rows: ReadonlyArray<HistoryRow>,
  includeDetails: boolean,
) {
  const kept = rows.filter((row) => row.kind === null || !DROPPED_ACTIVITY_KINDS.has(row.kind));
  const groups = groupToolLifecycles(
    kept.map((row) => ({ ...row, turnId: row.turn_id, toolCallId: row.tool_call_id })),
  );
  // A folded call keeps its first row's id and its last row's kind; an item an
  // earlier build imported for that same first row carries the first row's kind.
  const foldedKindById = new Map(
    groups.map((group) => [group[0]!.item_id, group.at(-1)!.kind] as const),
  );
  const importedRowByRow = (yield* sql<{ turn_item_id: string; kind: string | null }>`
    SELECT turn_item_id, json_extract(payload_json, '$.input.kind') AS kind
    FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ${threadId} AND turn_item_id LIKE 'migration:v1:history:activity:%'`).some(
    (row) =>
      !foldedKindById.has(row.turn_item_id) || foldedKindById.get(row.turn_item_id) !== row.kind,
  );
  if (importedRowByRow) return rows;
  const folded: HistoryRow[] = [];
  for (const group of groups) {
    const first = group[0]!;
    const last = group.at(-1)!;
    const isToolCall =
      first.tool_call_id !== null &&
      (first.kind === "tool.started" ||
        first.kind === "tool.updated" ||
        first.kind === "tool.completed");
    if (!isToolCall || !includeDetails) {
      folded.push({ ...first, updated_at: group.length > 1 ? last.created_at : first.updated_at });
      continue;
    }
    const records = yield* Effect.forEach(group, (row) => decodeActivity(row.record_json));
    folded.push({
      ...first,
      updated_at: last.created_at,
      folded: {
        record: {
          ...records.at(-1)!,
          activityId: records[0]!.activityId,
          sequence: records[0]!.sequence,
          payload: mergeToolLifecyclePayloads(records.map((record) => record.payload)),
        },
        status: toolLifecycleOutcome(records),
      },
    });
  }
  return folded;
});

/** Reserve one chronological prefix for all legacy facts before any new run is admitted. */
export const prepareLegacyHistory = Effect.fn("LegacyScientHistory.prepare")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  includeArtifactDetails = false,
) {
  const includeDetails = includeArtifactDetails ? 1 : 0;
  const chronologicalRows = yield* sql<HistoryRow>`
    WITH history AS (
      SELECT 'migration:v1:turn-item:' || message_id AS item_id, turn_id, 'message' AS source,
        created_at, updated_at, 0 AS source_order, 0 AS ordering, '{}' AS record_json,
        NULL AS kind, NULL AS tool_call_id
      FROM projection_thread_messages WHERE thread_id = ${threadId} AND role IN ('user', 'assistant')
      UNION ALL
      SELECT 'migration:v1:history:reasoning:' || message_id, turn_id, 'reasoning', created_at, updated_at, 0, 0,
        CASE WHEN ${includeDetails} = 1 THEN json_object('text', text, 'isStreaming', is_streaming)
        ELSE '{}' END, NULL, NULL
      FROM projection_thread_messages WHERE thread_id = ${threadId} AND role = 'reasoning'
      UNION ALL
      SELECT 'migration:v1:history:system:' || message_id, turn_id, 'system', created_at, updated_at, 1, 0,
        CASE WHEN ${includeDetails} = 1 THEN
          json_object('messageId', message_id, 'text', text, 'attachments', attachments_json, 'context', context_json)
        ELSE '{}' END, NULL, NULL
      FROM projection_thread_messages WHERE thread_id = ${threadId} AND role = 'system'
      UNION ALL
      SELECT 'migration:v1:history:activity:' || activity_id, turn_id, 'activity', created_at, created_at, 2, COALESCE(sequence, 0),
        CASE WHEN ${includeDetails} = 1 THEN
          json_object('activityId', activity_id, 'turnId', turn_id, 'tone', tone, 'kind', kind,
            'summary', summary, 'sequence', sequence, 'payload', payload_json)
        ELSE '{}' END, kind,
        CASE WHEN json_valid(payload_json) THEN
          CASE WHEN json_type(payload_json, '$.toolCallId') = 'text'
            THEN json_extract(payload_json, '$.toolCallId') END
        END
      FROM projection_thread_activities WHERE thread_id = ${threadId}
      UNION ALL
      SELECT 'migration:v1:history:answer:' || activity_id, turn_id, 'answer', created_at, created_at, 2, COALESCE(sequence, 0),
        CASE WHEN ${includeDetails} = 1 THEN
          json_object('activityId', activity_id, 'turnId', turn_id, 'tone', tone, 'kind', kind,
            'summary', summary, 'sequence', sequence, 'payload', payload_json)
        ELSE '{}' END, NULL, NULL
      FROM projection_thread_activities WHERE thread_id = ${threadId} AND kind = 'user-input.answer-submitted'
      UNION ALL
      SELECT 'migration:v1:history:approval:' || request_id, turn_id, 'approval', created_at, COALESCE(resolved_at, created_at), 3, 0,
        CASE WHEN ${includeDetails} = 1 THEN
          json_object('requestId', request_id, 'turnId', turn_id, 'status', status, 'decision', decision, 'resolvedAt', resolved_at)
        ELSE '{}' END, NULL, NULL
      FROM projection_pending_approvals WHERE thread_id = ${threadId}
      UNION ALL
      SELECT 'migration:v1:history:plan:' || plan_id, turn_id, 'plan', created_at, updated_at, 4, 0,
        CASE WHEN ${includeDetails} = 1 THEN
          json_object('planId', plan_id, 'turnId', turn_id, 'markdown', plan_markdown, 'implementedAt', implemented_at)
        ELSE '{}' END, NULL, NULL
      FROM projection_thread_proposed_plans WHERE thread_id = ${threadId}
    )
    SELECT item_id, turn_id, source, created_at, updated_at, record_json, kind, tool_call_id,
      ROW_NUMBER() OVER (ORDER BY created_at, source_order, ordering, item_id) AS ordinal
    FROM history ORDER BY ordinal
  `;
  const historyRows = yield* foldToolCalls(
    sql,
    threadId,
    chronologicalRows,
    includeArtifactDetails,
  );
  // Copied turns have a durable order even when copied message timestamps tie.
  // Keep the entire inherited prefix ahead of later local history; a refork must
  // never borrow an unanswered request from after its selected answer.
  const inheritedOrder = new Map(
    [...(yield* readInheritedTurnIds(sql, threadId))].map((turnId, index) => [turnId, index]),
  );
  const rows = historyRows
    .toSorted((left, right) => {
      const leftTurn = inheritedOrder.get(left.turn_id ?? "");
      const rightTurn = inheritedOrder.get(right.turn_id ?? "");
      if (leftTurn !== undefined || rightTurn !== undefined) {
        const difference = (leftTurn ?? Infinity) - (rightTurn ?? Infinity);
        if (difference !== 0) return difference;
      }
      return left.ordinal - right.ordinal;
    })
    .map((row, index) => ({ ...row, ordinal: index + 1 }));
  // Reassign only the legacy prefix atomically: old message-only positions can
  // occupy the new artifact slots, and the ordinal index is unique per thread.
  yield* sql`DELETE FROM orchestration_v2_turn_item_positions WHERE thread_id = ${threadId}
    AND (turn_item_id LIKE 'migration:v1:turn-item:%' OR turn_item_id LIKE 'migration:v1:history:%')`;
  // Completed imports may already have native runless notices after the old
  // prefix. Move only the colliding suffix, preserving its order and payloads.
  const suffix = yield* sql<{ turn_item_id: string; ordinal: number }>`
    SELECT turn_item_id, ordinal FROM orchestration_v2_turn_item_positions
    WHERE thread_id = ${threadId} AND ordinal < 1000000 ORDER BY ordinal`;
  let previousOrdinal = rows.length;
  const moved = suffix.flatMap((position) => {
    const ordinal = Math.max(position.ordinal, previousOrdinal + 1);
    previousOrdinal = ordinal;
    return ordinal === position.ordinal ? [] : [{ ...position, ordinal }];
  });
  if (previousOrdinal >= 1000000) {
    return yield* new LegacyHistoryPositionError({ threadId });
  }
  for (const position of moved.toReversed()) {
    yield* sql`UPDATE orchestration_v2_turn_item_positions SET ordinal = ${position.ordinal}
      WHERE thread_id = ${threadId} AND turn_item_id = ${position.turn_item_id}`;
  }
  for (const row of rows) {
    yield* sql`INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
      VALUES (${threadId}, ${row.item_id}, ${row.ordinal})`;
  }
  return rows;
});

/** Historical approvals have no RuntimeRequest, provider session, or effect-outbox authority. */
export const importLegacyHistory = Effect.fn("LegacyScientHistory.import")(function* (
  sql: SqlClient.SqlClient,
  eventSink: EventSinkV2Shape,
  threadId: ThreadId,
  rows: ReadonlyArray<HistoryRow>,
) {
  const existing = new Set(
    (yield* sql<{ event_id: string }>`SELECT event_id FROM orchestration_events
    WHERE application_event_version = 2 AND stream_id = ${threadId} AND event_id LIKE 'migration:v1:history:%'`).map(
      (row) => row.event_id,
    ),
  );
  for (const row of yield* sql<{ turn_item_id: string }>`
    SELECT turn_item_id FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ${threadId} AND turn_item_id LIKE 'migration:v1:history:answer:%'`) {
    existing.add(row.turn_item_id);
  }
  let events: OrchestrationV2DomainEvent[] = [];
  const existingPlans = new Set(
    (yield* sql<{ plan_id: string }>`SELECT plan_id FROM orchestration_v2_projection_plans
      WHERE thread_id = ${threadId}`).map((row) => row.plan_id),
  );
  const positionedItems = yield* sql<{ payload_json: string; ordinal: number }>`
    SELECT items.payload_json, positions.ordinal
    FROM orchestration_v2_projection_turn_items AS items
    JOIN orchestration_v2_turn_item_positions AS positions
      ON positions.thread_id = items.thread_id AND positions.turn_item_id = items.turn_item_id
    WHERE items.thread_id = ${threadId}
      AND positions.ordinal < 1000000
    ORDER BY positions.ordinal DESC
  `;
  const historicalTurns = new Map(
    rows.flatMap((row) =>
      row.turn_id === null ? [] : [[row.item_id, TurnId.make(row.turn_id)] as const],
    ),
  );
  for (const positioned of positionedItems) {
    const item = yield* decodeTurnItemRow(positioned.payload_json);
    const historyTurnId = item.historyTurnId ?? historicalTurns.get(item.id);
    if (item.ordinal === positioned.ordinal && historyTurnId === item.historyTurnId) continue;
    events.push({
      id: EventId.make(`migration:v1:history:position:${item.id}:${positioned.ordinal}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: item.updatedAt,
      payload: {
        ...item,
        ordinal: positioned.ordinal,
        ...(historyTurnId === undefined ? {} : { historyTurnId }),
      },
    });
    if (events.length === 100) {
      yield* eventSink.write({ events, guardTurnItemPositionRepairs: true });
      events = [];
      yield* Effect.yieldNow;
    }
  }
  if (events.length > 0) {
    yield* eventSink.write({ events, guardTurnItemPositionRepairs: true });
    events = [];
  }
  for (const row of rows) {
    if (row.source === "message") continue;
    const alreadyImported = existing.has(row.item_id);
    if (alreadyImported && row.source !== "plan") continue;
    const base = {
      id: TurnItemId.make(row.item_id),
      threadId,
      runId: null,
      ...(row.turn_id === null ? {} : { historyTurnId: TurnId.make(row.turn_id) }),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: row.ordinal,
      status: "completed" as const,
      startedAt: DateTime.makeUnsafe(row.created_at),
      completedAt: DateTime.makeUnsafe(row.updated_at),
      updatedAt: DateTime.makeUnsafe(row.updated_at),
    };
    let item: OrchestrationV2TurnItem;
    switch (row.source) {
      case "reasoning": {
        const record = yield* decodeReasoning(row.record_json);
        item = {
          ...base,
          type: "reasoning",
          title: null,
          text: record.text,
          streaming: false,
          status: record.isStreaming === 1 ? "interrupted" : "completed",
        };
        break;
      }
      case "activity": {
        const record = row.folded?.record ?? (yield* decodeActivity(row.record_json));
        const identity = toolIdentity(record.payload);
        item = {
          ...base,
          ...(row.folded === undefined ? {} : { status: row.folded.status }),
          type: "dynamic_tool",
          title: record.summary,
          toolName:
            identity._tag === "Some" && identity.value.toolName.trim() !== ""
              ? identity.value.toolName
              : record.kind,
          input: record,
          ...(typeof record.payload === "object" &&
          record.payload !== null &&
          "output" in record.payload
            ? { output: record.payload.output }
            : {}),
        };
        break;
      }
      case "answer": {
        const record = yield* decodeActivity(row.record_json);
        const payload = record.payload;
        const answer = yield* decodeAnswer(
          typeof payload === "object" && payload !== null
            ? { attachmentsByQuestionId: {}, ...payload }
            : payload,
        );
        // A separate historical fact preserves the original work-log audit and
        // never adopts a pending request, native callback, node or run.
        item = {
          ...base,
          type: "user_input_request",
          title: "Historical submitted answer",
          requestId: RuntimeRequestId.make(`migration:v1:answer:${record.activityId}`),
          questions: Object.keys(answer.answers).map((id) => ({
            id,
            header: "Question",
            question: answer.questionTextById?.[id]?.trim() || id,
            options: [],
          })),
          questionAnswer: answer,
        };
        break;
      }
      case "approval": {
        const record = yield* decodeApproval(row.record_json);
        item = {
          ...base,
          type: "dynamic_tool",
          title: "Historical approval",
          toolName: "historical_approval",
          status: record.status === "pending" ? "interrupted" : "completed",
          input: record,
        };
        break;
      }
      case "plan": {
        const record = yield* decodePlan(row.record_json);
        if (alreadyImported && existingPlans.has(record.planId)) continue;
        const nodeId = NodeId.make(`migration:v1:history:plan-node:${record.planId}`);
        // Repair imports from the earlier message/item-only format without
        // replacing text that a user has since edited in V2.
        const prior = alreadyImported
          ? yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM orchestration_v2_projection_turn_items
              WHERE thread_id = ${threadId} AND turn_item_id = ${row.item_id}`
          : [];
        const previous = prior[0] ? yield* decodeTurnItemRow(prior[0].payload_json) : undefined;
        const markdown = previous?.type === "proposed_plan" ? previous.markdown : record.markdown;
        item = {
          ...base,
          type: "proposed_plan",
          title: "Historical proposed plan",
          planId: PlanId.make(record.planId),
          nodeId,
          markdown,
          streaming: false,
        };
        if (previous?.type === "proposed_plan") {
          item = { ...previous, nodeId };
          events.push({
            id: EventId.make(`${row.item_id}:artifact-item`),
            type: "turn-item.updated",
            threadId,
            occurredAt: item.updatedAt,
            payload: item,
          });
        }
        events.push(
          {
            id: EventId.make(`${row.item_id}:node`),
            type: "node.updated",
            threadId,
            occurredAt: item.updatedAt,
            payload: {
              id: nodeId,
              threadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: nodeId,
              kind: "plan",
              status: "completed",
              countsForRun: false,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: item.startedAt,
              completedAt: item.completedAt,
            },
          },
          {
            id: EventId.make(`${row.item_id}:artifact`),
            type: "plan.updated",
            threadId,
            occurredAt: item.updatedAt,
            payload: {
              id: item.planId,
              threadId,
              runId: null,
              nodeId,
              kind: "proposed_plan",
              status: record.implementedAt === null ? "active" : "completed",
              markdown,
            },
          },
        );
        break;
      }
      case "system":
        item = {
          ...base,
          type: "dynamic_tool",
          title: "Historical system message",
          toolName: "historical_system_message",
          input: yield* decodeSystem(row.record_json),
        };
        break;
    }
    if (!alreadyImported)
      events.push({
        id: EventId.make(row.item_id),
        type: "turn-item.updated",
        threadId,
        occurredAt: item.updatedAt,
        payload: item,
      });
    if (events.length >= 100) {
      yield* eventSink.write({ events, guardLegacyQuestionInsertions: true });
      events = [];
      yield* Effect.yieldNow;
    }
  }
  if (events.length > 0) yield* eventSink.write({ events, guardLegacyQuestionInsertions: true });
});
