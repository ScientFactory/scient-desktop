import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "../../previewMiniPlayerStore";
import type { ThreadPreviewState } from "../../previewStateStore";

/** A fresh browser hide request never dismisses another browser, device or artifact. */
export function applyScientBrowserHideRequests(
  threadRef: ScopedThreadRef,
  previous: ThreadPreviewState,
  next: ThreadPreviewState,
): void {
  if (!previous.listLoaded || !next.listLoaded || previous.sessions === next.sessions) return;
  for (const session of Object.values(next.sessions)) {
    if (session.runtime !== "server" || session.reveal !== false || !session.revealRequest)
      continue;
    if (previous.sessions[session.tabId]?.revealRequest?.id === session.revealRequest.id) continue;
    const player = usePreviewMiniPlayerStore.getState();
    if (selectThreadPreviewMiniPlayerTabId(player.byThreadKey, threadRef) === session.tabId) {
      player.close(threadRef);
    }
  }
}
