import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";

import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { openPreviewSession } from "~/components/preview/openPreviewSession";
import { toastManager } from "~/components/ui/toast";
import { type RightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

/** Opens a second copy of a browser or terminal tab beside the others. */
export function duplicatePanelSurface<E>(input: {
  readonly surface: RightPanelSurface;
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  readonly addTerminal: () => void;
}): void {
  const { surface } = input;
  if (surface.kind === "terminal") {
    input.addTerminal();
    return;
  }
  if (surface.kind !== "preview") return;
  const session =
    surface.resourceId === null ? undefined : input.previewSessions[surface.resourceId];
  // The page's address lives in its navigation status while it loads or after.
  const url = session && "url" in session.navStatus ? session.navStatus.url : undefined;
  void openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    ...(url === undefined ? {} : { url }),
    ...(session?.profileId === undefined ? {} : { profileId: session.profileId }),
  }).then((result) => {
    if (result._tag === "Success") {
      useRightPanelStore.getState().openBrowser(input.threadRef, result.value.tabId);
      return;
    }
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({ type: "error", title: "The tab could not be duplicated." });
    }
  });
}
