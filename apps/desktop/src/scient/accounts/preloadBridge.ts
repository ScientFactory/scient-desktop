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
    importBrowserPasswords: (input) => ipc.invoke(Channels.IMPORT_BROWSER_PASSWORDS, input),
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
    setUndoDeadlines: (deadlines) => ipc.invoke(Channels.SAVE_DEADLINES, { deadlines }),
    setProfileGenerations: (generations, environmentId) =>
      ipc.invoke(Channels.PROFILE_GENERATIONS, { generations, environmentId }),
    signOutSiteKept: (profileId, site, operationId, environmentId, at) =>
      ipc.invoke(Channels.SIGN_OUT_KEPT, { profileId, site, operationId, environmentId, ...at }),
    restoreSignOut: (profileId, operationId, environmentId, at) =>
      ipc.invoke(Channels.RESTORE_SIGN_OUT, { profileId, operationId, environmentId, ...at }),
    purgeProfileData: (profileId, generation, environmentId) =>
      ipc.invoke(Channels.PURGE_PROFILE_DATA, { profileId, generation, environmentId }),
    copyProfileSites: (profileId, into, sites, move, operationId, environmentId, at) =>
      ipc.invoke(Channels.COPY_PROFILE_SITES, {
        profileId,
        into,
        sites,
        move,
        operationId,
        environmentId,
        ...at,
      }),
    undoProfileCopy: (profileId, into, operationId, environmentId, at) =>
      ipc.invoke(Channels.UNDO_PROFILE_COPY, {
        profileId,
        into,
        operationId,
        environmentId,
        ...at,
      }),
    forgetChromeSignIn: (profileId, since) =>
      ipc.invoke(Channels.FORGET_CHROME_SIGN_IN, { profileId, ...(since ? { since } : {}) }),
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
    onGoogleActivity: (listener) => {
      const handler = () => listener();
      ipc.on(Channels.GOOGLE_ACTIVITY, handler);
      return () => ipc.removeListener(Channels.GOOGLE_ACTIVITY, handler);
    },
    browserConnection: (sourceId) => ipc.invoke(Channels.BROWSER_CONNECTION, sourceId),
    openFullDiskAccess: () => ipc.invoke(Channels.OPEN_FULL_DISK_ACCESS),
    relaunch: () => ipc.invoke(Channels.RELAUNCH),
    chromeSignInBrowser: () => ipc.invoke(Channels.CHROME_SIGN_IN_BROWSER),
    chromeSignIn: (input) => ipc.invoke(Channels.CHROME_SIGN_IN, input),
    endChromeSignIn: (keep, attemptId) =>
      ipc.invoke(Channels.END_CHROME_SIGN_IN, attemptId === undefined ? keep : { keep, attemptId }),
    qualifySessionCopy: () => ipc.invoke(Channels.QUALIFY_SESSION_COPY),
    loginForm: (tabId) => ipc.invoke(Channels.LOGIN_FORM, { tabId }),
    signInPage: (tabId) => ipc.invoke(Channels.SIGN_IN_PAGE, { tabId }),
    pageSecrets: (tabId, offer, documentId) =>
      ipc.invoke(Channels.PAGE_SECRETS, { tabId, offer, documentId }),
    seekPasswordPage: (tabId, origin) => ipc.invoke(Channels.SEEK_PASSWORD_PAGE, { tabId, origin }),
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
