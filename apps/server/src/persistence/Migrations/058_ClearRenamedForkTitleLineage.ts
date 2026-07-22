// FILE: 058_ClearRenamedForkTitleLineage.ts
// Purpose: Make title changes a durable fork-family boundary for databases that ran migration 057.
// Layer: Server persistence migration

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import reconcileForkTitleSequence from "./057_ProjectionThreadsForkTitleSequence.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Migration 057 may already have backfilled automatic-title metadata before
  // it learned about historical rename boundaries. Reset both its recognizable
  // legacy backfills (created title equals stored base) and any genuinely renamed
  // thread in projection and event truth, then rerun the boundary-aware allocator.
  // Updating the creation event keeps a later projection rebuild replay-equivalent.
  yield* sql`
    UPDATE projection_threads
    SET
      fork_title_base = NULL,
      fork_title_ordinal = NULL
    WHERE thread_id IN (
      SELECT created.stream_id
      FROM orchestration_events AS created
      WHERE created.event_type = 'thread.created'
        AND json_valid(created.payload_json)
        AND (
          (
            json_type(created.payload_json, '$.forkTitleBase') = 'text'
            AND json_extract(created.payload_json, '$.title')
              = json_extract(created.payload_json, '$.forkTitleBase')
          )
          OR EXISTS (
            SELECT 1
            FROM orchestration_events AS renamed
            WHERE renamed.stream_id = created.stream_id
              AND renamed.sequence > created.sequence
              AND renamed.event_type = 'thread.meta-updated'
              AND json_valid(renamed.payload_json)
              AND json_type(renamed.payload_json, '$.title') = 'text'
              AND json_extract(renamed.payload_json, '$.title')
                <> json_extract(created.payload_json, '$.title')
          )
        )
      )
  `;

  yield* sql`
    UPDATE orchestration_events AS created
    SET payload_json = json_set(
      created.payload_json,
      '$.forkTitleBase',
      NULL,
      '$.forkTitleOrdinal',
      NULL
    )
    WHERE created.event_type = 'thread.created'
      AND json_valid(created.payload_json)
      AND (
        (
          json_type(created.payload_json, '$.forkTitleBase') = 'text'
          AND json_extract(created.payload_json, '$.title')
            = json_extract(created.payload_json, '$.forkTitleBase')
        )
        OR EXISTS (
          SELECT 1
          FROM orchestration_events AS renamed
          WHERE renamed.stream_id = created.stream_id
            AND renamed.sequence > created.sequence
            AND renamed.event_type = 'thread.meta-updated'
            AND json_valid(renamed.payload_json)
            AND json_type(renamed.payload_json, '$.title') = 'text'
            AND json_extract(renamed.payload_json, '$.title')
              <> json_extract(created.payload_json, '$.title')
        )
      )
  `;

  yield* reconcileForkTitleSequence;
});
