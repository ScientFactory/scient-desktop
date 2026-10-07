/** Durable evidence for fork snapshots, native coverage and dispatched handoffs. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS scient_fork_snapshot_captures (
    thread_id TEXT PRIMARY KEY, origin_thread_id TEXT NOT NULL, source_turn_id TEXT,
    source_running_turn_id TEXT, checkpoint_oid TEXT NOT NULL, captured_at TEXT NOT NULL, cwd TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS scient_native_turn_sources (
    thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    provider_instance_id TEXT NOT NULL, native_thread_key TEXT NOT NULL,
    PRIMARY KEY (thread_id, turn_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS scient_model_context_windows (
    provider_instance_id TEXT NOT NULL, model_selection_json TEXT NOT NULL, max_tokens INTEGER NOT NULL,
    PRIMARY KEY (provider_instance_id, model_selection_json)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS scient_fork_live_images (
    thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, attachments_json TEXT NOT NULL, captured_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, turn_id)
  )`;
  const lineage = new Set(
    (yield* sql<{ readonly name: string }>`PRAGMA table_info(scient_thread_lineage)`).map(
      (row) => row.name,
    ),
  );
  if (!lineage.has("source_checkpoint_oid"))
    yield* sql`ALTER TABLE scient_thread_lineage ADD COLUMN source_checkpoint_oid TEXT`;
  if (!lineage.has("snapshot_captured_at"))
    yield* sql`ALTER TABLE scient_thread_lineage ADD COLUMN snapshot_captured_at TEXT`;
  const handoffs = new Set(
    (yield* sql<{ readonly name: string }>`PRAGMA table_info(scient_context_handoffs)`).map(
      (row) => row.name,
    ),
  );
  if (!handoffs.has("context_preamble"))
    yield* sql`ALTER TABLE scient_context_handoffs ADD COLUMN context_preamble TEXT`;
  if (!handoffs.has("attachment_ids_json"))
    yield* sql`ALTER TABLE scient_context_handoffs ADD COLUMN attachment_ids_json TEXT`;
});
