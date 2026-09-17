import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds host-local device/inode evidence without rewriting migration 12.
 *
 * The column check also lets an unshared development database converge if it
 * briefly included the column in its initial workspace schema.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(scient_workspace_bindings)
  `;
  if (columns.some((column) => column.name === "root_filesystem_identity_json")) {
    return;
  }
  yield* sql`
    ALTER TABLE scient_workspace_bindings
    ADD COLUMN root_filesystem_identity_json TEXT
  `;
});
