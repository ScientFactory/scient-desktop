import type { ModelSelection } from "@t3tools/contracts";

import { useComposerDraftStore } from "../../composerDraftStore";
import { readThreadShell } from "../../state/entities";
import type { ThreadRouteTarget } from "../../threadRoutes";

/**
 * The model selection a new thread carries from the chat in view: what that
 * chat's composer shows, else the viewed thread's own selection. The
 * new-thread flow and the conversation import both start from it, so an
 * import opens on the model a new chat would.
 */
export function readCarriedModelSelection(
  target: ThreadRouteTarget | null | undefined,
): ModelSelection | null {
  if (!target) return null;
  const composer = useComposerDraftStore
    .getState()
    .getComposerDraft(target.kind === "server" ? target.threadRef : target.draftId);
  const activeProvider = composer?.activeProvider ?? null;
  const composerSelection = activeProvider
    ? (composer?.modelSelectionByProvider[activeProvider] ?? null)
    : null;
  const shell = target.kind === "server" ? readThreadShell(target.threadRef) : null;
  return composerSelection ?? shell?.modelSelection ?? null;
}
