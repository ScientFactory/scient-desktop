import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A handoff's run of inherited fork positions is one row: handoff positions
 * [position, position + item_count) are the fork's history rows from fork_position on.
 * Existing per-item rows are converted later, in the background, once each one verifies.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS scient_handoff_history_ranges (
    source_id TEXT NOT NULL, position INTEGER NOT NULL, item_count INTEGER NOT NULL,
    view_thread_id TEXT NOT NULL, fork_position INTEGER NOT NULL,
    PRIMARY KEY (source_id, position)
  ) WITHOUT ROWID`;
  // Freezing a rewritten item finds the ranges that show it.
  yield* sql`CREATE INDEX IF NOT EXISTS scient_handoff_history_ranges_fork
    ON scient_handoff_history_ranges (view_thread_id, fork_position)`;
});
