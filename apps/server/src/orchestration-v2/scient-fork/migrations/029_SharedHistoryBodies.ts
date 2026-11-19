import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Archived handoff history stores each exact body once. Converted sources move out of the
 * inline legacy tables into their own rows, so reading an unconverted source never walks
 * past its large inline payload to reach new columns. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Rowid storage keeps the body last: a lookup reads the hash and length without the body.
  yield* sql`CREATE TABLE IF NOT EXISTS scient_history_bodies (
    hash BLOB NOT NULL UNIQUE, bytes INTEGER NOT NULL, body TEXT NOT NULL
  )`;
  // shape_json is the original source shape, recorded when the source was verified and converted.
  yield* sql`CREATE TABLE IF NOT EXISTS scient_handoff_shared_sources (
    source_id TEXT PRIMARY KEY NOT NULL, shape_json TEXT NOT NULL,
    summary_hash BLOB NOT NULL, summary_bytes INTEGER NOT NULL
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE IF NOT EXISTS scient_handoff_shared_messages (
    source_id TEXT NOT NULL, position INTEGER NOT NULL, item_id TEXT NOT NULL,
    role TEXT NOT NULL, text_bytes INTEGER NOT NULL, body_hash BLOB NOT NULL,
    PRIMARY KEY (source_id, position)
  ) WITHOUT ROWID`;
});
