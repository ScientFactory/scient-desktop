import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Removes fork recovery state owned by threads retired by core migration 43. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cleanupTables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'retired_projectless_thread_cleanup'
  `;
  if (cleanupTables.length === 0) return;
  yield* sql`
    DELETE FROM scient_thread_lineage
    WHERE thread_id IN (SELECT thread_id FROM retired_projectless_thread_cleanup)
  `;
  yield* sql`
    DELETE FROM scient_thread_lineage_quarantine
    WHERE thread_id IN (SELECT thread_id FROM retired_projectless_thread_cleanup)
  `;
});
