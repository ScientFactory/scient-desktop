export function nextScientGeneralChatRenameKey(
  currentThreadKey: string | null,
  committedThreadKey: string,
): string | null {
  return currentThreadKey === committedThreadKey ? null : currentThreadKey;
}
