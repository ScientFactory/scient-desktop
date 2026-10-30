import type { DesktopBridge } from "@t3tools/contracts";
import type { IpcRenderer } from "electron";

import {
  CLIENT_SETTINGS_CHANGED_CHANNEL,
  CONNECTION_CATALOG_CHANGED_CHANNEL,
  OPEN_NEW_WINDOW_CHANNEL,
} from "../../ipc/channels.ts";

export function makeMultiWindowBridge(
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
): Pick<DesktopBridge, "openNewWindow" | "onClientSettingsChanged" | "onConnectionCatalogChanged"> {
  return {
    openNewWindow: (route, options) =>
      ipc.invoke(OPEN_NEW_WINDOW_CHANNEL, { route, atCursor: options?.atCursor }),
    onClientSettingsChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, settings: unknown) => {
        if (typeof settings !== "object" || settings === null) return;
        listener(settings as Parameters<typeof listener>[0]);
      };
      ipc.on(CLIENT_SETTINGS_CHANGED_CHANNEL, handler);
      return () => ipc.removeListener(CLIENT_SETTINGS_CHANGED_CHANNEL, handler);
    },
    onConnectionCatalogChanged: (listener) => {
      const handler = () => listener();
      ipc.on(CONNECTION_CATALOG_CHANGED_CHANNEL, handler);
      return () => ipc.removeListener(CONNECTION_CATALOG_CHANGED_CHANNEL, handler);
    },
  };
}
