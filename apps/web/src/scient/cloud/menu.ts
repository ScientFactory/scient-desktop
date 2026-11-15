import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";

import { openShareLinkDialog } from "./shareDialogState";
import { hasCloudAccount } from "./useCloudAccount";

export type ShareLinkMenuId = "share" | "share-link";

/**
 * One Share item in the thread menu: a submenu when both a lasting link and a live guest are
 * possible, otherwise whichever one is.
 */
export function shareMenuItems(
  canShareWithGuest: boolean,
): ReadonlyArray<ContextMenuItem<ShareLinkMenuId | "share-guest">> {
  const canShareLink = hasCloudAccount();
  if (canShareLink && canShareWithGuest) {
    return [
      {
        id: "share",
        label: "Share",
        icon: "user-plus",
        children: [
          { id: "share-link", label: "Link…" },
          { id: "share-guest", label: "Invite people…" },
        ],
      },
    ];
  }
  if (canShareLink) return [{ id: "share-link", label: "Share link…", icon: "link" }];
  if (canShareWithGuest) return [{ id: "share-guest", label: "Invite people…", icon: "user-plus" }];
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
