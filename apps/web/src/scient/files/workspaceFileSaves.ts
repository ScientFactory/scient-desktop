// SCIENT-OWNED: news of a confirmed save from a plain text editor (the
// workspace file-session registry), for features that follow a folder's files,
// such as Overleaf's status. Document sessions have their own registry.
import type { EnvironmentId } from "@t3tools/contracts";

export interface WorkspaceFileSaveTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

const listeners = new Set<(target: WorkspaceFileSaveTarget) => void>();

export function notifyWorkspaceFileSaved(target: WorkspaceFileSaveTarget): void {
  for (const listener of listeners) listener(target);
}

export function subscribeWorkspaceFileSaves(
  listener: (target: WorkspaceFileSaveTarget) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
