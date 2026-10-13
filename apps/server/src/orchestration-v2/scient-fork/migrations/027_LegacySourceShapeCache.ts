import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Records each archived body's parsed shape so startup validation does not re-parse
 * write-once legacy bodies on every launch. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(scient_handoff_legacy_sources)`;
  if (columns.some((column) => column.name === "shape_json")) return;
  yield* sql`ALTER TABLE scient_handoff_legacy_sources ADD COLUMN shape_json TEXT`;
});
