import type {
  DesktopAccountsBridge,
  DesktopCapturedSignIn,
  DesktopLoginForm,
} from "@t3tools/contracts";
import type { IpcRenderer } from "electron";
import * as Channels from "./protocol.ts";

export function makeDesktopAccountsBridge(
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
): DesktopAccountsBridge {
  return {
    originBoundFill: true,
    readBrowserPasswords: (input) => ipc.invoke(Channels.READ_BROWSER_PASSWORDS, input),
    sourceProfiles: () => ipc.invoke(Channels.SOURCE_PROFILES),
    signedInSites: (profileId, environmentId) =>
      ipc.invoke(Channels.SIGNED_IN_SITES, { profileId, environmentId }),
    cookieMetadata: (profileId, environmentId) =>
      ipc.invoke(Channels.COOKIE_METADATA, { profileId, environmentId }),
    signOutSite: (profileId, site, environmentId) =>
      ipc.invoke(Channels.SIGN_OUT_SITE, { profileId, site, environmentId }),
    fill: (input) => ipc.invoke(Channels.FILL, input),
    loginForm: (tabId) => ipc.invoke(Channels.LOGIN_FORM, { tabId }),
    onLoginFormDetected: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, form: DesktopLoginForm) => listener(form);
      ipc.on(Channels.LOGIN_FORM_DETECTED, handler);
      return () => ipc.removeListener(Channels.LOGIN_FORM_DETECTED, handler);
    },
    onSignInCaptured: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, capture: DesktopCapturedSignIn) =>
        listener(capture);
      ipc.on(Channels.CAPTURED, handler);
      return () => ipc.removeListener(Channels.CAPTURED, handler);
    },
  };
}
