export function resolveScientQuickChatMovePlacement(input: {
  readonly isQuickChat: boolean;
  readonly isServerThread: boolean;
  readonly rightPanelOpen: boolean;
}) {
  const available = input.isQuickChat && input.isServerThread;
  return {
    header: available,
    panel: available && input.rightPanelOpen,
  } as const;
}
