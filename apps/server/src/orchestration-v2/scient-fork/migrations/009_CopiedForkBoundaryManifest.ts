/**
 * Development databases may have recorded migration 8 before it added this column; converge
 * idempotently without rewriting lineage or user data.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scient_thread_lineage)`;
  if (columns.some((column) => column.name === "copied_boundaries_json")) return;

  yield* sql.unsafe(
    "ALTER TABLE scient_thread_lineage ADD COLUMN copied_boundaries_json TEXT NOT NULL DEFAULT '[]'",
  );
});
