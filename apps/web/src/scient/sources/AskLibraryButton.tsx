import { useGT } from "gt-react";
import { MessageCircleQuestionIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { useComposerHandleContext } from "../../composerHandleContext";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { askLibraryInsertion } from "./askLibrary";

/**
 * Puts the Library question at the start of the chat draft and the caret in the composer; it
 * never sends. Its label hides when an `@container` ancestor is narrower than 24rem.
 */
export function AskLibraryButton() {
  const gt = useGT();
  const composer = useComposerHandleContext();
  const label = gt("Ask the Library");
  const ask = () => {
    const handle = composer?.current;
    const draft = handle?.getSendContext();
    if (handle && draft && !draft.answeringPendingUserInput) {
      const insertion = askLibraryInsertion(draft.prompt);
      if (insertion === null) return handle.focusAtEnd();
      if (handle.insertTextAtStart?.(insertion)) return;
    }
    toastManager.add({
      type: "error",
      title: gt("Couldn't add to the chat"),
      description: draft?.answeringPendingUserInput
        ? gt("Answer the agent's question first, then try again.")
        : gt("The chat isn't ready for text right now."),
    });
  };
  const button = (
    <Button size="xs" variant="ghost" aria-label={label} disabled={composer === null} onClick={ask}>
      <MessageCircleQuestionIcon />
      <span className="@max-[24rem]:hidden">{label}</span>
    </Button>
  );
  return (
    <ScientTooltip content={composer === null ? gt("Open a chat to ask the Library.") : label}>
      {/* A disabled button gets no pointer events, so the tooltip hangs on its wrapper. */}
      <span className="inline-flex">{button}</span>
    </ScientTooltip>
  );
}
