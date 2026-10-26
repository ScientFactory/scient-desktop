import type { DesktopAccountsBridge, DesktopCapturedSignIn } from "@t3tools/contracts";
import type { IpcRenderer } from "electron";
import * as Channels from "./protocol.ts";

export function makeDesktopAccountsBridge(
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
): DesktopAccountsBridge {
  return {
    originBoundFill: true,
    sourceProfiles: () => ipc.invoke(Channels.SOURCE_PROFILES),
    signedInSites: (profileId, environmentId) =>
      ipc.invoke(Channels.SIGNED_IN_SITES, { profileId, environmentId }),
    fill: (input) => ipc.invoke(Channels.FILL, input),
    onSignInCaptured: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, capture: DesktopCapturedSignIn) =>
        listener(capture);
      ipc.on(Channels.CAPTURED, handler);
      return () => ipc.removeListener(Channels.CAPTURED, handler);
    },
  };
}
