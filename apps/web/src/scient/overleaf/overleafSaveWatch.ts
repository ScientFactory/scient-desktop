// SCIENT-OWNED: saves in linked folders make Overleaf's status stale. Watched
// once for the app's lifetime, not by each chip: a save that finishes after
// the last linked file's editor closed (its closing flush) still counts.
import { markdownPersistenceRegistry } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import {
  subscribeWorkspaceFileSaves,
  type WorkspaceFileSaveTarget,
} from "~/scient/files/workspaceFileSaves";

import { noteOverleafFileSaved } from "./overleafStore";

let watching = false;

const documentKey = (target: WorkspaceFileSaveTarget) =>
  `${target.environmentId}\u0000${target.cwd}\u0000${target.relativePath}`;

/** Starts watching saves, once; later calls do nothing. */
export function ensureOverleafSaveWatch(): void {
  if (watching) return;
  watching = true;
  // Plain text editors announce each confirmed save.
  subscribeWorkspaceFileSaves(noteOverleafFileSaved);
  // A document session's save is done when it stops being pending, or when the
  // session closes after its last flush.
  let pending = new Map<string, WorkspaceFileSaveTarget>();
  const pendingNow = () =>
    new Map(
      markdownPersistenceRegistry
        .getSnapshot()
        .filter((entry) => entry.pending)
        .map((entry) => [
          documentKey(entry),
          { environmentId: entry.environmentId, cwd: entry.cwd, relativePath: entry.relativePath },
        ]),
    );
  pending = pendingNow();
  markdownPersistenceRegistry.subscribe(() => {
    const now = pendingNow();
    for (const [key, target] of pending) if (!now.has(key)) noteOverleafFileSaved(target);
    pending = now;
  });
}
