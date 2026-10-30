import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";

import type { DraftId } from "../../composerDraftStore";

export type OpenInNewWindowMenuId = "open-in-new-window";

const OPEN_IN_NEW_WINDOW_MENU_ITEM: ContextMenuItem<OpenInNewWindowMenuId> = {
  id: "open-in-new-window",
  label: "Open in new window",
  icon: "app-window",
};

function openNewWindowBridge() {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.openNewWindow;
}

/** Only the desktop app can open another app window. */
export function canOpenNewWindow(): boolean {
  return openNewWindowBridge() !== undefined;
}

/** The app route that shows a thread; new windows load it through the hash router. */
function threadWindowRoute(threadRef: ScopedThreadRef): string {
  return `/${encodeURIComponent(threadRef.environmentId)}/${encodeURIComponent(threadRef.threadId)}`;
}

function draftWindowRoute(draftId: DraftId): string {
  return `/draft/${encodeURIComponent(draftId)}`;
}

export function openInNewWindowMenuItem(): ContextMenuItem<OpenInNewWindowMenuId> | null {
  return canOpenNewWindow() ? OPEN_IN_NEW_WINDOW_MENU_ITEM : null;
}

/** Handles a thread or draft menu's "Open in new window" entry; false for any other action. */
export function handleOpenInNewWindowMenuAction(
  action: string | null,
  target: ScopedThreadRef | DraftId,
): boolean {
  if (action !== OPEN_IN_NEW_WINDOW_MENU_ITEM.id) return false;
  void openNewWindowBridge()?.(
    typeof target === "string" ? draftWindowRoute(target) : threadWindowRoute(target),
  );
  return true;
}
