import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { msg } from "gt-react";

import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { addBrowserSurface } from "~/components/preview/addBrowserSurface";
import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import type { RightPanelSurface } from "~/rightPanelStore";

/** Opens a second copy of a browser or terminal tab. */
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
  // T3's browser copy keeps the page, profile, viewport and runtime and sits beside its source.
  void addBrowserSurface({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    ...(session === undefined ? {} : { duplicateFrom: session }),
  }).then((result) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({ type: "error", title: m(msg("The tab could not be duplicated.")) });
    }
  });
}
