import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "../../previewMiniPlayerStore";
import type { ThreadPreviewState } from "../../previewStateStore";
import { type RightPanelSurface, useRightPanelStore } from "../../rightPanelStore";

interface BrowserPresentationInput {
  readonly threadRef: ScopedThreadRef | null;
  readonly serverBrowserAvailable: boolean;
  readonly previewState: Pick<ThreadPreviewState, "listLoaded" | "sessions">;
  readonly autoShowFloatingPreview: boolean;
  readonly surfaces: readonly RightPanelSurface[];
}

/** Consume presentation intents once; browser requests never close artifacts or devices. */
export function useScientBrowserPresentation({
  threadRef,
  serverBrowserAvailable,
  previewState,
  autoShowFloatingPreview,
  surfaces,
}: BrowserPresentationInput): void {
  // Baseline loaded tabs so reloads never reopen or close previews on old requests.
  const previousServerPreviewTabs = useRef(new Map<string, Map<string, string | undefined>>());
  useEffect(() => {
    if (!threadRef || !serverBrowserAvailable || !previewState.listLoaded) return;
    const threadKey = scopedThreadKey(threadRef);
    const serverSessions = Object.values(previewState.sessions).filter(
      (session) => session.runtime === "server",
    );
    const previous = previousServerPreviewTabs.current.get(threadKey);
    previousServerPreviewTabs.current.set(
      threadKey,
      new Map(serverSessions.map((session) => [session.tabId, session.revealRequest?.id])),
    );
    if (!previous) return;
    for (const session of serverSessions) {
      const requested = session.revealRequest;
      const fresh = requested
        ? previous.get(session.tabId) !== requested.id
        : !previous.has(session.tabId);
      if (!fresh) continue;
      if (requested && session.reveal === false) {
        const player = usePreviewMiniPlayerStore.getState();
        if (selectThreadPreviewMiniPlayerTabId(player.byThreadKey, threadRef) === session.tabId) {
          player.close(threadRef);
        }
        continue;
      }
      if (session.reveal !== true) continue;
      if (!autoShowFloatingPreview && requested?.force !== true) continue;
      const surface = surfaces.find(
        (candidate) => candidate.kind === "preview" && candidate.resourceId === session.tabId,
      );
      if (surface && requested?.force === true) {
        useRightPanelStore.getState().activateSurface(threadRef, surface.id);
      } else if (!surface) {
        usePreviewMiniPlayerStore
          .getState()
          .open(threadRef, browserMiniPlayerSource(session.tabId));
      }
    }
  }, [
    serverBrowserAvailable,
    previewState.listLoaded,
    previewState.sessions,
    threadRef,
    autoShowFloatingPreview,
    surfaces,
  ]);
}
