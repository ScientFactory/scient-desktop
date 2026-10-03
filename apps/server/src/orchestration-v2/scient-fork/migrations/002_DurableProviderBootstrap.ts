/**
 * Scient migration 2: durable-provider-bootstrap.
 *
 * Adds provider bootstrap and baseline-identity columns to
 * `scient_thread_lineage`. These columns capture the provider injection mode,
 * bootstrap lifecycle, attachment-copy plan, and baseline turn/user/assistant
 * identifiers that the fork reactor and context bootstrap depend on.
 *
 * Uses conditional ALTER (check `PRAGMA table_info` first) so the migration is
 * safe on databases where the legacy `ensureScientForkSchema` already added
 * these columns.
 *
 * SCIENT-OWNED.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
