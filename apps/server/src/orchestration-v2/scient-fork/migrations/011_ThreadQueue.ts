import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE scient_queue_receipts (queue_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, edit_token TEXT, edit_fingerprint TEXT)`;
  yield* sql`CREATE TABLE scient_queue_finalization (
    thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    answer_done INTEGER NOT NULL DEFAULT 0, checkpoint_done INTEGER NOT NULL DEFAULT 0,
    successful INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(thread_id, turn_id)
  )`;
  yield* sql`CREATE TABLE scient_thread_queue (
    thread_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    document TEXT NOT NULL
  )`;
});
