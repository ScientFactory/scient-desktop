import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import {
  repositoryCheckpointScopeIds,
  rewindFileRestore,
} from "@t3tools/client-runtime/state/thread-repositories";

import { findRevertCheckpoint } from "../../session-logic";

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
 * Whether Edit from here can rewind without its dialog: the dialog would offer no file choice
 * ("Revert files too" or "Revert repositories too"), and no later turn changed files, so it would
 * only ask to rewind the chat. A thread whose files can be restored always asks: the user may want
 * to undo their own edits.
 */
export function editFromHereSkipsDialog(input: {
  readonly projection: RewindProjection | null;
  readonly worktreePath: string | null;
  readonly turnCount: number;
}): boolean {
  const { projection, worktreePath, turnCount } = input;
  // As RevertConfirmHost decides it. The task folder it may look up is assumed to be the one that
  // offers the most, so an unknown answer keeps the dialog.
  const fileRestore =
    projection === null || worktreePath === null
      ? null
      : rewindFileRestore({
          projection,
          checkpoint: findRevertCheckpoint(projection, turnCount),
          taskFolder: { projectIsWorktree: false },
        });
  return fileRestore === null && laterTurnsChangedNoFiles(projection, turnCount);
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
