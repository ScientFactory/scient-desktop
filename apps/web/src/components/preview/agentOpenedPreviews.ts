import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";

// SCIENT-FORK:START — browser presentation shares Scient's hide and departure policies.
import { applyScientBrowserHideRequests } from "../../scient/previewPresentation/useScientBrowserPresentation";
import { requestActiveSurfaceDeparture } from "../../scient/fileSurfaces/activeSurfaceDeparture";
// SCIENT-FORK:END

import { getClientSettings } from "../../hooks/useSettings";
import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import {
  previewStateAtom,
  previewThreadRefsAtom,
  type ThreadPreviewState,
} from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readEnvironmentSupportsServerBrowser } from "../../state/entities";

/**
 * Shows browsers an agent or another client revealed for a thread: floating
 * over chat, or focusing an existing panel tab when the reveal is forced.
 */
export function revealServerTabs(
  threadRef: ScopedThreadRef,
  sessions: ReadonlyArray<PreviewSessionSnapshot>,
  options: {
    readonly autoShowFloatingPreview: boolean;
    // SCIENT-FORK:START — deferred activation retains its originating request.
    readonly isCurrent?: (session: PreviewSessionSnapshot) => boolean;
    // SCIENT-FORK:END
  },
): void {
  if (!readEnvironmentSupportsServerBrowser(threadRef.environmentId)) return;
  // SCIENT-FORK:START — the last eligible request in a batch supersedes earlier deferred ones.
  let latestReveal: PreviewSessionSnapshot | undefined;
  // SCIENT-FORK:END
  for (const session of sessions) {
    const force = session.revealRequest?.force === true;
    if (!options.autoShowFloatingPreview && !force) continue;
    // SCIENT-FORK:START
    latestReveal = session;
    // SCIENT-FORK:END
    const surface = useRightPanelStore
      .getState()
      .byThreadKey[scopedThreadKey(threadRef)]?.surfaces.find(
        (surface) => surface.kind === "preview" && surface.resourceId === session.tabId,
      );
    if (surface && force) {
      // SCIENT-FORK:START — forced reveals share the pending-file departure lane.
      const panel = useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)];
      requestActiveSurfaceDeparture(threadRef, surface.id, () => {
        const current = useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)];
        if (
          latestReveal !== session ||
          options.isCurrent?.(session) === false ||
          !readEnvironmentSupportsServerBrowser(threadRef.environmentId) ||
          current?.activeSurfaceId !== panel?.activeSurfaceId ||
          current?.isOpen !== panel?.isOpen ||
          !current?.surfaces.includes(surface)
        )
          return;
        useRightPanelStore.getState().activateSurface(threadRef, surface.id);
      });
      // SCIENT-FORK:END
    } else if (!surface) {
      usePreviewMiniPlayerStore.getState().open(threadRef, browserMiniPlayerSource(session.tabId));
    }
  }
}

/**
 * Keeps a thread's browser panel tabs and floating browser in step with its
 * preview sessions. Server-hosted sessions are only complete once the first
 * list has loaded; before that, a missing session is not a closed one.
 */
export function followPreviewSessions(threadRef: ScopedThreadRef, state: ThreadPreviewState): void {
  if (readEnvironmentSupportsServerBrowser(threadRef.environmentId) && !state.listLoaded) return;
  const sessions = Object.values(state.sessions);
  useRightPanelStore.getState().reconcileBrowserSurfaces(
    threadRef,
    sessions.map((session) => session.tabId),
    new Set(
      sessions
        .filter((session) => session.runtime === "server" && session.reveal === false)
        .map((session) => session.tabId),
    ),
  );
  const miniPlayer = usePreviewMiniPlayerStore.getState();
  const source = miniPlayer.byThreadKey[scopedThreadKey(threadRef)]?.content;
  if (source?.kind === "browser" && !state.sessions[source.tabId]) miniPlayer.close(threadRef);
}

/**
 * Server tabs that are new, or carry a new reveal request, since `previous`.
 * Nothing is fresh until the first list has loaded: that list is the baseline,
 * so a reload never reopens previews the user dismissed. A tab this client was
 * closing comes back without a reveal if the close fails.
 */
function freshlyRevealedServerTabs(
  previous: ThreadPreviewState,
  next: ThreadPreviewState,
): ReadonlyArray<PreviewSessionSnapshot> {
  if (!previous.listLoaded || previous.sessions === next.sessions) return [];
  return Object.values(next.sessions).filter((session) => {
    if (session.runtime !== "server" || session.reveal !== true) return false;
    if (previous.suppressedTabIds.has(session.tabId)) return false;
    const before = previous.sessions[session.tabId];
    const requested = session.revealRequest;
    return requested ? before?.revealRequest?.id !== requested.id : before === undefined;
  });
}

function followThread(threadKey: string, threadRef: ScopedThreadRef): () => void {
  const atom = previewStateAtom(threadKey);
  let previous = appAtomRegistry.get(atom);
  // SCIENT-FORK:START — service disposal and newer requests invalidate delayed activation.
  let active = true;
  let revealGeneration = 0;
  // SCIENT-FORK:END
  const unsubscribe = appAtomRegistry.subscribe(atom, (next) => {
    const before = previous;
    previous = next;
    // SCIENT-FORK:START — consume fresh hide requests before reconciling browser sessions.
    if (readEnvironmentSupportsServerBrowser(threadRef.environmentId)) {
      applyScientBrowserHideRequests(threadRef, before, next);
    }
    // SCIENT-FORK:END
    // Reveals run first so a revealed tab floats before it gains a panel tab.
    const revealed = freshlyRevealedServerTabs(before, next);
    if (revealed.length > 0) {
      // SCIENT-FORK:START
      const generation = ++revealGeneration;
      // SCIENT-FORK:END
      revealServerTabs(threadRef, revealed, {
        autoShowFloatingPreview: getClientSettings().browserAutoShowFloatingPreview,
        // SCIENT-FORK:START — a delayed save cannot revive a superseded browser request.
        isCurrent: (session) => {
          const state = appAtomRegistry.get(atom);
          const current = state.sessions[session.tabId];
          return (
            active &&
            generation === revealGeneration &&
            state.listLoaded &&
            state.serverEpoch === next.serverEpoch &&
            !state.suppressedTabIds.has(session.tabId) &&
            current?.threadId === threadRef.threadId &&
            current.runtime === "server" &&
            current.reveal === true &&
            current.revealRequest?.id === session.revealRequest?.id &&
            current.revealRequest?.force === true
          );
        },
        // SCIENT-FORK:END
      });
    }
    if (before.sessions !== next.sessions || before.listLoaded !== next.listLoaded) {
      followPreviewSessions(threadRef, next);
    }
  });
  // SCIENT-FORK:START
  return () => {
    active = false;
    unsubscribe();
  };
  // SCIENT-FORK:END
}

/** Follows every thread's browser previews for the life of the page, not just the open thread's. */
export function startAgentOpenedPreviews(): () => void {
  const followed = new Map<string, () => void>();
  const followNewThreads = (refs: ReadonlyMap<string, ScopedThreadRef>) => {
    for (const [threadKey, threadRef] of refs) {
      if (!followed.has(threadKey)) followed.set(threadKey, followThread(threadKey, threadRef));
    }
  };
  const stopIndex = appAtomRegistry.subscribe(previewThreadRefsAtom, followNewThreads, {
    immediate: true,
  });
  return () => {
    stopIndex();
    for (const stop of followed.values()) stop();
  };
}
