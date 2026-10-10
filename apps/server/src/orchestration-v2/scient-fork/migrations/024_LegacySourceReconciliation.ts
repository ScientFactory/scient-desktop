import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS scient_legacy_reconciliation_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0,
    source_token TEXT,
    last_error TEXT
  )`;
  yield* sql`INSERT OR IGNORE INTO scient_legacy_reconciliation_state (id) VALUES (1)`;
  // Before-images preserve the copied baseline. Applying source changes never
  // makes the current V2 projection an authoritative copy of the V1 source.
  yield* sql`CREATE TABLE IF NOT EXISTS scient_legacy_reconciliation_changes (
    change_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    row_key TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    resolved INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS scient_legacy_reconciliation_pending
    ON scient_legacy_reconciliation_changes (thread_id, resolved, revision)`;
  // Source versions are retained even when V2 edits require a separate visible
  // historical version rather than replacing the edited entity.
  yield* sql`CREATE TABLE IF NOT EXISTS scient_legacy_reconciliation_entities (
    thread_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    source_json TEXT NOT NULL,
    PRIMARY KEY (thread_id, entity_type, entity_id)
  ) WITHOUT ROWID`;
});
