// FILE: 056_ProjectionThreadsForkSourceMessage.ts
// Purpose: Persist the exact transcript boundary for message-level conversation forks.
// Layer: Server persistence migration

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_threads", "fork_source_message_id"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fork_source_message_id TEXT
    `;
  }
});
