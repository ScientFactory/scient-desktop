export function nextScientQuickChatRenameKey(
  currentThreadKey: string | null,
  committedThreadKey: string,
): string | null {
  return currentThreadKey === committedThreadKey ? null : currentThreadKey;
}
