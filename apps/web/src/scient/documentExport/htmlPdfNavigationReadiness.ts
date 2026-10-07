import type { ScopedThreadRef } from "@t3tools/contracts";
import { isCurrentPreviewRuntimeTab } from "~/browser/previewRuntimeTabId";
import { readThreadPreviewState } from "~/previewStateStore";
import type { BrowserPdfExportOwner } from "./browserPdfExportOwnerModel";

/** Observe the already-open renderer's actual load, retaining epoch and document identity. */
export async function waitForNavigationReadiness(
  threadRef: ScopedThreadRef,
  tabId: string,
  runtimeTabId: string,
  owner: BrowserPdfExportOwner,
  expectedUrl: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = readThreadPreviewState(threadRef);
    const session = state.sessions[tabId];
    if (
      !session ||
      !isCurrentPreviewRuntimeTab(threadRef, state.serverEpoch, tabId, runtimeTabId)
    ) {
      throw new Error("The HTML document tab was replaced during PDF update.");
    }
    if (session.navStatus._tag === "LoadFailed")
      throw new Error("The HTML document failed to load.");
    if (session.navStatus._tag === "Success") {
      if (session.navStatus.url !== expectedUrl)
        throw new Error("The HTML document navigated elsewhere during PDF update.");
      const desktop = state.desktopByTabId[tabId];
      if (
        owner === "server"
          ? session.runtime === "server"
          : desktop?.hasWebContents && !desktop.loading
      )
        return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The HTML document did not finish loading before the PDF update timed out.");
}
