import { useEffect } from "react";
import { flushComposerDraftPersistence } from "../../composerDraftStore";
import { registerDesktopUpdateSaveHandler } from "../../lib/desktopUpdateSaveBridge";
import { windowEditors } from "../../scient/editorFlush/EditorFlushHosts";
import { toastManager } from "../ui/toast";
import { prepareDesktopUpdateSave } from "./prepareDesktopUpdateSave";

export function useDesktopUpdateSaveHandling(): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the native all-window save request subscription for this renderer's lifetime
  useEffect(
    () =>
      registerDesktopUpdateSaveHandler(async () => {
        const saved = await prepareDesktopUpdateSave(windowEditors, flushComposerDraftPersistence);
        if (!saved)
          toastManager.add({
            type: "warning",
            title: "Restart paused",
            description:
              "A file or draft could not be saved. Resolve its save notice and try again.",
          });
        return saved;
      }),
    [],
  );
}
