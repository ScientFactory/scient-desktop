/**
 * Context transfers and handoffs for conversation forks.
 *
 * Mirrors upstream Orchestration V2's split between lineage (immutable, on
 * `scient_thread_lineage`), the context transfer a fork needs (one per fork),
 * and the handoffs that deliver it (tracked per provider-native thread). The
 * single `provider_bootstrap_status` flag could not express a delivery that
 * belongs to one provider session and must be repeated for a new one.
 *
 * Existing forks migrate without re-sending context they already received:
 * - completed deliveries become `inline` handoffs that adopt the current
 *   native thread on first use (`rebind_pending`);
 * - sending/ambiguous deliveries become `pending` handoffs, which the next turn
 *   settles from provider evidence or re-delivers on a fresh provider session;
 * - pending deliveries keep a pending transfer with no handoff.
 *
 * Inherited turn ids are recorded explicitly so revert keeps the whole
 * inherited transcript, not only its selected boundary turn.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const TurnIdList = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeTurnIdList = Schema.encodeSync(TurnIdList);
const decodeCopiedBoundaries = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ turnId: Schema.optional(Schema.String) }))),
);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_context_transfers (
      thread_id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'fork',
      source_thread_id TEXT NOT NULL,
      source_point_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      resolution_json TEXT,
      fidelity TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_context_handoffs (
      handoff_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      strategy TEXT NOT NULL DEFAULT 'full_thread_summary',
      native_thread_key TEXT,
      rebind_pending INTEGER NOT NULL DEFAULT 0,
      delivery_status TEXT NOT NULL,
      message_id TEXT,
      turn_id TEXT,
      included_item_count INTEGER NOT NULL DEFAULT 0,
      omitted_item_count INTEGER NOT NULL DEFAULT 0,
      budget_tokens INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scient_context_handoffs_thread
    ON scient_context_handoffs (thread_id, created_at)
  `;

  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scient_thread_lineage)`;
  if (!columns.some((column) => column.name === "inherited_turn_ids_json")) {
    yield* sql`
      ALTER TABLE scient_thread_lineage
      ADD COLUMN inherited_turn_ids_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
  // A fork taken while the origin was still working records what it cut.
  if (!columns.some((column) => column.name === "mid_turn_cut_json")) {
    yield* sql`ALTER TABLE scient_thread_lineage ADD COLUMN mid_turn_cut_json TEXT`;
  }

  // Explicit inherited turns for existing forks: every copied boundary turn
  // plus the baseline turn. Newer forks record the full set at fork time.
  const lineageColumnNames = new Set(
    (yield* sql<{ readonly name: string }>`PRAGMA table_info(scient_thread_lineage)`).map(
      (column) => column.name,
    ),
  );
  const lineageRows = !(
    lineageColumnNames.has("baseline_turn_id") && lineageColumnNames.has("copied_boundaries_json")
  )
    ? []
    : yield* sql<{
        readonly thread_id: string;
        readonly baseline_turn_id: string | null;
        readonly copied_boundaries_json: string;
      }>`
    SELECT thread_id, baseline_turn_id, copied_boundaries_json
    FROM scient_thread_lineage
    WHERE inherited_turn_ids_json = '[]'
  `;
  for (const row of lineageRows) {
    const turnIds = new Set<string>();
    if (row.baseline_turn_id !== null) turnIds.add(row.baseline_turn_id);
    for (const turnId of copiedBoundaryTurnIds(row.copied_boundaries_json)) turnIds.add(turnId);
    if (turnIds.size === 0) continue;
    yield* sql`
      UPDATE scient_thread_lineage
      SET inherited_turn_ids_json = ${encodeTurnIdList([...turnIds])}
      WHERE thread_id = ${row.thread_id}
    `;
  }
  // Backfill only from a complete lineage table; a partial development schema
  // has no delivery state to carry over.
  const lineageColumns = new Set(
    (yield* sql<{ readonly name: string }>`PRAGMA table_info(scient_thread_lineage)`).map(
      (column) => column.name,
    ),
  );
  const canBackfill = [
    "forked_from_thread_id",
    "fork_point_turn_id",
    "fork_point_turn_count",
    "provider_bootstrap_status",
    "provider_bootstrap_message_id",
    "provider_bootstrap_started_at",
    "baseline_turn_id",
    "copied_boundaries_json",
    "created_at",
    "updated_at",
  ].every((column) => lineageColumns.has(column));
  if (!canBackfill) return;

  yield* sql`
    INSERT OR IGNORE INTO scient_context_transfers (
      thread_id,
      type,
      source_thread_id,
      source_point_json,
      status,
      resolution_json,
      fidelity,
      created_at,
      updated_at
    )
    SELECT
      thread_id,
      'fork',
      forked_from_thread_id,
      json_object(
        'threadId', forked_from_thread_id,
        'turnId', fork_point_turn_id,
        'turnCount', fork_point_turn_count
      ),
      CASE provider_bootstrap_status
        WHEN 'completed' THEN 'consumed'
        WHEN 'pending' THEN 'pending'
        ELSE 'resolved_portable'
      END,
      CASE provider_bootstrap_status
        WHEN 'pending' THEN NULL
        ELSE json_object('type', 'portable_context', 'handoffId', 'legacy:' || thread_id)
      END,
      CASE provider_bootstrap_status WHEN 'pending' THEN NULL ELSE 'portable' END,
      created_at,
      updated_at
    FROM scient_thread_lineage
  `;

  yield* sql`
    INSERT OR IGNORE INTO scient_context_handoffs (
      handoff_id,
      thread_id,
      strategy,
      native_thread_key,
      rebind_pending,
      delivery_status,
      message_id,
      created_at,
      updated_at
    )
    SELECT
      'legacy:' || thread_id,
      thread_id,
      'full_thread_summary',
      NULL,
      CASE provider_bootstrap_status WHEN 'completed' THEN 1 ELSE 0 END,
      CASE provider_bootstrap_status WHEN 'completed' THEN 'inline' ELSE 'pending' END,
      provider_bootstrap_message_id,
      COALESCE(provider_bootstrap_started_at, updated_at),
      updated_at
    FROM scient_thread_lineage
    WHERE provider_bootstrap_status IN ('completed', 'sending', 'ambiguous')
  `;
});

function copiedBoundaryTurnIds(json: string): ReadonlyArray<string> {
  return Option.match(decodeCopiedBoundaries(json), {
    onNone: () => [],
    onSome: (boundaries) =>
      boundaries.flatMap((boundary) => (boundary.turnId === undefined ? [] : [boundary.turnId])),
  });
}
