/**
 * Scient migration 1: durable-thread-forks.
 *
 * Creates the original prototype `scient_thread_lineage` table that captured
 * fork identity and boundary facts. This is the schema shape that early
 * development databases and Claude's prototype used before provider-bootstrap
 * and lifecycle columns were added.
 *
 * SCIENT-OWNED. Uses `CREATE TABLE IF NOT EXISTS` so it is safe on databases
 * that already have the table from the legacy `ensureScientForkSchema` path.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_thread_lineage (
      thread_id TEXT PRIMARY KEY,
      forked_from_thread_id TEXT,
      fork_point_turn_count INTEGER,
      workspace_mode TEXT,
      fidelity_mode TEXT,
      created_at TEXT
    )
  `;
});
