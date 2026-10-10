import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A send receipt survives session replacement clearing the pending user message. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scient_context_handoffs)`;
  if (!columns.some((column) => column.name === "accepted_turn_id")) {
    yield* sql`ALTER TABLE scient_context_handoffs ADD COLUMN accepted_turn_id TEXT`;
  }
});
