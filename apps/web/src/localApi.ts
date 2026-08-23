import type {
  ConfirmDialogOptions,
  ContextMenuItem,
  DesktopAssetCopyRequest,
  DesktopAssetCopyResult,
  LocalApi,
} from "@t3tools/contracts";

import { requestConfirmDialog } from "./confirmDialog";
import { dismissContextMenu, showContextMenuFallback } from "./contextMenuFallback";
import { readBrowserClientSettings, writeBrowserClientSettings } from "./clientPersistenceStorage";
import { resetRequestLatencyStateForTests } from "./rpc/requestLatencyState";

let cachedApi: LocalApi | undefined;

async function saveAssetCopyInBrowser(
  request: DesktopAssetCopyRequest,
): Promise<DesktopAssetCopyResult> {
  let response: Response;
  try {
    response = await fetch(request.url, { cache: "no-store" });
  } catch {
    return { _tag: "failed", reason: "network-failed" };
  }
  if (response.status === 409) return { _tag: "failed", reason: "source-changed" };
  if (response.status === 404 || response.status === 410) {
    return { _tag: "failed", reason: "source-unavailable" };
  }
  if (!response.ok) return { _tag: "failed", reason: "network-failed" };

  let objectUrl: string | undefined;
  try {
    objectUrl = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.hidden = true;
    anchor.href = objectUrl;
    anchor.download = request.suggestedFileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    const completedObjectUrl = objectUrl;
    window.setTimeout(() => URL.revokeObjectURL(completedObjectUrl), 1_000);
    objectUrl = undefined;
    return { _tag: "download-started" };
  } catch {
    if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    return { _tag: "failed", reason: "write-failed" };
  }
}

function createBrowserLocalApi(): LocalApi {
  return {
    dialogs: {
      pickFolder: async (options) => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder(options);
      },
      confirm: async (message, options?: ConfirmDialogOptions) => {
        return requestConfirmDialog(message, options) ?? false;
      },
    },
    shell: {
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    documents: {
      saveAssetCopy: async (request) => {
        if (window.desktopBridge) return window.desktopBridge.saveAssetCopy(request);
        return saveAssetCopyInBrowser(request);
      },
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
      // A native desktop menu blocks keyboard input and closes on outside
      // interaction, so nothing to do there; the DOM fallback needs an explicit
      // dismiss when the state behind it goes away.
      close: async () => {
        if (!window.desktopBridge) {
          dismissContextMenu();
        }
      },
    },
    persistence: {
      getClientSettings: async () => {
        if (window.desktopBridge) {
          return window.desktopBridge.getClientSettings();
        }
        return readBrowserClientSettings();
      },
      setClientSettings: async (settings) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setClientSettings(settings);
        }
        writeBrowserClientSettings(settings);
      },
    },
  };
}

export function createLocalApi(): LocalApi {
  return createBrowserLocalApi();
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  cachedApi = createLocalApi();
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new Error("Local API not found");
  }
  return api;
}

export async function __resetLocalApiForTests() {
  cachedApi = undefined;
  const { __resetClientSettingsPersistenceForTests } = await import("./hooks/useSettings");
  __resetClientSettingsPersistenceForTests();
  resetRequestLatencyStateForTests();
}
