/**
 * Scient-owned database schema for durable conversation forks.
 *
 * This deliberately uses its own migration ledger instead of T3's numbered
 * migration sequence. T3 can therefore add migration 039, 040, and beyond
 * without colliding with Scient-owned state.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

interface TableColumn {
  readonly name: string;
}

export const ensureScientForkSchema = Effect.fn("ensureScientForkSchema")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_schema_migrations (
      migration_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `;

  // CREATE first for fresh installations. The guarded ALTER statements below
  // also upgrade Claude's preserved prototype table in place.
  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_thread_lineage (
      thread_id TEXT PRIMARY KEY,
      forked_from_thread_id TEXT NOT NULL,
      fork_point_turn_id TEXT,
      fork_point_turn_count INTEGER NOT NULL,
      source_checkpoint_turn_count INTEGER,
      baseline_turn_id TEXT,
      baseline_user_message_id TEXT,
      baseline_assistant_message_id TEXT,
      workspace_mode TEXT NOT NULL,
      provider_mode TEXT NOT NULL DEFAULT 'transcript-bootstrap',
      provider_bootstrap_status TEXT NOT NULL DEFAULT 'pending',
      attachment_copies_json TEXT NOT NULL DEFAULT '[]',
      fidelity_mode TEXT NOT NULL DEFAULT 'transcript-bootstrap',
      status TEXT NOT NULL DEFAULT 'pending',
      checkpoint_status TEXT NOT NULL DEFAULT 'pending',
      workspace_status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  const columns = yield* sql<TableColumn>`PRAGMA table_info(scient_thread_lineage)`;
  const columnNames = new Set(columns.map((column) => column.name));
  const addColumn = (name: string, definition: string) =>
    columnNames.has(name)
      ? Effect.void
      : sql
          .unsafe(`ALTER TABLE scient_thread_lineage ADD COLUMN ${name} ${definition}`)
          .pipe(Effect.asVoid);

  yield* addColumn("provider_mode", "TEXT NOT NULL DEFAULT 'transcript-bootstrap'");
  yield* addColumn("fork_point_turn_id", "TEXT");
  yield* addColumn("source_checkpoint_turn_count", "INTEGER");
  yield* addColumn("baseline_turn_id", "TEXT");
  yield* addColumn("baseline_user_message_id", "TEXT");
  yield* addColumn("baseline_assistant_message_id", "TEXT");
  yield* addColumn("provider_bootstrap_status", "TEXT NOT NULL DEFAULT 'pending'");
  yield* addColumn("attachment_copies_json", "TEXT NOT NULL DEFAULT '[]'");
  yield* addColumn("status", "TEXT NOT NULL DEFAULT 'pending'");
  yield* addColumn("checkpoint_status", "TEXT NOT NULL DEFAULT 'pending'");
  yield* addColumn("workspace_status", "TEXT NOT NULL DEFAULT 'pending'");
  yield* addColumn("attempt_count", "INTEGER NOT NULL DEFAULT 0");
  yield* addColumn("last_error", "TEXT");
  yield* addColumn("updated_at", "TEXT");

  // The prototype allowed nulls. Repair only those additive lifecycle fields
  // whose defaults are unambiguous; immutable lineage remains untouched.
  yield* sql`
    UPDATE scient_thread_lineage
    SET
      provider_mode = CASE
        WHEN provider_mode IS NULL OR provider_mode = 'cold-start'
          THEN 'transcript-bootstrap'
        ELSE provider_mode
      END,
      provider_bootstrap_status = COALESCE(provider_bootstrap_status, 'pending'),
      attachment_copies_json = COALESCE(attachment_copies_json, '[]'),
      fidelity_mode = CASE
        WHEN fidelity_mode IS NULL OR fidelity_mode IN ('chat-only', 'replay')
          THEN 'transcript-bootstrap'
        ELSE fidelity_mode
      END,
      status = COALESCE(status, 'pending'),
      checkpoint_status = COALESCE(checkpoint_status, 'pending'),
      workspace_status = COALESCE(workspace_status, 'pending'),
      attempt_count = COALESCE(attempt_count, 0),
      updated_at = COALESCE(updated_at, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scient_thread_lineage_forked_from
      ON scient_thread_lineage (forked_from_thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scient_thread_lineage_status
      ON scient_thread_lineage (status, created_at)
  `;

  const appliedAt = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    INSERT INTO scient_schema_migrations (migration_id, name, applied_at)
    VALUES (1, 'durable-thread-forks', ${appliedAt})
    ON CONFLICT(migration_id) DO NOTHING
  `;
  yield* sql`
    INSERT INTO scient_schema_migrations (migration_id, name, applied_at)
    VALUES (2, 'durable-provider-bootstrap', ${appliedAt})
    ON CONFLICT(migration_id) DO NOTHING
  `;
});
