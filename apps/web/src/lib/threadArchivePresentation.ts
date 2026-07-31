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
