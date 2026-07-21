// FILE: 055_ProjectionThreadSessionLastErrorEvent.ts
// Purpose: Persist exact runtime-error correlation metadata for projected sessions.
// Layer: Server persistence migration

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_thread_sessions", "last_error_event_id"))) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN last_error_event_id TEXT
    `;
  }

  if (!(yield* columnExists(sql, "projection_thread_sessions", "last_error_class"))) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN last_error_class TEXT
    `;
  }
});
