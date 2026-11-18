import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

import { openShareLinkDialog } from "./shareDialogState";
import { hasCloudAccount } from "./useCloudAccount";

export type ShareLinkMenuId = "share" | "share-link";

/**
 * One Share item in the thread menu: a submenu when both a lasting link and a live guest are
 * possible, otherwise whichever one is.
 */
export function shareMenuItems(
  canShareWithGuest: boolean,
  resolve: MessageResolver = m,
): ReadonlyArray<ContextMenuItem<ShareLinkMenuId | "share-guest">> {
  const canShareLink = hasCloudAccount();
  if (canShareLink && canShareWithGuest) {
    return [
      {
        id: "share",
        label: resolve(msg("Share", { $context: "verb, share the thread" })),
        icon: "user-plus",
        children: [
          { id: "share-link", label: resolve(msg("Link…", { $context: "share by link" })) },
          { id: "share-guest", label: resolve(msg("Invite people…")) },
        ],
      },
    ];
  }
  if (canShareLink) return [{ id: "share-link", label: resolve(msg("Share link…")), icon: "link" }];
  if (canShareWithGuest)
    return [{ id: "share-guest", label: resolve(msg("Invite people…")), icon: "user-plus" }];
  return [];
}

export function handleShareLinkMenuAction(
  action: string | null,
  threadRef: ScopedThreadRef,
): boolean {
  if (action !== "share-link") return false;
  openShareLinkDialog(threadRef);
  return true;
}
