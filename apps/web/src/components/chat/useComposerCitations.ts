// SCIENT-FORK:START — isolate composer callbacks from the thread render scope.
import type { AssistantCitationSourceAnchor } from "../../lib/assistantTextSelection";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { AssistantCitation, ResponseContextRecord } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "../../i18n/messages";
import { useStableCallback } from "../../hooks/useStableCallback";
import { toastManager } from "../ui/toast";

export function useComposerCitations(composerRef: ComposerHandleRef) {
  const citeAssistantText = (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => {
    const inserted = composerRef.current?.citeAssistantText(citation, sourceAnchor) ?? false;
    if (!inserted) {
      toastManager.add({
        type: "warning",
        title: m(msg("The composer is not ready")),
        description: m(
          msg("Try citing the selection after the connection or pending input is resolved."),
        ),
      });
    }
    return inserted;
  };
  const replyToResponseStable = useStableCallback((response: ResponseContextRecord) => {
    const accepted = composerRef.current?.replyToResponse(response) ?? false;
    if (!accepted) {
      toastManager.add({
        type: "warning",
        title: m(msg("The composer is not ready")),
        description: m(msg("Try replying after the connection or pending input is resolved.")),
      });
    }
    return accepted;
  });
  return { citeAssistantText: useStableCallback(citeAssistantText), replyToResponseStable };
}
// SCIENT-FORK:END
