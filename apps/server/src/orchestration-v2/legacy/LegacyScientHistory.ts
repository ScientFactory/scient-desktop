import {
  EventId,
  NodeId,
  OrchestrationV2TurnItemJson,
  PlanId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { EventSinkV2Shape } from "../EventSink.ts";

interface HistoryRow {
  readonly item_id: string;
  readonly source: "message" | "system" | "activity" | "approval" | "plan";
  readonly created_at: string;
  readonly updated_at: string;
  readonly ordinal: number;
  readonly record_json: string;
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
const decodeActivity = Schema.decodeUnknownEffect(Schema.fromJsonString(Activity));
const decodeApproval = Schema.decodeUnknownEffect(Schema.fromJsonString(Approval));
const decodePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(Plan));
const decodeSystem = Schema.decodeUnknownEffect(Schema.fromJsonString(SystemMessage));
const decodeTurnItem = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);
const toolIdentity = Schema.decodeUnknownOption(Schema.Struct({ toolName: Schema.String }));

/** Reserve one chronological prefix for all legacy facts before any new run is admitted. */
export const prepareLegacyHistory = Effect.fn("LegacyScientHistory.prepare")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  includeArtifactDetails = false,
) {
  const includeDetails = includeArtifactDetails ? 1 : 0;
  const rows = yield* sql<HistoryRow>`
    WITH history AS (
      SELECT 'migration:v1:turn-item:' || message_id AS item_id, 'message' AS source,
        created_at, updated_at, 0 AS source_order, 0 AS ordering, '{}' AS record_json
      FROM projection_thread_messages WHERE thread_id = ${threadId} AND role IN ('user', 'assistant')
      UNION ALL
      SELECT 'migration:v1:history:system:' || message_id, 'system', created_at, updated_at, 1, 0,
        CASE WHEN ${includeDetails} = 1 THEN
          json_object('messageId', message_id, 'text', text, 'attachments', attachments_json, 'context', context_json)
        ELSE '{}' END
      FROM projection_thread_messages WHERE thread_id = ${threadId} AND role = 'system'
      UNION ALL
      SELECT 'migration:v1:history:activity:' || activity_id, 'activity', created_at, created_at, 2, COALESCE(sequence, 0),
        CASE WHEN ${includeDetails} = 1 THEN
          json_object('activityId', activity_id, 'turnId', turn_id, 'tone', tone, 'kind', kind,
            'summary', summary, 'sequence', sequence, 'payload', payload_json)
        ELSE '{}' END
      FROM projection_thread_activities WHERE thread_id = ${threadId}
      UNION ALL
      SELECT 'migration:v1:history:approval:' || request_id, 'approval', created_at, COALESCE(resolved_at, created_at), 3, 0,
        CASE WHEN ${includeDetails} = 1 THEN
          json_object('requestId', request_id, 'turnId', turn_id, 'status', status, 'decision', decision, 'resolvedAt', resolved_at)
        ELSE '{}' END
      FROM projection_pending_approvals WHERE thread_id = ${threadId}
      UNION ALL
      SELECT 'migration:v1:history:plan:' || plan_id, 'plan', created_at, updated_at, 4, 0,
        CASE WHEN ${includeDetails} = 1 THEN
          json_object('planId', plan_id, 'turnId', turn_id, 'markdown', plan_markdown, 'implementedAt', implemented_at)
        ELSE '{}' END
      FROM projection_thread_proposed_plans WHERE thread_id = ${threadId}
    )
    SELECT item_id, source, created_at, updated_at, record_json,
      ROW_NUMBER() OVER (ORDER BY created_at, source_order, ordering, item_id) AS ordinal
    FROM history ORDER BY ordinal
  `;
  // Reassign only the legacy prefix atomically: old message-only positions can
  // occupy the new artifact slots, and the ordinal index is unique per thread.
  yield* sql`DELETE FROM orchestration_v2_turn_item_positions WHERE thread_id = ${threadId}
    AND (turn_item_id LIKE 'migration:v1:turn-item:%' OR turn_item_id LIKE 'migration:v1:history:%')`;
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
  let events: OrchestrationV2DomainEvent[] = [];
  const existingPlans = new Set(
    (yield* sql<{ plan_id: string }>`SELECT plan_id FROM orchestration_v2_projection_plans
      WHERE thread_id = ${threadId}`).map((row) => row.plan_id),
  );
  const messages = yield* sql<{ payload_json: string; ordinal: number }>`
    SELECT items.payload_json, positions.ordinal
    FROM orchestration_v2_projection_turn_items AS items
    JOIN orchestration_v2_turn_item_positions AS positions
      ON positions.thread_id = items.thread_id AND positions.turn_item_id = items.turn_item_id
    WHERE items.thread_id = ${threadId}
      AND items.turn_item_id LIKE 'migration:v1:turn-item:%'
      AND items.ordinal <> positions.ordinal
  `;
  for (const message of messages) {
    const item = yield* decodeTurnItem(message.payload_json);
    events.push({
      id: EventId.make(`migration:v1:history:position:${item.id}:${message.ordinal}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: item.updatedAt,
      payload: { ...item, ordinal: message.ordinal },
    });
    if (events.length === 100) {
      yield* eventSink.write({ events });
      events = [];
      yield* Effect.yieldNow;
    }
  }
  for (const row of rows) {
    if (row.source === "message") continue;
    const alreadyImported = existing.has(row.item_id);
    if (alreadyImported && row.source !== "plan") continue;
    const base = {
      id: TurnItemId.make(row.item_id),
      threadId,
      runId: null,
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
      case "activity": {
        const record = yield* decodeActivity(row.record_json);
        const identity = toolIdentity(record.payload);
        item = {
          ...base,
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
        const previous = prior[0] ? yield* decodeTurnItem(prior[0].payload_json) : undefined;
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
      yield* eventSink.write({ events });
      events = [];
      yield* Effect.yieldNow;
    }
  }
  if (events.length > 0) yield* eventSink.write({ events });
});
