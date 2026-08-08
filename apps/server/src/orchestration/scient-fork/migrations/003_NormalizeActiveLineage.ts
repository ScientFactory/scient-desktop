/**
 * Scient migration 3: normalize-active-lineage.
 *
 * Adds remaining lifecycle columns (status, checkpoint/workspace status,
 * attempt count, error, timestamps), normalizes prototype mode values to the
 * canonical `transcript-bootstrap` active model, validates row integrity
 * (fail-closed on malformed data), and creates supporting indexes.
 *
 * Physical compatibility columns (`provider_mode`, `fidelity_mode`) remain
 * queryable after this migration; only active runtime reads/writes use the
 * canonical model. No columns are dropped.
 *
 * SCIENT-OWNED.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Structured error raised when migration 3 encounters malformed lineage data.
 * The migration fails closed: no partial normalization is committed.
 */
export class ScientMalformedLineageError extends Data.TaggedError("ScientMalformedLineageError")<{
  readonly message: string;
  readonly threadId: string;
  readonly detail: string;
}> {}

const VALID_WORKSPACE_MODES = new Set(["local", "new-worktree"]);
const VALID_STATUSES = new Set(["pending", "provisioning", "failed", "abandoned", "ready"]);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // --- Add all missing columns (conditional ALTER) ---
  // This includes columns that migration 2 would have added, so migration 3
  // is self-sufficient even on databases where migrations 1/2 were pre-seeded
  // in the ledger by the legacy ensureScientForkSchema without actually
  // running the migration effects.

  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scient_thread_lineage)`;
  const columnNames = new Set(columns.map((column) => column.name));

  const addColumn = (name: string, definition: string) =>
    columnNames.has(name)
      ? Effect.void
      : sql
          .unsafe(`ALTER TABLE scient_thread_lineage ADD COLUMN ${name} ${definition}`)
          .pipe(Effect.asVoid);

  // Columns from migration 2 (provider bootstrap).
  yield* addColumn("provider_mode", "TEXT NOT NULL DEFAULT 'transcript-bootstrap'");
  yield* addColumn("provider_bootstrap_status", "TEXT NOT NULL DEFAULT 'pending'");
  yield* addColumn("attachment_copies_json", "TEXT NOT NULL DEFAULT '[]'");
  yield* addColumn("baseline_turn_id", "TEXT");
  yield* addColumn("baseline_user_message_id", "TEXT");
  yield* addColumn("baseline_assistant_message_id", "TEXT");

  // Columns from migration 3 (lifecycle normalization).
  yield* addColumn("fork_point_turn_id", "TEXT");
  yield* addColumn("source_checkpoint_turn_count", "INTEGER");
  yield* addColumn("status", "TEXT NOT NULL DEFAULT 'pending'");
  yield* addColumn("checkpoint_status", "TEXT NOT NULL DEFAULT 'pending'");
  yield* addColumn("workspace_status", "TEXT NOT NULL DEFAULT 'pending'");
  yield* addColumn("attempt_count", "INTEGER NOT NULL DEFAULT 0");
  yield* addColumn("last_error", "TEXT");
  yield* addColumn("updated_at", "TEXT");

  // --- Validate row integrity (fail-closed on malformed data) ---

  const malformedRows = yield* sql<{
    readonly thread_id: string;
    readonly workspace_mode: string | null;
    readonly status: string | null;
    readonly forked_from_thread_id: string | null;
  }>`
    SELECT thread_id, workspace_mode, status, forked_from_thread_id
    FROM scient_thread_lineage
    WHERE forked_from_thread_id IS NULL
       OR (workspace_mode IS NOT NULL AND workspace_mode NOT IN ('local', 'new-worktree'))
       OR (status IS NOT NULL AND status NOT IN ('pending', 'provisioning', 'failed', 'abandoned', 'ready'))
  `;

  if (malformedRows.length > 0) {
    const row = malformedRows[0]!;
    const problems: string[] = [];
    if (row.forked_from_thread_id === null) {
      problems.push("forked_from_thread_id is null");
    }
    if (row.workspace_mode !== null && !VALID_WORKSPACE_MODES.has(row.workspace_mode)) {
      problems.push(`workspace_mode '${row.workspace_mode}' is not valid`);
    }
    if (row.status !== null && !VALID_STATUSES.has(row.status)) {
      problems.push(`status '${row.status}' is not valid`);
    }
    return yield* new ScientMalformedLineageError({
      message: `Scient migration 3 encountered malformed lineage data`,
      threadId: row.thread_id,
      detail: problems.join("; "),
    });
  }

  // --- Normalize prototype modes and NULL lifecycle fields ---

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

  // --- Create indexes ---

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scient_thread_lineage_forked_from
      ON scient_thread_lineage (forked_from_thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scient_thread_lineage_status
      ON scient_thread_lineage (status, created_at)
  `;
});
