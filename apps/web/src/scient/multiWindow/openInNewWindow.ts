import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";

export type OpenInNewWindowMenuId = "open-in-new-window";

const OPEN_IN_NEW_WINDOW_MENU_ITEM: ContextMenuItem<OpenInNewWindowMenuId> = {
  id: "open-in-new-window",
  label: "Open in new window",
  icon: "app-window",
};

function openNewWindowBridge() {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.openNewWindow;
}

/** The app route that shows a thread; new windows load it through the hash router. */
export function threadWindowRoute(threadRef: ScopedThreadRef): string {
  return `/${encodeURIComponent(threadRef.environmentId)}/${encodeURIComponent(threadRef.threadId)}`;
}

/** Only the desktop app can open another app window. */
export function openInNewWindowMenuItem(): ContextMenuItem<OpenInNewWindowMenuId> | null {
  return openNewWindowBridge() === undefined ? null : OPEN_IN_NEW_WINDOW_MENU_ITEM;
}

/** Handles the thread menu's "Open in new window" entry; false for any other action. */
export function handleOpenInNewWindowMenuAction(
  action: string | null,
  threadRef: ScopedThreadRef,
): boolean {
  if (action !== OPEN_IN_NEW_WINDOW_MENU_ITEM.id) return false;
  void openNewWindowBridge()?.(threadWindowRoute(threadRef));
  return true;
}
