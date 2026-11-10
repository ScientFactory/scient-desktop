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
    siteIcon: (site) => ipc.invoke(Channels.SITE_ICON, site),
    signedInSites: (profileId, environmentId) =>
      ipc.invoke(Channels.SIGNED_IN_SITES, { profileId, environmentId }),
    cookieMetadata: (profileId, environmentId) =>
      ipc.invoke(Channels.COOKIE_METADATA, { profileId, environmentId }),
    googleSessions: (profileId, environmentId) =>
      ipc.invoke(Channels.GOOGLE_SESSIONS, { profileId, environmentId }),
    quietVisit: (profileId, url, environmentId) =>
      ipc.invoke(Channels.QUIET_VISIT, { profileId, url, environmentId }),
    signOutSite: (profileId, site, environmentId) =>
      ipc.invoke(Channels.SIGN_OUT_SITE, { profileId, site, environmentId }),
    fill: (input) => ipc.invoke(Channels.FILL, input),
    fillMain: (input) => ipc.invoke(Channels.FILL_MAIN, input),
    readSessions: (input) => ipc.invoke(Channels.READ_SESSIONS, input),
    signOutMainSite: (site, environmentId) =>
      ipc.invoke(Channels.SIGN_OUT_MAIN_SITE, { site, environmentId }),
    withdrawFromMain: (input) => ipc.invoke(Channels.WITHDRAW_FROM_MAIN, input),
    onAccountsOwner: (listener) => {
      let live = true;
      const ask = () =>
        void ipc.invoke(Channels.ACCOUNTS_OWNER).then(
          (owner: unknown) => live && listener(owner === true),
          () => undefined,
        );
      ipc.on(Channels.ACCOUNTS_OWNER_CHANGED, ask);
      ask();
      return () => {
        live = false;
        ipc.removeListener(Channels.ACCOUNTS_OWNER_CHANGED, ask);
      };
    },
    chromeSignInBrowser: () => ipc.invoke(Channels.CHROME_SIGN_IN_BROWSER),
    chromeSignIn: (input) => ipc.invoke(Channels.CHROME_SIGN_IN, input),
    endChromeSignIn: (keep) => ipc.invoke(Channels.END_CHROME_SIGN_IN, keep),
    qualifySessionCopy: () => ipc.invoke(Channels.QUALIFY_SESSION_COPY),
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
