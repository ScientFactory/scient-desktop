import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Scient-owned: the user-defined section a thread is filed under. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "section_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN section_id TEXT
    `;
  }
});
