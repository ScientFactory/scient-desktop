// FILE: threadArchivePresentation.ts
// Purpose: Keeps archive action and completion copy explicit about subtree scope.

export function threadArchiveActionLabel(conversationCount: number): string {
  return conversationCount > 1 ? `Archive family (${conversationCount})` : "Archive";
}

export function threadArchiveAccessibleLabel(conversationCount: number): string {
  return conversationCount > 1
    ? `Archive conversation family (${conversationCount})`
    : "Archive thread";
}

export function threadArchiveToastTitle(conversationCount: number): string {
  return conversationCount > 1 ? `${conversationCount} conversations archived` : "Thread archived";
}

export function threadFamilyConversationCountLabel(conversationCount: number): string {
  return conversationCount === 1 ? "1 conversation" : `${conversationCount} conversations`;
}

export function archivedThreadRestoreActionLabel(conversationCount: number): string {
  return conversationCount > 1 ? `Restore family (${conversationCount})` : "Restore";
}

export function archivedThreadDeleteActionLabel(conversationCount: number): string {
  return conversationCount > 1 ? `Delete family (${conversationCount})` : "Delete";
}

export function archivedThreadRestoreAccessibleLabel(
  threadTitle: string,
  conversationCount: number,
): string {
  return conversationCount > 1
    ? `Restore "${threadTitle}" and its ${conversationCount - 1} sub-agent conversations`
    : `Restore "${threadTitle}"`;
}

export function archivedThreadDeleteAccessibleLabel(
  threadTitle: string,
  conversationCount: number,
): string {
  return conversationCount > 1
    ? `Permanently delete "${threadTitle}" and its ${conversationCount - 1} sub-agent conversations`
    : `Permanently delete "${threadTitle}"`;
}

export function archivedThreadRestoreProgressMessage(
  threadTitle: string,
  conversationCount: number,
): string {
  return conversationCount > 1
    ? `Restoring ${conversationCount} conversations from "${threadTitle}"...`
    : `Restoring "${threadTitle}"...`;
}

export function archivedThreadRestoreSuccessMessage(conversationCount: number): string {
  return conversationCount > 1
    ? `${conversationCount} conversations were restored to the sidebar.`
    : "The thread was restored to the sidebar.";
}

export function archivedThreadDeleteProgressMessage(
  threadTitle: string,
  conversationCount: number,
): string {
  return conversationCount > 1
    ? `Deleting ${conversationCount} conversations from "${threadTitle}"...`
    : `Deleting "${threadTitle}"...`;
}

export function archivedThreadDeleteSuccessMessage(conversationCount: number): string {
  return conversationCount > 1
    ? `${conversationCount} archived conversations were permanently removed.`
    : "The archived thread was permanently removed.";
}

export function archivedWorktreeDeleteBlockedMessage(
  worktreeName: string,
  unexpectedConversationCount: number,
): string {
  const conversations =
    unexpectedConversationCount === 1
      ? "1 descendant conversation falls"
      : `${unexpectedConversationCount} descendant conversations fall`;
  return `Could not safely delete ${worktreeName}. ${conversations} outside the archived conversations linked to this worktree. Archive or relink them, then retry.`;
}

export function archivedWorktreeDeleteSuccessMessage(
  worktreeName: string,
  deletedConversationCount: number,
): string {
  return deletedConversationCount > 0
    ? `${worktreeName} was removed and ${deletedConversationCount} archived ${deletedConversationCount === 1 ? "conversation was" : "conversations were"} deleted.`
    : `${worktreeName} was removed.`;
}
