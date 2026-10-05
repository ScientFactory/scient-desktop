/** Legacy V1 history repairs, rechecked inside the native event write transaction. */
import {
  EventId,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2TurnItemJson,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  readLegacyCitationRepairSource,
  readLegacyQuestionInsertionOwner,
} from "./LegacyHistoryRepairOwnership.ts";

export class LegacyHistoryRepairError extends Schema.TaggedError<LegacyHistoryRepairError>()(
  "LegacyHistoryRepairError",
  { message: Schema.String },
) {}

const decodePositionedItem = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);

const guardTurnItemPositionRepairs = Effect.fn("EventSink.guardTurnItemPositionRepairs")(function* (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  const repaired: OrchestrationV2DomainEvent[] = [];
  for (const event of events) {
    if (
      event.type !== "turn-item.updated" ||
      !event.id.startsWith("migration:v1:history:position:")
    ) {
      repaired.push(event);
      continue;
    }
    const rows = yield* sql<{ payload_json: string; ordinal: number }>`
      SELECT items.payload_json, positions.ordinal
      FROM orchestration_v2_projection_turn_items AS items
      JOIN orchestration_v2_turn_item_positions AS positions
        ON positions.thread_id = items.thread_id AND positions.turn_item_id = items.turn_item_id
      WHERE items.thread_id = ${event.threadId} AND items.turn_item_id = ${event.payload.id}`;
    const current = rows[0];
    if (current === undefined) continue;
    const item = yield* decodePositionedItem(current.payload_json);
    // Only legacy runless items may acquire missing historical grouping.
    // Reread inside this transaction; never replace a V2 edit or explicit association.
    const historyTurnId =
      item.historyTurnId ??
      (item.runId === null &&
      (item.id.startsWith("migration:v1:turn-item:") || item.id.startsWith("migration:v1:history:"))
        ? event.payload.historyTurnId
        : undefined);
    if (item.ordinal === current.ordinal && historyTurnId === item.historyTurnId) continue;
    const digest = NodeCrypto.createHash("sha256")
      .update(current.payload_json)
      .update(historyTurnId ?? "")
      .digest("hex");
    repaired.push({
      ...event,
      id: EventId.make(`migration:v1:history:position:v2:${item.id}:${current.ordinal}:${digest}`),
      occurredAt: item.updatedAt,
      payload: {
        ...item,
        ordinal: current.ordinal,
        ...(historyTurnId === undefined ? {} : { historyTurnId }),
      },
    });
  }
  return repaired;
});

const decodeHistoricalMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const guardLegacyCitationRepairs = Effect.fn("EventSink.guardLegacyCitationRepairs")(function* (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  const repaired: OrchestrationV2DomainEvent[] = [];
  for (const event of events) {
    if (!event.id.startsWith("migration:v1:history:citation:")) {
      repaired.push(event);
      continue;
    }
    const messageId =
      event.type === "message.updated"
        ? event.payload.id
        : event.type === "turn-item.updated" && event.payload.type === "assistant_message"
          ? event.payload.messageId
          : undefined;
    if (messageId === undefined) continue;
    const [source] = yield* readLegacyCitationRepairSource(sql, event.threadId, messageId);
    if (source === undefined) continue;
    // Entity compaction can remove the original message event. The
    // retained import ledger and exact inert item identity survive it.
    const [ownedRow] = yield* sql<{ payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${event.threadId} AND turn_item_id = ${`migration:v1:turn-item:${messageId}`}`;
    if (ownedRow === undefined) continue;
    const owned = yield* decodePositionedItem(ownedRow.payload_json);
    if (
      owned.type !== "assistant_message" ||
      owned.id !== `migration:v1:turn-item:${messageId}` ||
      owned.threadId !== event.threadId ||
      owned.messageId !== messageId ||
      owned.runId !== null ||
      owned.nodeId !== null ||
      owned.nativeItemRef !== null ||
      owned.providerThreadId !== null ||
      owned.providerTurnId !== null ||
      owned.parentItemId !== null
    )
      continue;
    if (event.type === "message.updated") {
      const [row] = yield* sql<{ payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_messages
          WHERE thread_id = ${event.threadId} AND message_id = ${messageId}`;
      if (row === undefined) continue;
      const current = yield* decodeHistoricalMessage(row.payload_json);
      if (
        current.threadId !== event.threadId ||
        current.id !== messageId ||
        current.role !== "assistant" ||
        current.runId !== null ||
        current.nodeId !== null ||
        current.text !== source.text ||
        current.text === event.payload.text
      )
        continue;
      const payload = { ...current, text: event.payload.text };
      const digest = NodeCrypto.createHash("sha256")
        .update(row.payload_json)
        .update(payload.text)
        .digest("hex");
      repaired.push({
        ...event,
        id: EventId.make(`migration:v1:history:citation:message:${messageId}:${digest}`),
        occurredAt: current.updatedAt,
        payload,
      });
    } else if (event.type === "turn-item.updated" && event.payload.type === "assistant_message") {
      if (event.payload.id !== `migration:v1:turn-item:${messageId}`) continue;
      const current = owned;
      if (current.text !== source.text || current.text === event.payload.text) continue;
      const payload = { ...current, text: event.payload.text };
      const digest = NodeCrypto.createHash("sha256")
        .update(ownedRow.payload_json)
        .update(payload.text)
        .digest("hex");
      repaired.push({
        ...event,
        id: EventId.make(`migration:v1:history:citation:item:${messageId}:${digest}`),
        occurredAt: current.updatedAt,
        payload,
      });
    }
  }
  return repaired;
});

