/**
 * CREATE TABLE IF NOT EXISTS preserves prototype databases whose table was created by the legacy
 * ensureScientForkSchema path.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

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
