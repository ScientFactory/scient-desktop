import {
  EventId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { presentInheritedItem, presentInheritedMessage } from "./ForkHistory.ts";
import { decodeMessageRow, decodeTurnItemRow } from "./projectionRowJson.ts";

/**
 * Keeps forks frozen when the history they show is rewritten. Before an event
 * overwrites an item or message that a fork shows by reference, the fork gets
 * its own copy of the stored version, presented as it showed it, and its
 * history row points at that copy. The copies are ordinary events in the same
 * transaction, so projection rebuilds keep them.
 *
 * Returns the events to commit before `event`.
 */
export const freezeShownHistory = Effect.fn("ForkHistory.freezeShown")(function* (
  sql: SqlClient.SqlClient,
  event: OrchestrationV2DomainEvent,
) {
  if (event.type !== "turn-item.updated" && event.type !== "message.updated") return [];
  const source = event.threadId;
  // Most conversations are shown by no fork: one indexed probe.
  const shown = yield* sql<{ readonly present: number }>`
    SELECT 1 AS present FROM scient_fork_history
    WHERE source_thread_id = ${source} AND thread_id <> ${source}
    LIMIT 1
  `;
  if (shown.length === 0) return [];
  const rows = yield* event.type === "turn-item.updated"
    ? sql<FreezeRow>`
          SELECT thread_id, position, source_item_id, message_id FROM scient_fork_history
          WHERE source_thread_id = ${source} AND source_item_id = ${event.payload.id}
            AND thread_id <> ${source}
        `
    : sql<FreezeRow>`
          SELECT thread_id, position, source_item_id, message_id FROM scient_fork_history
          WHERE source_thread_id = ${source} AND message_id = ${event.payload.id}
            AND thread_id <> ${source}
        `;
  const frozen: OrchestrationV2DomainEvent[] = [];
  for (const row of rows) {
    const fork = ThreadId.make(row.thread_id);
    const [stored] = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_turn_items
      WHERE turn_item_id = ${row.source_item_id}
    `;
    if (stored === undefined) continue;
    const item = yield* decodeTurnItemRow(stored.payload_json);
    const [storedMessage] =
      row.message_id === null
        ? []
        : yield* sql<{ readonly payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_projection_messages
            WHERE message_id = ${row.message_id}
          `;
    const message =
      storedMessage === undefined ? undefined : yield* decodeMessageRow(storedMessage.payload_json);
    const itemId = TurnItemId.make(`scient-fork:${fork}:item:${row.position}`);
    const messageId =
      message === undefined
        ? undefined
        : MessageId.make(`scient-fork:${fork}:message:shown-${row.position}`);
    if (message !== undefined && messageId !== undefined)
      frozen.push({
        id: EventId.make(`scient-fork:${fork}:freeze:${row.position}:message`),
        threadId: fork,
        occurredAt: event.occurredAt,
        type: "message.updated",
        payload: { ...presentInheritedMessage(message), id: messageId, threadId: fork },
      });
    const presented = presentInheritedItem(item, row.position);
    frozen.push({
      id: EventId.make(`scient-fork:${fork}:freeze:${row.position}:item`),
      threadId: fork,
      occurredAt: event.occurredAt,
      type: "turn-item.updated",
      payload: {
        ...presented,
        id: itemId,
        threadId: fork,
        ...(messageId !== undefined && "messageId" in presented ? { messageId } : {}),
      } as typeof presented,
    });
    yield* sql`
      UPDATE scient_fork_history
      SET source_thread_id = ${fork}, source_item_id = ${itemId},
        message_id = ${messageId ?? row.message_id}
      WHERE thread_id = ${fork} AND position = ${row.position}
    `;
  }
  return frozen;
});

interface FreezeRow {
  readonly thread_id: string;
  readonly position: number;
  readonly source_item_id: string;
  readonly message_id: string | null;
}
