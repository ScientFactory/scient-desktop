import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A fork's inherited history, fixed at fork time: one row per item, in order,
 * naming the conversation that stores the item and the message it stands for,
 * with the item's type and whether it started a turn (and the user wrote it),
 * which history windows count. Written once when the fork is accepted; not
 * derived from events, so a projection rebuild keeps it.
 *
 * `scient_fork_frozen_items` keeps a shown item (and its message) as the fork
 * showed it, written the first time something rewrites the stored original.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS scient_fork_history (
    thread_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    source_thread_id TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    message_id TEXT,
    turn_start INTEGER NOT NULL,
    user_turn INTEGER NOT NULL,
    PRIMARY KEY (thread_id, position)
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX IF NOT EXISTS scient_fork_history_source
    ON scient_fork_history (source_thread_id, source_item_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS scient_fork_history_source_message
    ON scient_fork_history (source_thread_id, message_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS scient_fork_frozen_items (
    thread_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    item_json TEXT NOT NULL,
    message_json TEXT,
    PRIMARY KEY (thread_id, position)
  ) WITHOUT ROWID`;
});
