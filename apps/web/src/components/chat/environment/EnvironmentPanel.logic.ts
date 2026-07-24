// FILE: EnvironmentPanel.logic.ts
// Purpose: Pure policy and accessible copy for Environment panel actions.
// Layer: Web UI logic

import { isMacPlatform, isWindowsPlatform } from "../../../lib/utils";

export function shouldShowStudioFolderRow(input: {
  isStudioChat: boolean;
  studioFolderPath: string | null;
  nativeShellAvailable: boolean;
}): boolean {
  return (
    input.isStudioChat && Boolean(input.studioFolderPath?.trim()) && input.nativeShellAvailable
  );
}

export function studioFolderActionLabel(input: {
  studioFolderPath: string;
  platform: string;
}): string {
  const fileManager = isMacPlatform(input.platform)
    ? "Finder"
    : isWindowsPlatform(input.platform)
      ? "File Explorer"
      : "the file manager";
  return `Open selected Studio folder in ${fileManager}: ${input.studioFolderPath}`;
}
