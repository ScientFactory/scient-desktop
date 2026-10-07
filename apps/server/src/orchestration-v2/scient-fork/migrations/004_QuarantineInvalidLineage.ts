/**
 * Scient migration 4: quarantine-invalid-lineage.
 *
 * Migration 3 was exercised by local development builds before the Phase B
 * migration design was finalized. This follow-up migration is therefore the
 * authoritative compatibility repair: databases that already recorded
 * migration 3 still receive it, while fresh databases converge through the
 * same path.
 *
 * Rows that cannot be decoded by the active lineage and recovery read models
 * are preserved in a dedicated evidence table and removed from active
 * recovery. Deletion is keyed by SQLite rowid rather than thread_id because a
 * nullable TEXT PRIMARY KEY can contain NULL (and even multiple NULL rows).
 *
 * SCIENT-OWNED.
 */
import { ThreadForkAttachmentCopy } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const AttachmentCopiesJson = Schema.fromJsonString(Schema.Array(ThreadForkAttachmentCopy));
const decodeAttachmentCopies = Schema.decodeUnknownOption(AttachmentCopiesJson);
const encodeEvidencePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const VALID_WORKSPACE_MODES = new Set(["local", "new-worktree"]);
const VALID_STATUSES = new Set(["pending", "provisioning", "failed", "abandoned", "ready"]);
const VALID_PROVIDER_BOOTSTRAP_STATUSES = new Set(["pending", "completed"]);
const VALID_CHECKPOINT_STATUSES = new Set(["pending", "ready", "unavailable"]);
const VALID_WORKSPACE_STATUSES = new Set(["pending", "project-root", "shared", "worktree"]);

