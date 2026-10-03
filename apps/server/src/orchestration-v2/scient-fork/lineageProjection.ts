/**
 * Scient thread-lineage projector.
 *
 * SCIENT-OWNED. Folds `thread.forked` events into the standalone
 * `scient_thread_lineage` table (Scient migration ledger), and
 * `thread.conversation-imported` events into their `import` context transfer. Registered as one more
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
import { insertPendingFork, markForkReady } from "./forkRepository.ts";
import { insertImportTransfer } from "./importRepository.ts";

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
    return markForkReady(sql, {
      threadId: completed.threadId,
      checkpointStatus: completed.checkpointStatus,
      workspaceStatus: completed.workspaceStatus,
      updatedAt: event.occurredAt,
    }).pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(
          toPersistenceSqlError("ScientThreadLineageProjection.apply:updateFidelity")(sqlError),
        ),
      ),
    );
  }
  // An import's transfer is written with its thread, in the command's transaction.
  if (event.type === "thread.conversation-imported") {
    return insertImportTransfer(sql, event.payload).pipe(
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(
          toPersistenceSqlError("ScientThreadLineageProjection.apply:importTransfer")(sqlError),
        ),
      ),
    );
  }
  if (event.type !== "thread.forked") {
    return Effect.void;
  }
  const payload = event.payload;
  return insertPendingFork(sql, payload).pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (sqlError) =>
      Effect.fail(toPersistenceSqlError("ScientThreadLineageProjection.apply:upsert")(sqlError)),
    ),
  );
}
