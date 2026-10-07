import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Storage cleanup reads the thread shell, whose status skips held queued runs:
 * a held queue after a failed run reads "failed", and a thread holding only
 * queued runs reads "idle". Resume must still find the checkout, so any
 * queued run, held or not, keeps the thread busy for cleanup (#306).
 */
export const presentQueuedRunsAsBusy = Effect.fn("StorageCleanup.presentQueuedRunsAsBusy")(
  function* <Thread extends Pick<OrchestrationV2ThreadShell, "id" | "status">>(
    sql: SqlClient.SqlClient,
    threads: ReadonlyArray<Thread>,
  ) {
    if (threads.length === 0) return threads;
    // The repeated IN list matches the recovery partial index, so SQLite
    // searches the few unfinished runs instead of scanning run history.
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs
      WHERE status = 'queued'
        AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
    `;
    if (rows.length === 0) return threads;
    const queued = new Set(rows.map((row) => row.thread_id));
    return threads.map((thread) =>
      queued.has(thread.id) ? { ...thread, status: "queued" as const } : thread,
    );
  },
);
