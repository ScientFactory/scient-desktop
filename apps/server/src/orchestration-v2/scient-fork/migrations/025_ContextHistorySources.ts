import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Legacy projection bodies are preserved once in SQL. Event-backed versions
 * refer to their immutable event rather than duplicating each status snapshot. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS scient_handoff_history (
    source_id TEXT NOT NULL, position INTEGER NOT NULL, view_thread_id TEXT NOT NULL,
    source_thread_id TEXT NOT NULL, source_item_id TEXT NOT NULL, fork_position INTEGER,
    run_status TEXT, body_id TEXT, PRIMARY KEY (source_id, position)
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX IF NOT EXISTS scient_handoff_history_owner
    ON scient_handoff_history (source_thread_id, source_item_id) WHERE body_id IS NULL`;
  yield* sql`CREATE TABLE IF NOT EXISTS scient_handoff_projection_sources (
    source_id TEXT PRIMARY KEY NOT NULL
  ) WITHOUT ROWID`;
  // Body tables keep rowids and store bodies last: a WITHOUT ROWID seek loads an
  // overflowing record whole, while a rowid lookup reads columns before the body
  // and body lengths from the record header alone.
  yield* sql`CREATE TABLE IF NOT EXISTS scient_handoff_frozen_items (
    body_id TEXT PRIMARY KEY NOT NULL, item_json TEXT NOT NULL
  )`;
  // shape_json records the parsed body shape with its byte length (see legacySourceShape).
  yield* sql`CREATE TABLE IF NOT EXISTS scient_handoff_legacy_sources (
    source_id TEXT PRIMARY KEY NOT NULL, event_id TEXT,
    messages_indexed INTEGER NOT NULL DEFAULT 0, shape_json TEXT, payload_json TEXT
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS scient_handoff_legacy_messages (
    source_id TEXT NOT NULL, position INTEGER NOT NULL, item_id TEXT NOT NULL,
    role TEXT NOT NULL, text_bytes INTEGER NOT NULL, metadata_json TEXT NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY (source_id, position)
  )`;
  const projection =
    yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_context_handoffs'`;
  if (projection.length > 0)
    yield* sql`
    INSERT OR IGNORE INTO scient_handoff_legacy_sources (source_id, payload_json)
    SELECT 'legacy-projection:' || context_handoff_id, payload_json
    FROM orchestration_v2_projection_context_handoffs
    WHERE CASE WHEN json_valid(payload_json) THEN
      (json_type(payload_json, '$.history') = 'object' OR json_type(payload_json, '$.summaryText') = 'text')
      AND json_type(payload_json, '$.historySource') IS NULL ELSE 0 END
  `;
  const events = yield* sql<{ readonly name: string }>`PRAGMA table_info(orchestration_events)`;
  if (events.some((column) => column.name === "application_event_version"))
    yield* sql`
    INSERT OR IGNORE INTO scient_handoff_legacy_sources (source_id, event_id)
    SELECT 'legacy-event:' || event_id, event_id FROM orchestration_events
    WHERE application_event_version = 2 AND event_type = 'context-handoff.updated'
      AND CASE WHEN json_valid(payload_json) THEN
        (json_type(payload_json, '$.history') = 'object' OR json_type(payload_json, '$.summaryText') = 'text')
        AND json_type(payload_json, '$.historySource') IS NULL ELSE 0 END
  `;
});