// Generation-two submitted answers are new inert facts beside the original
// audit. Reread durable ownership and existing projection in this transaction:
// compaction may remove the original insertion event after a user edits it.
const guardLegacyQuestionInsertions = Effect.fn("EventSink.guardLegacyQuestionInsertions")(
  function* (sql: SqlClient.SqlClient, events: ReadonlyArray<OrchestrationV2DomainEvent>) {
    const accepted: OrchestrationV2DomainEvent[] = [];
    const prefix = "migration:v1:history:answer:";
    for (const event of events) {
      if (event.type !== "turn-item.updated" || !event.payload.id.startsWith(prefix)) {
        accepted.push(event);
        continue;
      }
      const item = event.payload;
      const activityId = item.id.slice(prefix.length);
      const owner = yield* readLegacyQuestionInsertionOwner(
        sql,
        event.threadId,
        item.id,
        activityId,
      );
      const source = owner[0];
      if (
        source === undefined ||
        item.type !== "user_input_request" ||
        item.questionAnswer === undefined ||
        item.threadId !== event.threadId ||
        item.runId !== null ||
        item.nodeId !== null ||
        item.providerThreadId !== null ||
        item.providerTurnId !== null ||
        item.nativeItemRef !== null ||
        item.parentItemId !== null ||
        item.status !== "completed" ||
        item.requestId !== `migration:v1:answer:${activityId}` ||
        item.historyTurnId !== (source.turn_id ?? undefined)
      ) {
        return yield* new LegacyHistoryRepairError({
          message: "Historical submitted answer has no matching inert legacy owner.",
        });
      }
      const current = yield* sql<{ turn_item_id: string }>`
      SELECT turn_item_id FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${event.threadId} AND turn_item_id = ${item.id}`;
      if (current.length > 0) continue;
      accepted.push({ ...event, payload: { ...item, ordinal: source.ordinal } });
    }
    return accepted;
  },
);

/** Run the requested repair guards in their required order: inserted answers,
 * then citation text, then history positions. */
export const applyLegacyHistoryRepairGuards = (
  sql: SqlClient.SqlClient,
  options: {
    readonly guardLegacyQuestionInsertions?: boolean;
    readonly guardLegacyCitationRepairs?: boolean;
    readonly guardTurnItemPositionRepairs?: boolean;
  },
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) =>
  Effect.gen(function* () {
    const insertionGuarded =
      options.guardLegacyQuestionInsertions === true
        ? yield* guardLegacyQuestionInsertions(sql, events)
        : events;
    const citationGuarded =
      options.guardLegacyCitationRepairs === true
        ? yield* guardLegacyCitationRepairs(sql, insertionGuarded)
        : insertionGuarded;
    return options.guardTurnItemPositionRepairs === true
      ? yield* guardTurnItemPositionRepairs(sql, citationGuarded)
      : citationGuarded;
  });
