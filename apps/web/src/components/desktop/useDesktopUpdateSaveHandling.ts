import { useEffect } from "react";
import { flushComposerDraftPersistence } from "../../composerDraftStore";
import { registerDesktopUpdateSaveHandler } from "../../lib/desktopUpdateSaveBridge";
import { windowEditors } from "../../scient/editorFlush/EditorFlushHosts";
import { toastManager } from "../ui/toast";
import { prepareDesktopUpdateSave } from "./prepareDesktopUpdateSave";

/**
 * Windows keep composer drafts in one shared storage record that each merges and rewrites, so two
 * flushing at once could each overwrite the other's draft. A lock shared by every window of the
 * app runs those flushes in turn; editor saves stay parallel.
 */
async function flushComposerDraftsInTurn(): Promise<void> {
  if (typeof navigator === "undefined" || navigator.locks === undefined) {
    flushComposerDraftPersistence();
    return;
  }
  await navigator.locks.request("scient:composer-draft-flush", () =>
    flushComposerDraftPersistence(),
  );
}

export function useDesktopUpdateSaveHandling(): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the native all-window save request subscription for this renderer's lifetime
  useEffect(
    () =>
      registerDesktopUpdateSaveHandler(async () => {
        const saved =
          (await prepareDesktopUpdateSave(windowEditors, flushComposerDraftsInTurn)) &&
          // Leaving the page asks every other owner too: a PDF still writing an edit vetoes it.
          window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
        // The window Restart was chosen in shows the reason beside its update control; another
        // window says that it is the one holding the restart back.
        if (!saved && !document.hasFocus())
          toastManager.add({
            type: "warning",
            title: "Restart paused",
            description:
              "A file or draft in this window could not be saved. Resolve its save notice and try again.",
          });
        return saved;
      }),
    [],
  );
}
