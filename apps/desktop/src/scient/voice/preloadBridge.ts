// @effect-diagnostics globalTimers:off -- plain Electron preload adapter.
import type { DesktopVoiceBridge } from "@t3tools/contracts";
import type { IpcRenderer } from "electron";

import * as IpcChannels from "../../ipc/channels.ts";

/** Keep all Scient voice preload behavior out of T3's inherited preload. */
export function makeDesktopVoiceBridge(
  ipcRenderer: Pick<IpcRenderer, "invoke">,
): DesktopVoiceBridge {
  return {
    requestMicrophoneAccess: () =>
      ipcRenderer.invoke(IpcChannels.VOICE_REQUEST_MICROPHONE_ACCESS_CHANNEL),
    hadLegacySelection: () => ipcRenderer.invoke(IpcChannels.VOICE_HAD_LEGACY_SELECTION_CHANNEL),
    hasLegacyModels: () => ipcRenderer.invoke(IpcChannels.VOICE_HAS_LEGACY_MODELS_CHANNEL),
    removeLegacyModels: () => ipcRenderer.invoke(IpcChannels.VOICE_REMOVE_LEGACY_MODELS_CHANNEL),
  };
}