interface LineageCandidate extends Record<string, unknown> {
  readonly lineage_rowid: number;
  readonly thread_id: unknown;
  readonly forked_from_thread_id: unknown;
  readonly fork_point_turn_id: unknown;
  readonly fork_point_turn_count: unknown;
  readonly source_checkpoint_turn_count: unknown;
  readonly baseline_turn_id: unknown;
  readonly baseline_user_message_id: unknown;
  readonly baseline_assistant_message_id: unknown;
  readonly workspace_mode: unknown;
  readonly provider_bootstrap_status: unknown;
  readonly attachment_copies_json: unknown;
  readonly status: unknown;
  readonly checkpoint_status: unknown;
  readonly workspace_status: unknown;
  readonly attempt_count: unknown;
  readonly last_error: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isNullableNonEmptyString = (value: unknown): value is string | null =>
  value === null || isNonEmptyString(value);
const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const isNullableNonNegativeInteger = (value: unknown): value is number | null =>
  value === null || isNonNegativeInteger(value);

function invalidReasons(row: LineageCandidate): ReadonlyArray<string> {
  const reasons: string[] = [];
  if (!isNonEmptyString(row.thread_id)) reasons.push("thread_id is missing or blank");
  if (!isNonEmptyString(row.forked_from_thread_id)) {
    reasons.push("forked_from_thread_id is missing or blank");
  }
  if (!isNullableNonEmptyString(row.fork_point_turn_id)) {
    reasons.push("fork_point_turn_id is blank or not text");
  }
  if (!isNonNegativeInteger(row.fork_point_turn_count)) {
    reasons.push("fork_point_turn_count is not a non-negative integer");
  }
  if (!isNullableNonNegativeInteger(row.source_checkpoint_turn_count)) {
    reasons.push("source_checkpoint_turn_count is not null or a non-negative integer");
  }
  if (!isNonEmptyString(row.baseline_turn_id)) {
    reasons.push("baseline_turn_id is missing or blank");
  }
  if (!isNullableNonEmptyString(row.baseline_user_message_id)) {
    reasons.push("baseline_user_message_id is blank or not text");
  }
  if (!isNullableNonEmptyString(row.baseline_assistant_message_id)) {
    reasons.push("baseline_assistant_message_id is blank or not text");
  }
  if (typeof row.workspace_mode !== "string" || !VALID_WORKSPACE_MODES.has(row.workspace_mode)) {
    reasons.push("workspace_mode is missing or invalid");
  }
  if (
    typeof row.provider_bootstrap_status !== "string" ||
    !VALID_PROVIDER_BOOTSTRAP_STATUSES.has(row.provider_bootstrap_status)
  ) {
    reasons.push("provider_bootstrap_status is missing or invalid");
  }
  if (
    typeof row.attachment_copies_json !== "string" ||
    Option.isNone(decodeAttachmentCopies(row.attachment_copies_json))
  ) {
    reasons.push("attachment_copies_json is not a valid attachment-copy array");
  }
  if (typeof row.status !== "string" || !VALID_STATUSES.has(row.status)) {
    reasons.push("status is missing or invalid");
  }
  if (
    typeof row.checkpoint_status !== "string" ||
    !VALID_CHECKPOINT_STATUSES.has(row.checkpoint_status)
  ) {
    reasons.push("checkpoint_status is missing or invalid");
  }
  if (
    typeof row.workspace_status !== "string" ||
    !VALID_WORKSPACE_STATUSES.has(row.workspace_status)
  ) {
    reasons.push("workspace_status is missing or invalid");
  }
  if (!isNonNegativeInteger(row.attempt_count)) {
    reasons.push("attempt_count is not a non-negative integer");
  }
  if (row.last_error !== null && typeof row.last_error !== "string") {
    reasons.push("last_error is not null or text");
  }
  if (!isNonEmptyString(row.created_at)) reasons.push("created_at is missing or blank");
  if (!isNonEmptyString(row.updated_at)) reasons.push("updated_at is missing or blank");
  return reasons;
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const quarantineTables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'scient_thread_lineage_quarantine'
  `;
  if (quarantineTables.length > 0) {
    const columns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(scient_thread_lineage_quarantine)
    `;
    if (!columns.some((column) => column.name === "quarantine_id")) {
      yield* sql`ALTER TABLE scient_thread_lineage_quarantine RENAME TO scient_thread_lineage_quarantine_legacy`;
      yield* sql`
        CREATE TABLE scient_thread_lineage_quarantine (
          quarantine_id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_rowid INTEGER,
          thread_id TEXT,
          reason TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          quarantined_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `;
      yield* sql`
        INSERT INTO scient_thread_lineage_quarantine (
          source_rowid, thread_id, reason, payload_json, quarantined_at
        )
        SELECT NULL, thread_id, reason, payload_json, quarantined_at
        FROM scient_thread_lineage_quarantine_legacy
      `;
      yield* sql`DROP TABLE scient_thread_lineage_quarantine_legacy`;
    }
  } else {
    yield* sql`
      CREATE TABLE scient_thread_lineage_quarantine (
        quarantine_id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_rowid INTEGER,
        thread_id TEXT,
        reason TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        quarantined_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
  }

  const candidates = yield* sql<LineageCandidate>`
    SELECT rowid AS lineage_rowid, * FROM scient_thread_lineage ORDER BY rowid ASC
  `;
  for (const row of candidates) {
    const reasons = invalidReasons(row);
    if (reasons.length === 0) continue;

    const payload = yield* encodeEvidencePayload(row);
    const threadId = typeof row.thread_id === "string" ? row.thread_id : null;
    const reason = reasons.join("; ");
    yield* sql`
      INSERT INTO scient_thread_lineage_quarantine (
        source_rowid, thread_id, reason, payload_json
      ) VALUES (${row.lineage_rowid}, ${threadId}, ${reason}, ${payload})
    `;
    yield* sql`DELETE FROM scient_thread_lineage WHERE rowid = ${row.lineage_rowid}`;
    yield* Effect.logWarning("Scient migration 4 quarantined invalid lineage").pipe(
      Effect.annotateLogs({ thread_id: threadId ?? "<null>", reason }),
    );
  }
});
