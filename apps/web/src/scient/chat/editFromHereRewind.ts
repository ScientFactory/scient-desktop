import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import {
  isRepositoryCheckpointScope,
  repositoryCheckpointScopeIds,
} from "@t3tools/client-runtime/state/thread-repositories";

type RewindProjection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "checkpoints" | "checkpointScopes"
>;

const SETTLED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

/**
 * Whether rewinding to `turnCount` is certain to leave no turn's file changes behind: every run
 * it undoes has settled, the server recorded that its own folder's snapshot lists every change and
 * that list is empty, and no tracked repository recorded anything for it. Unknown counts as a change.
 */
export function laterTurnsChangedNoFiles(
  projection: RewindProjection | null,
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
      if (checkpoint.status !== "ready" || checkpoint.changesKnown !== true) return false;
      if (checkpoint.files.length > 0 || (checkpoint.filesTotal?.count ?? 0) > 0) return false;
      snapshotted = true;
    }
    if (!snapshotted) return false;
  }
  return true;
}

/**
 * Whether Edit from here can rewind without its dialog: the thread works in the project folder
 * alone, where the dialog can only rewind the chat, and no later turn changed files there. Tracked
 * folders and repositories always ask: they are not always compared. The server keeps evidence off
 * runs that reached any, including submodules, which only it sees.
 */
export function editFromHereSkipsDialog(input: {
  readonly projection: RewindProjection | null;
  readonly worktreePath: string | null;
  readonly projectTracksFolders: boolean;
  readonly turnCount: number;
}): boolean {
  const { projection, worktreePath, projectTracksFolders, turnCount } = input;
  if (projection === null || worktreePath !== null || projectTracksFolders) return false;
  if (projection.checkpointScopes.some(isRepositoryCheckpointScope)) return false;
  return laterTurnsChangedNoFiles(projection, turnCount);
}

/**
 * Wraps the rewind command of an Edit from here that skipped its dialog: right before it is sent,
 * after attachments are prepared, it decides again on the thread as it is now. If a later turn
 * has changed files meanwhile, nothing is sent and `onChanged` runs instead.
 */
export function sendIfStillDirect<Args extends ReadonlyArray<unknown>, Result>(
  send: (...args: Args) => Promise<Result>,
  stillDirect: () => boolean,
  onChanged: () => void,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    if (!stillDirect()) {
      onChanged();
      throw new Error("The thread changed before the rewind was sent.");
    }
    return send(...args);
  };
}
