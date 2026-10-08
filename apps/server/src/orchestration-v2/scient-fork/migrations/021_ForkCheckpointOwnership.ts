import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Unaccepted filesystem publications are resources, not accepted V2 threads. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE scient_fork_checkpoint_ownership (
    attempt_id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL,
    target_thread_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    checkpoint_ref TEXT NOT NULL UNIQUE,
    checkpoint_oid TEXT,
    owner_pid INTEGER NOT NULL
  )`;
});
