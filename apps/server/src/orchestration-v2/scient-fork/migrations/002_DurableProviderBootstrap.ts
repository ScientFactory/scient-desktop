/**
 * Legacy ensureScientForkSchema may already have added these columns; check PRAGMA table_info
 * before ALTER to preserve compatibility.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scient_thread_lineage)`;
  const columnNames = new Set(columns.map((column) => column.name));

  const addColumn = (name: string, definition: string) =>
    columnNames.has(name)
      ? Effect.void
      : sql
          .unsafe(`ALTER TABLE scient_thread_lineage ADD COLUMN ${name} ${definition}`)
          .pipe(Effect.asVoid);

  yield* addColumn("provider_mode", "TEXT NOT NULL DEFAULT 'transcript-bootstrap'");
  yield* addColumn("provider_bootstrap_status", "TEXT NOT NULL DEFAULT 'pending'");
  yield* addColumn("attachment_copies_json", "TEXT NOT NULL DEFAULT '[]'");
  yield* addColumn("baseline_turn_id", "TEXT");
  yield* addColumn("baseline_user_message_id", "TEXT");
  yield* addColumn("baseline_assistant_message_id", "TEXT");
});
