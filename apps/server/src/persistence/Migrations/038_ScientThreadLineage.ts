/**
 * 038_ScientThreadLineage — Scient-owned conversation-fork lineage table.
 *
 * SCIENT-FORK migration. This is a NEW, standalone, Scient-owned projection
 * table. It does NOT touch or alter any existing T3-owned table or migration,
 * so upstream T3 progressions keep merging cheaply. Retire condition: drop this
 * table (and the fork feature) if/when T3 ships native thread-fork lineage.
 *
 * One row per forked thread records where it came from:
 *   thread_id            — the NEW (forked) thread (primary key)
 *   forked_from_thread_id — the origin thread the fork was seeded from
 *   fork_point_turn_count — the completed turn boundary the fork was taken at
 *   fidelity_mode         — "chat-only" in Increment 1; widens in later ones
 *   created_at            — when the fork was recorded
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scient_thread_lineage (
      thread_id TEXT PRIMARY KEY,
      forked_from_thread_id TEXT,
      fork_point_turn_count INTEGER,
      workspace_mode TEXT,
      fidelity_mode TEXT,
      created_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scient_thread_lineage_forked_from
      ON scient_thread_lineage (forked_from_thread_id)
  `;
});
