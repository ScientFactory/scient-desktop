import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A fork's setup state leaves T3's thread record for Scient's own table. Existing forks keep their
 * state as it was: the projection's value is copied first; a fork the projection lost is recovered
 * from its latest thread event, which carried the whole thread. Unreadable rows are left for
 * recovery and never block the upgrade.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS scient_conversation_forks (
    thread_id TEXT PRIMARY KEY,
    fork_json TEXT NOT NULL
  ) WITHOUT ROWID`;
  const tables = new Set(
    (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_schema
      WHERE type = 'table'
        AND name IN ('orchestration_v2_projection_threads', 'orchestration_events')
    `).map((row) => row.name),
  );
  if (tables.has("orchestration_v2_projection_threads")) {
    // CASE keeps json_type from reading a row json_valid rejected.
    yield* sql`
      INSERT OR IGNORE INTO scient_conversation_forks (thread_id, fork_json)
      SELECT thread_id, json_extract(payload_json, '$.conversationFork')
      FROM orchestration_v2_projection_threads
      WHERE CASE WHEN json_valid(payload_json)
        THEN json_type(payload_json, '$.conversationFork') END = 'object'
    `;
  }
  if (tables.has("orchestration_events")) {
    yield* sql`
      INSERT OR IGNORE INTO scient_conversation_forks (thread_id, fork_json)
      SELECT event.stream_id, json_extract(event.payload_json, '$.conversationFork')
      FROM orchestration_events AS event
      JOIN (
        SELECT MAX(sequence) AS sequence
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND application_event_version = 2
          AND event_type LIKE 'thread.%'
          AND CASE WHEN json_valid(payload_json)
            THEN json_type(payload_json, '$.conversationFork') END = 'object'
        GROUP BY stream_id
      ) AS latest ON latest.sequence = event.sequence
    `;
  }
  if (tables.has("orchestration_v2_projection_threads")) {
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = json_remove(payload_json, '$.conversationFork')
      WHERE CASE WHEN json_valid(payload_json)
        THEN json_type(payload_json, '$.conversationFork') END IS NOT NULL
    `;
  }
});
