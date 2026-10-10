import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Keeps forks frozen when the history they show is rewritten. Before an event
 * overwrites an item or message that a fork shows by reference, the stored
 * version is kept for that fork (`scient_fork_frozen_items`), in the same
 * transaction; readers prefer it. Identities do not change, so loaded clients
 * and recorded references stay valid. The first rewrite wins: later ones find
 * the fork's version already kept.
 */
export const freezeShownHistory = Effect.fn("ForkHistory.freezeShown")(function* (
  sql: SqlClient.SqlClient,
  event: OrchestrationV2DomainEvent,
) {
  if (event.type !== "turn-item.updated" && event.type !== "message.updated") return;
  const source = event.threadId;
  // Most conversations are shown by no fork: one indexed probe.
  const shown = yield* sql<{ readonly present: number }>`
    SELECT 1 AS present FROM scient_fork_history
    WHERE source_thread_id = ${source} AND thread_id <> ${source}
    LIMIT 1
  `;
  if (shown.length === 0) return;
  yield* sql`
    INSERT OR IGNORE INTO scient_fork_frozen_items (thread_id, position, item_json, message_json)
    SELECT history.thread_id, history.position, item.payload_json, message.payload_json
    FROM scient_fork_history AS history
    JOIN orchestration_v2_projection_turn_items AS item
      ON item.turn_item_id = history.source_item_id
    LEFT JOIN orchestration_v2_projection_messages AS message
      ON message.message_id = history.message_id
    WHERE history.source_thread_id = ${source}
      AND history.thread_id <> ${source}
      AND ${
        event.type === "turn-item.updated"
          ? sql`history.source_item_id = ${event.payload.id}`
          : sql`history.message_id = ${event.payload.id}`
      }
  `;
});
