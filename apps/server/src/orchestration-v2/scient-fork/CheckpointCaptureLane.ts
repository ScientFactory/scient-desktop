/**
 * A run's checkpoint is the workspace as that run left it. Its capture is
 * enqueued with the run's terminal events, ahead of any later run's start on
 * the thread. A capture that fails waits to retry as a pending row, which no
 * longer blocks the thread's lane, so a later run could start first and the
 * retried capture would then record the newer run's files. A provider start
 * therefore also waits for every earlier checkpoint capture on its thread that
 * is still pending.
 */
import type * as SqlClient from "effect/sql/SqlClient";

/** An extra claim condition, appended to the outbox's candidate predicate. */
export const checkpointCaptureLaneBarrier = (sql: SqlClient.SqlClient) => sql`
  AND (
    candidate.effect_type != 'provider-turn.start'
    OR NOT EXISTS (
      SELECT 1
      FROM orchestration_v2_effect_outbox AS capture
      WHERE capture.thread_id = candidate.thread_id
        AND capture.status = 'pending'
        AND capture.effect_type = 'checkpoint.capture'
        -- Insertion order: rows from one transaction share created_at.
        AND capture.rowid < candidate.rowid
    )
  )
`;
