/**
 * Context transfers for imported conversations (migration 18).
 *
 * A fork's transfer names its local source thread; an imported thread has
 * none, so `source_thread_id` becomes nullable. SQLite cannot relax NOT NULL
 * in place: the table is rebuilt and every existing (fork) row is copied
 * unchanged. The new columns carry what an import records instead of a
 * lineage row: its external provenance (`origin_json`) and the turns holding
 * imported history (`inherited_turn_ids_json`), which revert keeps.
 *
 * The checks keep the two kinds apart: a fork always names its source; an
 * import never does, so an external id can never pose as a local thread id.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
    PRAGMA table_info(scient_context_transfers)
  `;
  const source = columns.find((column) => column.name === "source_thread_id");
  if (source?.notnull === 0 && columns.some((column) => column.name === "origin_json")) return;

  yield* sql`DROP TABLE IF EXISTS scient_context_transfers_rebuild`;
  yield* sql`
    CREATE TABLE scient_context_transfers_rebuild (
      thread_id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'fork',
      source_thread_id TEXT,
      source_point_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      resolution_json TEXT,
      fidelity TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      inherited_turn_ids_json TEXT NOT NULL DEFAULT '[]',
      origin_json TEXT,
      CHECK (type <> 'fork' OR source_thread_id IS NOT NULL),
      CHECK (type <> 'import' OR (source_thread_id IS NULL AND origin_json IS NOT NULL))
    )
  `;
  yield* sql`
    INSERT INTO scient_context_transfers_rebuild (
      thread_id, type, source_thread_id, source_point_json, status, resolution_json,
      fidelity, error, created_at, updated_at
    )
    SELECT
      thread_id, type, source_thread_id, source_point_json, status, resolution_json,
      fidelity, error, created_at, updated_at
    FROM scient_context_transfers
  `;
  yield* sql`DROP TABLE scient_context_transfers`;
  yield* sql`ALTER TABLE scient_context_transfers_rebuild RENAME TO scient_context_transfers`;
});
