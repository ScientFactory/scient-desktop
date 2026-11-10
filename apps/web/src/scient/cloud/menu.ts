import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";

import { openShareLinkDialog } from "./shareDialogState";

export type ShareLinkMenuId = "share-link";

/** "Share link…" beside "Share with guest", where this build has Scient Cloud. */
export function shareLinkMenuItems(): ReadonlyArray<ContextMenuItem<ShareLinkMenuId>> {
  return hasCloudPublicConfig() ? [{ id: "share-link", label: "Share link…", icon: "link" }] : [];
}

export function handleShareLinkMenuAction(
  action: string | null,
  threadRef: ScopedThreadRef,
): boolean {
  if (action !== "share-link") return false;
  openShareLinkDialog(threadRef);
  return true;
}
