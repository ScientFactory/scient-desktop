import type { DesktopPreviewSignInBlockedEvent } from "@t3tools/contracts";
import {
  googleSignInPage,
  isGoogleOAuthPage,
  signInRestartUrl,
} from "@t3tools/shared/scientGoogleSignIn";
import type { BrowserWindow, WebContents } from "electron";

type Refused = Omit<DesktopPreviewSignInBlockedEvent, "tabId">;
type Report = (event: Refused) => void;
type Navigation = { readonly url: string; readonly isMainFrame: boolean };

const isRefusal = (url: string) => googleSignInPage(url) === "rejected";

/** The latest page of another site in the tab's history, from the page it shows now back. */
function siteInHistory(tab: Pick<WebContents, "navigationHistory">): string | null {
  const entries = tab.navigationHistory.getAllEntries();
  for (let index = tab.navigationHistory.getActiveIndex(); index >= 0; index -= 1) {
    const restart = signInRestartUrl(entries[index]?.url);
    if (restart) return restart;
  }
  return null;
}

/** Where a sign-in restarts when a load that began at `target` left `shown` on the same site. */
function sameSiteLink(shown: string, target: string): string | null {
  const site = signInRestartUrl(target);
  return site !== null && site === signInRestartUrl(shown) ? site : null;
}

export interface TabSignIn {
  readonly dispose: () => void;
}

/**
 * Reports Google's refusal once it shows in the tab or a frame; Google decides, nothing is stopped.
 * After another site's "Continue with Google" the sign-in restarts at that site, kept across
 * Google's redirects, never at a Google URL carrying OAuth state; Google's own restarts at Google.
 */
export function followTabSignIn(tab: WebContents, report: Report): TabSignIn {
  let startedAt: string | null = null;
  /** The site a page load began at when the page showing then was on that site: its own link. */
  let leftSite: string | null = null;
  const navigate = ({ url, isMainFrame }: Navigation) => {
    if (!isMainFrame) return;
    if (googleSignInPage(url) === null) startedAt = null;
    else if (startedAt === null && isGoogleOAuthPage(url)) startedAt = siteInHistory(tab);
  };
  const started = (details: Navigation & { readonly isSameDocument: boolean }) => {
    if (details.isSameDocument) return;
    if (details.isMainFrame) leftSite = sameSiteLink(tab.getURL(), details.url);
    navigate(details);
  };
  const refused = (url: string) =>
    report({ page: "rejected", context: "tab", restartUrl: startedAt, pageUrl: url });
  const navigated = (_event: unknown, url: string) => {
    // A site's own sign-in link that its server sent on to Google, even if no redirect was seen.
    if (startedAt === null && googleSignInPage(url) !== null) startedAt = leftSite;
    if (isRefusal(url)) refused(url);
  };
  // Google's refusal can arrive without a page load.
  const navigatedInPage = (_event: unknown, url: string, isMainFrame: boolean) => {
    if (isMainFrame && isRefusal(url)) refused(url);
  };
  const frameNavigated = (
    _event: unknown,
    url: string,
    _code: number,
    _status: string,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame || !isRefusal(url)) return;
    const page = tab.getURL();
    report({
      page: "rejected",
      context: "frame",
      restartUrl: signInRestartUrl(page),
      pageUrl: page,
    });
  };
  tab.on("did-start-navigation", started);
  tab.on("did-redirect-navigation", navigate);
  tab.on("did-navigate", navigated);
  tab.on("did-navigate-in-page", navigatedInPage);
  tab.on("did-frame-navigate", frameNavigated);
  // A refusal the tab committed before it was followed, such as a restored tab's.
  const shown = tab.getURL();
  if (isRefusal(shown)) {
    const entries = tab.navigationHistory.getAllEntries();
    if (entries.some(({ url }) => isGoogleOAuthPage(url))) startedAt = siteInHistory(tab);
    refused(shown);
  }
  return {
    dispose: () => {
      tab.off("did-start-navigation", started);
      tab.off("did-redirect-navigation", navigate);
      tab.off("did-navigate", navigated);
      tab.off("did-navigate-in-page", navigatedInPage);
      tab.off("did-frame-navigate", frameNavigated);
    },
  };
}

/**
 * A window a page opened for "Continue with Google": when Google refuses the sign-in in it, the
 * window closes and the tab that opened it explains, offering to sign in again from that page's
 * site where it works. That page is the one the opener showed when the window opened, so a late
 * report can't attach to a page the tab moved on to.
 */
export function watchSignInPopup(window: BrowserWindow, opener: WebContents, report: Report) {
  const popup = window.webContents;
  const pageUrl = opener.getURL();
  const restartUrl = signInRestartUrl(pageUrl);
  let reported = false;
  let reportedFrame = false;
  const refused = () => {
    if (!reported) {
      reported = true;
      report({ page: "rejected", context: "popup", restartUrl, pageUrl });
    }
    if (!window.isDestroyed()) window.close();
  };
  popup.on("did-navigate", (_event, url) => {
    if (isRefusal(url)) refused();
  });
  popup.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame && isRefusal(url)) refused();
  });
  // A refused frame inside the window: the window may still be of use, so it stays open.
  popup.on("did-frame-navigate", (_event, url, _code, _status, isMainFrame) => {
    if (isMainFrame || reported || reportedFrame || !isRefusal(url)) return;
    reportedFrame = true;
    report({ page: "rejected", context: "frame", restartUrl, pageUrl });
  });
}
