/**
 * Compatibility convergence for development databases that already recorded
 * migration 8 before copied fork boundaries replaced the seed-send workflow.
 *
 * Fresh databases receive this column from migration 8. Existing development
 * databases run this idempotent migration once, without rewriting lineage or
 * user data.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scient_thread_lineage)`;
  if (columns.some((column) => column.name === "copied_boundaries_json")) return;

  yield* sql.unsafe(
    "ALTER TABLE scient_thread_lineage ADD COLUMN copied_boundaries_json TEXT NOT NULL DEFAULT '[]'",
  );
});
