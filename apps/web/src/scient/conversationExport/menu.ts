import type {
  ContextMenuItem,
  ConversationExportFormat,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";
import { requestConversationExport } from "./ConversationExportDialog";
import { copyConversationMarkdown } from "./exportActions";
import { registeredConversationExportFormats } from "./formatRegistry";

const EXPORT_PREFIX = "export-conversation:";

export type ConversationExportMenuId =
  | "export-conversation"
  | `export-conversation:${ConversationExportFormat}`
  | "copy-conversation-markdown";

/** The thread menu's Export submenu: one entry per format, each opening its dialog. */
export function conversationExportMenuItem(
  resolve: MessageResolver = m,
): ContextMenuItem<ConversationExportMenuId> {
  return {
    id: "export-conversation",
    label: resolve(msg("Export", { $context: "submenu of conversation export formats" })),
    icon: "download",
    children: registeredConversationExportFormats().map((registration) => ({
      id: `${EXPORT_PREFIX}${registration.format}` as const,
      label: resolve(registration.menuLabel),
    })),
  };
}

/**
 * The Copy submenu entry that copies the conversation as text-only Markdown. Its label is read
 * when the menu is built, so it is in the language of that moment.
 */
export const COPY_CONVERSATION_MARKDOWN_MENU_ITEM: ContextMenuItem<ConversationExportMenuId> = {
  id: "copy-conversation-markdown",
  get label() {
    return m(msg("Conversation as Markdown"));
  },
  icon: "file-text",
};

/** Handles the export and copy entries for a thread menu; false for any other action. */
export function handleConversationExportMenuAction(
  action: string | null,
  threadRef: ScopedThreadRef,
): boolean {
  if (action === COPY_CONVERSATION_MARKDOWN_MENU_ITEM.id) {
    void copyConversationMarkdown(threadRef);
    return true;
  }
  if (action === null || !action.startsWith(EXPORT_PREFIX)) return false;
  const format = action.slice(EXPORT_PREFIX.length);
  const registration = registeredConversationExportFormats().find(
    (entry) => entry.format === format,
  );
  if (registration === undefined) return false;
  requestConversationExport(threadRef, registration.format);
  return true;
}
