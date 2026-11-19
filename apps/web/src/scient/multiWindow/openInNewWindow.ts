import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

import type { DraftId } from "../../composerDraftStore";

export type OpenInNewWindowMenuId = "open-in-new-window";

const OPEN_IN_NEW_WINDOW_MENU_ID: OpenInNewWindowMenuId = "open-in-new-window";

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

export function openInNewWindowMenuItem(
  resolve: MessageResolver = m,
): ContextMenuItem<OpenInNewWindowMenuId> | null {
  return canOpenNewWindow()
    ? {
        id: OPEN_IN_NEW_WINDOW_MENU_ID,
        label: resolve(msg("Open in new window")),
        icon: "app-window",
      }
    : null;
}

/** Handles a thread or draft menu's "Open in new window" entry; false for any other action. */
export function handleOpenInNewWindowMenuAction(
  action: string | null,
  target: ScopedThreadRef | DraftId,
): boolean {
  if (action !== OPEN_IN_NEW_WINDOW_MENU_ID) return false;
  void openNewWindowBridge()?.(
    typeof target === "string" ? draftWindowRoute(target) : threadWindowRoute(target),
  );
  return true;
}
