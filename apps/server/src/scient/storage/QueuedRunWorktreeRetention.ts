import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Shell status omits held queues, but resume still needs their checkout. Any queued run must keep
 * storage cleanup busy even when the shell reads failed or idle.
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
