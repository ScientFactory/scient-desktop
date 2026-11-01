/**
 * Quarantine malformed lineage transactionally so it cannot block startup or enter recovery; retain
 * full evidence for repair. Keep physical compatibility columns queryable while runtime reads use
 * the canonical model.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const VALID_WORKSPACE_MODES = new Set(["local", "new-worktree"]);
const VALID_STATUSES = new Set(["pending", "provisioning", "failed", "abandoned", "ready"]);

const encodeEvidencePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Legacy ledgers may record migrations 1/2 without running them, so this migration must add their
  // missing columns too.

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

  // Quarantine malformed rows.

  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_thread_lineage_quarantine (
      thread_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      quarantined_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `;

  // Missing or invalid identity, mode, and lifecycle values cannot be invented safely; quarantine
  // those rows with evidence instead of blocking migration.
  const malformedRows = yield* sql<{
    readonly thread_id: string;
    readonly workspace_mode: string | null;
    readonly status: string | null;
    readonly forked_from_thread_id: string | null;
  }>`
    SELECT thread_id, workspace_mode, status, forked_from_thread_id
    FROM scient_thread_lineage
    WHERE forked_from_thread_id IS NULL
       OR workspace_mode IS NULL
       OR workspace_mode NOT IN ('local', 'new-worktree')
       OR (status IS NOT NULL AND status NOT IN ('pending', 'provisioning', 'failed', 'abandoned', 'ready'))
  `;

  for (const row of malformedRows) {
    const problems: string[] = [];
    if (row.forked_from_thread_id === null) {
      problems.push("forked_from_thread_id is null");
    }
    if (row.workspace_mode === null) {
      problems.push("workspace_mode is null");
    } else if (!VALID_WORKSPACE_MODES.has(row.workspace_mode)) {
      problems.push(`workspace_mode '${row.workspace_mode}' is not valid`);
    }
    if (row.status !== null && !VALID_STATUSES.has(row.status)) {
      problems.push(`status '${row.status}' is not valid`);
    }
    const reason = problems.join("; ");

    // Snapshot the complete pre-normalization row as forensic evidence
    // before removing it from active recovery.
    const snapshots = yield* sql<Record<string, unknown>>`
      SELECT * FROM scient_thread_lineage WHERE thread_id = ${row.thread_id}
    `;
    const payload = yield* encodeEvidencePayload(snapshots[0] ?? { thread_id: row.thread_id });

    yield* sql`
      INSERT INTO scient_thread_lineage_quarantine (thread_id, reason, payload_json)
      VALUES (${row.thread_id}, ${reason}, ${payload})
    `;
    yield* sql`DELETE FROM scient_thread_lineage WHERE thread_id = ${row.thread_id}`;

    yield* Effect.logWarning("Scient migration 3 quarantined a malformed lineage row").pipe(
      Effect.annotateLogs({ thread_id: row.thread_id, reason }),
    );
  }

  // Normalize prototype modes and NULL lifecycle fields.

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
});
