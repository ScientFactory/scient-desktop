// FILE: updateInstallMode.ts
// Purpose: Chooses the safe install handoff for signed and unsigned packaged releases.
// Layer: Desktop updater utility

import type { DesktopUpdateInstallMode } from "@synara/contracts";

export function resolveDesktopUpdateInstallMode(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly signedRelease: boolean | null;
}): DesktopUpdateInstallMode {
  if (input.platform !== "darwin" || !input.isPackaged) {
    return "automatic";
  }

  return input.signedRelease === true ? "automatic" : "manual";
}
