/**
 * Provider sends are external side effects: persist the first attempt's identity and time. Keep
 * copied boundaries immutable so recursive forks never treat imported rows as native provider
 * turns.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Development databases may have received part of this uncommitted schema.
  // Keep the canonical migration convergent instead of failing on duplicates.
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scient_thread_lineage)`;
  const columnNames = new Set(columns.map((column) => column.name));
  const addColumn = (name: string, definition: string) =>
    columnNames.has(name)
      ? Effect.void
      : sql
          .unsafe(`ALTER TABLE scient_thread_lineage ADD COLUMN ${name} ${definition}`)
          .pipe(Effect.asVoid);

  yield* addColumn("fork_point_kind", "TEXT NOT NULL DEFAULT 'assistant-response'");
  yield* addColumn("source_user_message_id", "TEXT");
  yield* addColumn("copied_boundaries_json", "TEXT NOT NULL DEFAULT '[]'");
  yield* addColumn("provider_bootstrap_message_id", "TEXT");
  yield* addColumn("provider_bootstrap_started_at", "TEXT");
});
