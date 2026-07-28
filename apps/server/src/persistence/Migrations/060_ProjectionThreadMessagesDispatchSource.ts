/**
 * Adds additive, nullable provenance for trusted non-human dispatchers.
 * Keeping this separate from dispatch_origin preserves compatibility with
 * released binaries whose origin enum only accepts user | automation.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_thread_messages", "dispatch_source"))) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN dispatch_source TEXT
    `;
  }
});
