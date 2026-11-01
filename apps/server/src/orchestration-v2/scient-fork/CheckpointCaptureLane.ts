/**
 * A failed capture can leave the execution lane while pending retry. Block later provider starts on
 * every earlier pending capture, or that capture could record a later run's files instead.
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
