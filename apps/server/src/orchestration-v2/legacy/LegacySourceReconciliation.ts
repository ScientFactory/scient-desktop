import * as NodeUtil from "node:util";

import {
  EventId,
  MessageId,
  TurnItemId,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2TurnItemJson,
  OrchestrationV2PlanArtifact,
  PlanId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import type { EventSinkV2Shape } from "../EventSink.ts";

type HistoryEvent = Extract<
  OrchestrationV2DomainEvent,
  { type: "message.updated" | "turn-item.updated" | "plan.updated" }
>;
const encodeMessage = Schema.encodeSync(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const encodeItem = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const encodePlan = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2PlanArtifact));
const RecordJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeRecord = Schema.decodeUnknownSync(RecordJson);
const comparable = (json: string) => {
  const {
    ordinal: _ordinal,
    historyTurnId: _turn,
    updatedAt: _updated,
    ...content
  } = decodeRecord(json);
  return content;
};
const sameContent = (left: string, right: string) =>
  NodeUtil.isDeepStrictEqual(comparable(left), comparable(right));
const entity = (event: HistoryEvent) =>
  event.type === "message.updated" ? "message" : event.type === "plan.updated" ? "plan" : "item";
const encode = (event: HistoryEvent) =>
  event.type === "message.updated"
    ? encodeMessage(event.payload)
    : event.type === "plan.updated"
      ? encodePlan(event.payload)
      : encodeItem(event.payload);
const group = (event: HistoryEvent) =>
  event.type === "message.updated"
    ? `message:${event.payload.id}`
    : event.type === "plan.updated"
      ? `plan:${event.payload.id}`
      : event.payload.type === "proposed_plan"
        ? `plan:${event.payload.planId}`
        : event.payload.type === "user_message" || event.payload.type === "assistant_message"
          ? `message:${event.payload.messageId}`
          : `item:${event.payload.id}`;

/**
 * Source updates recheck the current entity inside the EventSink transaction.
 * A changed V2 entity retains its identity/content; the V1 version is added as
 * labelled inert history. Stable revision identities make retries idempotent.
 */
