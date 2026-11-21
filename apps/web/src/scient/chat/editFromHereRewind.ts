import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { repositoryCheckpointScopeIds } from "@t3tools/client-runtime/state/thread-repositories";

const SETTLED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

/**
 * Whether rewinding to `turnCount` is certain to leave no turn's file changes behind: every run
 * it undoes has settled, its own folder's snapshot is captured and lists no file, and no tracked
 * repository recorded anything for it. Unknown or missing data counts as a change.
 */
export function laterTurnsChangedNoFiles(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "checkpoints" | "checkpointScopes"
  > | null,
  turnCount: number,
): boolean {
  if (projection === null) return false;
  const repositoryScopeIds = repositoryCheckpointScopeIds(projection.checkpointScopes);
  // A rewind undoes every run after the target that an earlier rewind did not already undo.
  for (const run of projection.runs) {
    if (run.ordinal <= turnCount || run.status === "rolled_back") continue;
    if (!SETTLED_RUN_STATUSES.has(run.status)) return false;
    let snapshotted = false;
    for (const checkpoint of projection.checkpoints) {
      if (checkpoint.runId !== run.id) continue;
      // A repository is recorded for a run only when it has something to show or failed.
      if (repositoryScopeIds.has(checkpoint.scopeId)) return false;
      if (checkpoint.status !== "ready") return false;
      if (checkpoint.files.length > 0 || (checkpoint.filesTotal?.count ?? 0) > 0) return false;
      snapshotted = true;
    }
    if (!snapshotted) return false;
  }
  return true;
}
