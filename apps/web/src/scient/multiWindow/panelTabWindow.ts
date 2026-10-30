import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { takeOverPreviewTabWhenShown } from "./previewHostOwnership";

const THREAD_PARAM = "panelThread";
const TAB_PARAM = "panelTab";

function splitRoute(route: string) {
  const query = route.indexOf("?");
  return query < 0
    ? { path: route, params: new URLSearchParams() }
    : { path: route.slice(0, query), params: new URLSearchParams(route.slice(query + 1)) };
}

/** `route`, asking the window it opens to show one tab of a thread's side panel, maximized. */
function panelTabWindowRoute(route: string, threadRef: ScopedThreadRef, surfaceId: string): string {
  const { path, params } = splitRoute(route);
  params.set(THREAD_PARAM, scopedThreadKey(threadRef));
  params.set(TAB_PARAM, surfaceId);
  return `${path}?${params}`;
}

/** Opens a side panel tab in a new window on this window's route; desktop only. */
export function openPanelTabInNewWindow(input: {
  readonly threadRef: ScopedThreadRef;
  readonly surfaceId: string;
  readonly atCursor?: boolean;
}): void {
  const route = panelTabWindowRoute(
    window.location.hash.slice(1) || "/",
    input.threadRef,
    input.surfaceId,
  );
  void window.desktopBridge?.openNewWindow?.(
    route,
    input.atCursor === true ? { atCursor: true } : undefined,
  );
}

/**
 * Shows the side panel tab this window opened for, maximized, taking a browser tab's page from
 * the window that had it. Run before the router starts: the request leaves the address first.
 */
export function applyPanelTabWindowRequest(target: {
  readonly location: Pick<Location, "href">;
  readonly history: Pick<History, "replaceState" | "state">;
}): void {
  const url = new URL(target.location.href);
  const { path, params } = splitRoute(url.hash.slice(1));
  const threadKey = params.get(THREAD_PARAM);
  const surfaceId = params.get(TAB_PARAM);
  if (threadKey === null && surfaceId === null) return;
  params.delete(THREAD_PARAM);
  params.delete(TAB_PARAM);
  const rest = params.toString();
  url.hash = rest === "" ? path : `${path}?${rest}`;
  target.history.replaceState(target.history.state, "", url.href);

  const threadRef = threadKey === null ? null : parseScopedThreadKey(threadKey);
  if (threadRef === null || surfaceId === null) return;
  const store = useRightPanelStore.getState();
  const surface = selectThreadRightPanelState(store.byThreadKey, threadRef).surfaces.find(
    (entry) => entry.id === surfaceId,
  );
  if (!surface) return;
  store.activateSurface(threadRef, surface.id);
  store.setMaximized(threadRef, true);
  if (surface.kind === "preview" && surface.resourceId !== null) {
    takeOverPreviewTabWhenShown(surface.resourceId);
  }
}
