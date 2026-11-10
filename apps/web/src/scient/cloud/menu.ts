import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";

import { openShareLinkDialog } from "./shareDialogState";
import { hasCloudAccount } from "./useCloudAccount";

export type ShareLinkMenuId = "share-link";

/** "Share link…" beside "Share with guest", where this build has Scient Cloud. */
export function shareLinkMenuItems(): ReadonlyArray<ContextMenuItem<ShareLinkMenuId>> {
  return hasCloudAccount() ? [{ id: "share-link", label: "Share link…", icon: "link" }] : [];
}

export function handleShareLinkMenuAction(
  action: string | null,
  threadRef: ScopedThreadRef,
): boolean {
  if (action !== "share-link") return false;
  openShareLinkDialog(threadRef);
  return true;
}
