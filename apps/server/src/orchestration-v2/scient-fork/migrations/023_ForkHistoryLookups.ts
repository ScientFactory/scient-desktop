import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Point reads of a fork's history by the fork and an item or message, and the
 * fork's inherited activity: the latest times of the user messages it shows
 * from its history. History is frozen, so these are fixed when the fork is
 * accepted (`writeForkHistory`); shell and settlement reads look them up
 * instead of scanning the history.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS scient_fork_history_item
    ON scient_fork_history (thread_id, source_item_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS scient_fork_history_message
    ON scient_fork_history (thread_id, message_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS scient_fork_inherited_activity (
    thread_id TEXT PRIMARY KEY,
    user_message_at TEXT,
    authored_user_message_at TEXT
  ) WITHOUT ROWID`;
  // Existing forks (only on a database whose V2 projection already exists).
  const projection = yield* sql<{ readonly present: number }>`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'orchestration_v2_projection_messages'
  `;
  if (projection.length === 0) return;
  yield* sql`
    INSERT OR IGNORE INTO scient_fork_inherited_activity
      (thread_id, user_message_at, authored_user_message_at)
    SELECT thread_id, MAX(at), MAX(CASE WHEN authored THEN at END)
    FROM (
      SELECT history.thread_id,
        COALESCE(json_extract(frozen.message_json, '$.updatedAt'), message.updated_at) AS at,
        json_extract(COALESCE(frozen.message_json, message.payload_json), '$.createdBy') = 'user'
          AS authored
      FROM scient_fork_history AS history
      JOIN orchestration_v2_projection_messages AS message
        ON message.message_id = history.message_id
      LEFT JOIN scient_fork_frozen_items AS frozen
        ON frozen.thread_id = history.thread_id AND frozen.position = history.position
      WHERE history.item_type = 'user_message'
        AND history.source_thread_id <> history.thread_id
    )
    GROUP BY thread_id
  `;
});
