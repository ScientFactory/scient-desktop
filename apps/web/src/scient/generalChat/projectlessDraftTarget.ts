import type { DraftThreadTargetRef } from "../../composerDraftStore";

export { projectlessDraftKey } from "../../composerDraftStore";
export type { DraftThreadTargetRef } from "../../composerDraftStore";

/**
 * Starts a draft for either a project or the environment-scoped General Chat.
 *
 * Keeping this downstream extension outside the inherited ChatView helper lets
 * upstream evolve its project-only launch path without narrowing General Chat.
 */
export function startNewThreadForTarget(
  targetRef: DraftThreadTargetRef | null,
  handleNewThread: (targetRef: DraftThreadTargetRef) => Promise<unknown>,
): boolean {
  if (targetRef === null) return false;
  void handleNewThread(targetRef);
  return true;
}