export const writeLegacySourceEvents = Effect.fn("writeLegacySourceEvents")(function* (
  sql: SqlClient.SqlClient,
  sink: EventSinkV2Shape,
  candidates: ReadonlyArray<OrchestrationV2DomainEvent>,
  revision: number,
  expected: ReadonlyMap<string, OrchestrationV2DomainEvent> = new Map(),
) {
  const events: OrchestrationV2DomainEvent[] = [];
  const committed = yield* sink.write({
    events: [],
    guardLegacyQuestionInsertions: true,
    transactionHooks: {
      prepare: Effect.void,
      prepareEvents: Effect.gen(function* () {
        const histories = candidates.filter(
          (event): event is HistoryEvent =>
            event.type === "message.updated" ||
            event.type === "turn-item.updated" ||
            event.type === "plan.updated",
        );
        const conflicts = new Set<string>();
        const representedGroups = new Set(histories.map(group));
        const current = new Map<string, string>();
        for (const event of histories) {
          const rows =
            event.type === "message.updated"
              ? yield* sql<{
                  payload_json: string;
                }>`SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id = ${event.threadId} AND message_id = ${event.payload.id}`
              : event.type === "plan.updated"
                ? yield* sql<{
                    payload_json: string;
                  }>`SELECT payload_json FROM orchestration_v2_projection_plans WHERE thread_id = ${event.threadId} AND plan_id = ${event.payload.id}`
                : yield* sql<{
                    payload_json: string;
                  }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id = ${event.threadId} AND turn_item_id = ${event.payload.id}`;
          const row = rows[0];
          if (row === undefined) {
            representedGroups.delete(group(event));
            continue;
          }
          current.set(event.id, row.payload_json);
          if (revision === 0 || sameContent(row.payload_json, encode(event))) continue;
          const [previous] = yield* sql<{
            source_json: string;
          }>`SELECT source_json FROM scient_legacy_reconciliation_entities
          WHERE thread_id = ${event.threadId} AND entity_type = ${entity(event)} AND entity_id = ${event.payload.id}`;
          const [recovered] = yield* sql<{
            source_json: string;
          }>`SELECT source_json FROM scient_legacy_reconciliation_entities
          WHERE thread_id = ${event.threadId} AND entity_type = ${`recovered:${entity(event)}`} AND entity_id = ${event.payload.id}`;
          if (recovered === undefined || !sameContent(recovered.source_json, encode(event)))
            representedGroups.delete(group(event));
          const fallback = expected.get(event.id);
          const [original] = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM orchestration_events
          WHERE event_id = ${event.id} AND application_event_version = 2`;
          const baseline =
            previous?.source_json ??
            (fallback?.type === "message.updated" || fallback?.type === "turn-item.updated"
              ? encode(fallback)
              : undefined) ??
            original?.payload_json;
          if (baseline === undefined || !sameContent(row.payload_json, baseline))
            conflicts.add(group(event));
        }
        const labelled = new Set<string>();
        for (const candidate of candidates) {
          if (
            candidate.type !== "message.updated" &&
            candidate.type !== "turn-item.updated" &&
            candidate.type !== "plan.updated"
          ) {
            events.push(candidate);
            continue;
          }
          const event = candidate;
          const desired = encode(event);
          yield* sql`INSERT INTO scient_legacy_reconciliation_entities (thread_id, entity_type, entity_id, source_json)
          VALUES (${event.threadId}, ${entity(event)}, ${event.payload.id}, ${desired})
          ON CONFLICT (thread_id, entity_type, entity_id) DO UPDATE SET source_json = excluded.source_json`;
          // A different source revision may add history without changing this
          // conflict. Keep its recovered version instead of adding it again.
          if (representedGroups.has(group(event))) continue;
          const existing = current.get(event.id);
          const conflict = conflicts.has(group(event));
          if (
            existing !== undefined &&
            (revision === 0 || (!conflict && sameContent(existing, desired)))
          )
            continue;
          if (conflict) {
            yield* sql`INSERT INTO scient_legacy_reconciliation_entities (thread_id, entity_type, entity_id, source_json)
            VALUES (${event.threadId}, ${`recovered:${entity(event)}`}, ${event.payload.id}, ${desired})
            ON CONFLICT (thread_id, entity_type, entity_id) DO UPDATE SET source_json = excluded.source_json`;
            const identity = `migration:v1:recovered:${revision}:${group(event)}`;
            if (!labelled.has(identity)) {
              labelled.add(identity);
              events.push({
                id: EventId.make(`${identity}:notice`),
                type: "turn-item.updated",
                threadId: event.threadId,
                occurredAt: event.occurredAt,
                payload: {
                  id: TurnItemId.make(`${identity}:notice`),
                  threadId: event.threadId,
                  runId: null,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 0,
                  type: "dynamic_tool",
                  status: "completed",
                  title: "Recovered V1 version",
                  toolName: "historical_recovery",
                  input: {
                    reason: "Your V2 changes were preserved. The original V1 version follows.",
                    sourceId: event.payload.id,
                  },
                  startedAt: event.occurredAt,
                  completedAt: event.occurredAt,
                  updatedAt: event.occurredAt,
                },
              });
            }
            const version = `migration:v1:recovered:${revision}:${event.payload.id}`;
            if (event.type === "message.updated") {
              events.push({
                ...event,
                id: EventId.make(`${identity}:message`),
                payload: { ...event.payload, id: MessageId.make(version) },
              });
            } else if (event.type === "plan.updated") {
              events.push({
                ...event,
                id: EventId.make(`${identity}:plan`),
                payload: { ...event.payload, id: PlanId.make(version) },
              });
            } else {
              const item = event.payload;
              events.push({
                ...event,
                id: EventId.make(`${identity}:item`),
                payload: {
                  ...item,
                  id: TurnItemId.make(version),
                  ...(item.type === "user_message" || item.type === "assistant_message"
                    ? {
                        messageId: MessageId.make(
                          `migration:v1:recovered:${revision}:${item.messageId}`,
                        ),
                      }
                    : item.type === "proposed_plan"
                      ? { planId: PlanId.make(`migration:v1:recovered:${revision}:${item.planId}`) }
                      : {}),
                },
              });
            }
          } else {
            events.push({
              ...event,
              id:
                existing === undefined
                  ? event.id
                  : EventId.make(`migration:v1:reconciliation:${revision}:${event.id}`),
            });
          }
        }
        // EventStore insertion is strict. A committed batch followed by a crash
        // must not append its notice or recovered version a second time.
        const accepted: OrchestrationV2DomainEvent[] = [];
        for (const event of events) {
          const present =
            yield* sql`SELECT 1 FROM orchestration_events WHERE event_id = ${event.id}`;
          if (present.length > 0) continue;
          if (event.id.startsWith("migration:v1:recovered:")) {
            const projection =
              event.type === "message.updated"
                ? yield* sql`SELECT 1 FROM orchestration_v2_projection_messages WHERE message_id = ${event.payload.id}`
                : event.type === "turn-item.updated"
                  ? yield* sql`SELECT 1 FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${event.payload.id}`
                  : event.type === "plan.updated"
                    ? yield* sql`SELECT 1 FROM orchestration_v2_projection_plans WHERE plan_id = ${event.payload.id}`
                    : [];
            if (projection.length > 0) continue;
          }
          accepted.push(event);
        }
        events.splice(0, events.length, ...accepted);
        return events;
      }),
      finalize: Effect.void,
    },
  });
  return committed.filter((stored) => stored.event.type === "message.updated").length;
});
