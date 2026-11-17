import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A fork's setup state leaves T3's thread record for Scient's own table. Existing forks keep their
 * state as it was: the latest projection value is copied, then removed from the record.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS scient_conversation_forks (
    thread_id TEXT PRIMARY KEY,
    fork_json TEXT NOT NULL
  ) WITHOUT ROWID`;
  const projectionTable = yield* sql`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'orchestration_v2_projection_threads'
  `;
  if (projectionTable.length === 0) return;
  yield* sql`
    INSERT OR IGNORE INTO scient_conversation_forks (thread_id, fork_json)
    SELECT thread_id, json_extract(payload_json, '$.conversationFork')
    FROM orchestration_v2_projection_threads
    WHERE json_type(payload_json, '$.conversationFork') = 'object'
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = json_remove(payload_json, '$.conversationFork')
    WHERE json_type(payload_json, '$.conversationFork') IS NOT NULL
  `;
});
