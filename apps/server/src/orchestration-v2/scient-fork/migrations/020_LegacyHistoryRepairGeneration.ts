import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Completion timestamps predate the reasoning and historical turn repairs. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(orchestration_v2_legacy_imports)
  `;
  // Fork-only databases do not contain the upstream V2 import ledger.
  if (columns.length === 0 || columns.some((column) => column.name === "history_repair_version"))
    return;
  yield* sql`ALTER TABLE orchestration_v2_legacy_imports
    ADD COLUMN history_repair_version INTEGER NOT NULL DEFAULT 0`;
});
