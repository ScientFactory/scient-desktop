import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Removes every thread that still has no project at upgrade time.
 *
 * The cleanup table bridges the transactional database migration and the
 * subsequent filesystem cleanup. It stays empty after successful startup,
 * and makes attachment deletion safely retryable after an interrupted run.
 * Historical projectless creation/move events for threads that now belong to
 * a project are intentionally retained so those surviving streams still
 * replay without rewriting immutable history.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS retired_projectless_thread_cleanup (
      thread_id TEXT PRIMARY KEY
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO retired_projectless_thread_cleanup (thread_id)
    SELECT thread_id
    FROM projection_threads
    WHERE project_id IS NULL
  `;

  // Surviving project threads may point at a retired thread as the source or
  // implementation of a proposed plan. Clear those optional links before the
  // retired rows themselves disappear.
  yield* sql`
    UPDATE projection_thread_proposed_plans
    SET implementation_thread_id = NULL
    WHERE implementation_thread_id IN (
      SELECT thread_id FROM retired_projectless_thread_cleanup
    )
  `;
  yield* sql`
    UPDATE projection_turns
    SET source_proposed_plan_thread_id = NULL,
        source_proposed_plan_id = NULL
    WHERE source_proposed_plan_thread_id IN (
      SELECT thread_id FROM retired_projectless_thread_cleanup
    )
  `;

  yield* sql`
    DELETE FROM projection_pending_approvals
    WHERE thread_id IN (SELECT thread_id FROM retired_projectless_thread_cleanup)
  `;
  yield* sql`
    DELETE FROM projection_thread_sessions
    WHERE thread_id IN (SELECT thread_id FROM retired_projectless_thread_cleanup)
  `;
  yield* sql`
    DELETE FROM projection_thread_messages
    WHERE thread_id IN (SELECT thread_id FROM retired_projectless_thread_cleanup)
  `;
  yield* sql`
    DELETE FROM projection_thread_activities
    WHERE thread_id IN (SELECT thread_id FROM retired_projectless_thread_cleanup)
  `;
  yield* sql`
    DELETE FROM projection_thread_proposed_plans
    WHERE thread_id IN (SELECT thread_id FROM retired_projectless_thread_cleanup)
  `;
  yield* sql`
    DELETE FROM projection_turns
    WHERE thread_id IN (SELECT thread_id FROM retired_projectless_thread_cleanup)
  `;
  yield* sql`
    DELETE FROM checkpoint_diff_blobs
    WHERE thread_id IN (SELECT thread_id FROM retired_projectless_thread_cleanup)
  `;
  yield* sql`
    DELETE FROM provider_session_runtime
    WHERE thread_id IN (SELECT thread_id FROM retired_projectless_thread_cleanup)
  `;
  yield* sql`
    DELETE FROM orchestration_command_receipts
    WHERE aggregate_kind = 'thread'
      AND aggregate_id IN (SELECT thread_id FROM retired_projectless_thread_cleanup)
  `;
  yield* sql`
    DELETE FROM orchestration_events
    WHERE aggregate_kind = 'thread'
      AND stream_id IN (SELECT thread_id FROM retired_projectless_thread_cleanup)
  `;
  yield* sql`
    DELETE FROM projection_threads
    WHERE thread_id IN (SELECT thread_id FROM retired_projectless_thread_cleanup)
  `;
});
