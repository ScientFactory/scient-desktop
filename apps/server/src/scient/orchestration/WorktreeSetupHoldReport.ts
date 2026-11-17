import type { RunId, ScheduledTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import { worktreeSetupPending } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";

export const WORKTREE_SETUP_HOLD_ERROR =
  "This task's thread could not set up its worktree, so the message waits in the thread's queue. Retry worktree setup in the thread or choose a workspace.";

type Threads = Pick<
  ThreadManagement.ThreadManagementService["Service"],
  "getProjectThreadRecords" | "waitForThread"
>;

/**
 * T3's wait for a run, except that it answers `null` once the run is stuck behind failed
 * worktree setup. Nothing then starts a queued run until someone retries or picks a
 * workspace, so the plain wait would last its whole timeout. A run queued behind active
 * work is checked again when that work ends, since its setup can still fail.
 */
export const waitForRunOrWorktreeSetupHold = Effect.fn("ScientWorktreeSetupHold.wait")(function* (
  threads: Threads,
  input: ThreadManagement.ThreadManagementWaitInput & { readonly runId: RunId },
) {
  while (true) {
    const records = yield* threads.getProjectThreadRecords(input, ["runs"]);
    const run = records.runs.find((candidate) => candidate.id === input.runId);
    if (run?.status !== "queued") return yield* threads.waitForThread(input);
    const ahead = records.runs.find(
      (candidate) =>
        candidate.status !== "queued" && !ThreadManagement.isTerminalRunStatus(candidate.status),
    );
    if (ahead === undefined)
      return worktreeSetupPending(records) ? null : yield* threads.waitForThread(input);
    const waited = yield* threads.waitForThread({ ...input, runId: ahead.id });
    if (waited.timedOut) return { threadId: input.threadId, run, timedOut: true };
  }
});

/** Marks the run that started at `startedAtIso` failed, if it is still recorded as dispatched. */
export const recordWorktreeSetupHold = Effect.fn("ScientWorktreeSetupHold.record")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly taskId: ScheduledTaskId; readonly startedAtIso: string },
) {
  const updated = yield* sql`
    UPDATE scheduled_tasks
    SET last_run_status = 'failed', last_run_error = ${WORKTREE_SETUP_HOLD_ERROR}
    WHERE task_id = ${input.taskId} AND last_run_at = ${input.startedAtIso}
      AND last_run_status = 'succeeded'
    RETURNING task_id
  `;
  return updated.length > 0;
});
