export function resolveScientGeneralChatMovePlacement(input: {
  readonly isGeneralChat: boolean;
  readonly isServerThread: boolean;
  readonly rightPanelOpen: boolean;
}) {
  const available = input.isGeneralChat && input.isServerThread;
  return {
    header: available,
    panel: available && input.rightPanelOpen,
  } as const;
}
