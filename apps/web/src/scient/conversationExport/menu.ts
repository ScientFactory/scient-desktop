import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";

import { requestConversationExport } from "./ConversationExportDialog";

export type ConversationExportMenuId = "export-conversation";

/** The thread menu entry that opens the export dialog. */
export const CONVERSATION_EXPORT_MENU_ITEM: ContextMenuItem<ConversationExportMenuId> = {
  id: "export-conversation",
  label: "Export…",
  icon: "download",
};

/** Handles the export entry for a thread menu; false for any other action. */
export function handleConversationExportMenuAction(
  action: string | null,
  threadRef: ScopedThreadRef,
): boolean {
  if (action !== CONVERSATION_EXPORT_MENU_ITEM.id) return false;
  requestConversationExport(threadRef);
  return true;
}
