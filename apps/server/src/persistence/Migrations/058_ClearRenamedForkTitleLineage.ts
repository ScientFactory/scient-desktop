// FILE: 058_ClearRenamedForkTitleLineage.ts
// Purpose: Make title changes a durable fork-family boundary for databases that ran migration 057.
// Layer: Server persistence migration

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Migration 057 may already have backfilled automatic-title metadata before
  // this build learned that any subsequent title update permanently starts a
  // new family. Clear the read-model metadata when the event history proves a
  // title update occurred after creation. Replay reaches the same state because
  // the in-memory and durable projectors now clear these fields on that event.
  yield* sql`
    UPDATE projection_threads
    SET
      fork_title_base = NULL,
      fork_title_ordinal = NULL
    WHERE fork_title_base IS NOT NULL
      AND fork_title_ordinal IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS created
        JOIN orchestration_events AS renamed
          ON renamed.stream_id = created.stream_id
         AND renamed.sequence > created.sequence
        WHERE created.event_type = 'thread.created'
          AND renamed.event_type = 'thread.meta-updated'
          AND created.stream_id = projection_threads.thread_id
          AND json_valid(renamed.payload_json)
          AND json_type(renamed.payload_json, '$.title') = 'text'
      )
  `;
});
