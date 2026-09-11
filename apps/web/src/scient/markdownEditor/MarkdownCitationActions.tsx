import type { FileCitation } from "@t3tools/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { SelectionCitationToolbar } from "~/components/chat/AssistantSelectionToolbar";
import { toastManager } from "~/components/ui/toast";
import {
  captureMarkdownCitation,
  markdownCitationRevision,
  type MarkdownCitationSource,
  type MarkdownCiteHandler,
} from "./markdownCitation";
import { revealMarkdownCitation } from "./markdownCitationReveal";
import type { ScientMarkdownEditorView } from "./prosemirror/view";

export function MarkdownCitationActions({
  controller,
  source,
  onCite,
  reveal,
  revealId,
}: {
  controller: ScientMarkdownEditorView;
  source: MarkdownCitationSource;
  onCite?: MarkdownCiteHandler | undefined;
  reveal?: FileCitation | undefined;
  revealId?: number | undefined;
}) {
  const readViewport = useCallback(() => {
    const root = controller.view?.dom;
    return root?.closest<HTMLElement>(".scient-markdown-document-shell") ?? root ?? null;
  }, [controller]);
  const viewport = useSyncExternalStore(controller.subscribe, readViewport, () => null);
  const { environmentId, threadId, cwd, path } = source;
  const capture = useCallback(
    () =>
      captureMarkdownCitation(
        controller,
        { environmentId, threadId, cwd, path },
        window.getSelection(),
      ),
    [controller, environmentId, threadId, cwd, path],
  );
  useEffect(() => {
    if (!viewport || !reveal || revealId === undefined) return;
    return revealMarkdownCitation(controller, reveal);
  }, [controller, viewport, reveal, revealId]);
  if (!onCite) return null;
  return (
    <SelectionCitationToolbar
      viewport={viewport}
      capture={capture}
      onCite={(citation, anchor) => {
        // A toolbar may still be visible after an external update. Never silently
        // replace its captured quote with a newly selected or edited passage.
        if (
          !anchor.source.isConnected ||
          markdownCitationRevision(controller.session) !== citation.revision ||
          citation.environmentId !== environmentId ||
          citation.threadId !== threadId ||
          citation.cwd !== cwd ||
          citation.path !== path
        ) {
          toastManager.add({
            type: "warning",
            title: "The selection has changed",
            description: "Select the text again to cite its current version.",
          });
          return false;
        }
        const accepted = onCite(citation, anchor);
        if (!accepted)
          toastManager.add({
            type: "warning",
            title: "Could not add the citation",
            description: "The chat input is not ready. Your selection is unchanged.",
          });
        return accepted;
      }}
    />
  );
}
