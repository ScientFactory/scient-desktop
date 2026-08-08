/**
 * Scient thread-lineage projector (Increment 1).
 *
 * SCIENT-OWNED. Folds `thread.forked` events into the standalone
 * `scient_thread_lineage` table (migration 038). Registered as one more
 * projector in the T3 ProjectionPipeline via a single marked seam; it no-ops on
 * every other event type, exactly like the existing per-table projectors. The
 * pipeline advances this projector's `projection_state` row by event sequence
 * for us, so the fold itself only performs the upsert.
 *
 * The upsert is keyed on the new thread id and is idempotent (ON CONFLICT), so
 * re-running the projector from an earlier `projection_state` sequence during
 * bootstrap re-materializes the same rows.
 */
import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";

/** Projector name for the `projection_state` bookkeeping row. */
export const SCIENT_FORK_LINEAGE_PROJECTOR_NAME = "scient.thread-lineage" as const;

export function applyScientThreadLineageProjection(
  event: OrchestrationEvent,
  sql: SqlClient.SqlClient,
): Effect.Effect<void, ProjectionRepositoryError> {
  // The fork reactor resolves the achieved fidelity after establishing the fork's
  // substrates; fold that into the existing lineage row.
  if (event.type === "thread.fork-completed") {
    const completed = event.payload;
    return sql`
      UPDATE scient_thread_lineage
      SET fidelity_mode = ${completed.fidelityMode}
      WHERE thread_id = ${completed.threadId}
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(
          toPersistenceSqlError("ScientThreadLineageProjection.apply:updateFidelity")(sqlError),
        ),
      ),
    );
  }
  if (event.type !== "thread.forked") {
    return Effect.void;
  }
  const payload = event.payload;
  return sql`
    INSERT INTO scient_thread_lineage (
      thread_id,
      forked_from_thread_id,
      fork_point_turn_count,
      workspace_mode,
      fidelity_mode,
      created_at
    ) VALUES (
      ${payload.newThreadId},
      ${payload.originThreadId},
      ${payload.forkAtTurnCount},
      ${payload.workspaceMode},
      ${payload.fidelityMode},
      ${payload.createdAt}
    )
    ON CONFLICT(thread_id) DO UPDATE SET
      forked_from_thread_id = excluded.forked_from_thread_id,
      fork_point_turn_count = excluded.fork_point_turn_count,
      workspace_mode = excluded.workspace_mode,
      fidelity_mode = excluded.fidelity_mode,
      created_at = excluded.created_at
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (sqlError) =>
      Effect.fail(toPersistenceSqlError("ScientThreadLineageProjection.apply:upsert")(sqlError)),
    ),
  );
}
