import type { ModelSelection } from "@t3tools/contracts";

import { useComposerDraftStore } from "../../composerDraftStore";
import { draftModelSelectionApplies, threadHasStarted } from "../../lib/chatThreadActions";
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
  const shell = target.kind === "server" ? readThreadShell(target.threadRef) : null;
  // A started thread's own selection wins over a seeded draft.
  const activeProvider = draftModelSelectionApplies(composer, threadHasStarted(shell))
    ? (composer?.activeProvider ?? null)
    : null;
  const composerSelection = activeProvider
    ? (composer?.modelSelectionByProvider[activeProvider] ?? null)
    : null;
  return composerSelection ?? shell?.modelSelection ?? null;
}
