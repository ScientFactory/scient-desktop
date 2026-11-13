import type { DesktopPreviewSignInBlockedEvent } from "@t3tools/contracts";
import {
  googleSignInPage,
  isGoogleOAuthPage,
  signInRestartUrl,
} from "@t3tools/shared/scientGoogleSignIn";
import type { BrowserWindow, WebContents } from "electron";

import { isBlockedGoogleSignIn } from "./googleSignInGuard.ts";

/** What an agent reading the tab's failed load is told. */
export const BLOCKED_GOOGLE_SIGN_IN_DESCRIPTION =
  "Google doesn't allow signing in inside Scient's browser. The person can sign in with " +
  "“Sign in in a Chrome window” in Accounts, which brings the sign-in into this profile.";

type Blocked = Omit<DesktopPreviewSignInBlockedEvent, "tabId">;
type Report = (event: Blocked) => void;
type Navigation = { readonly url: string; readonly isMainFrame: boolean };

/** The latest page of another site in the tab's history, from the page it shows now back. */
function siteInHistory(tab: Pick<WebContents, "navigationHistory">): string | null {
  const entries = tab.navigationHistory.getAllEntries();
  for (let index = tab.navigationHistory.getActiveIndex(); index >= 0; index -= 1) {
    const restart = signInRestartUrl(entries[index]?.url);
    if (restart) return restart;
  }
  return null;
}

/**
 * A sign-in page the guard stopped in a tab no flow was followed for yet, such as one that failed
 * before the tab was registered: it starts again at Google.
 */
export function blockedSignIn(code: number, url: string): Blocked | null {
  const page = googleSignInPage(url);
  return page && isBlockedGoogleSignIn(code, url)
    ? { page, context: "tab", restartUrl: null, pageUrl: url }
    : null;
}

/** A frame's sign-in page the guard stopped: explained over the page that holds the frame. */
function blockedFrame(code: number, url: string, page: string): Blocked | null {
  const stopped = googleSignInPage(url);
  return stopped && isBlockedGoogleSignIn(code, url)
    ? { page: stopped, context: "frame", restartUrl: signInRestartUrl(page), pageUrl: page }
    : null;
}

export interface TabSignIn {
  /** The tab's own failed load, when it was Google's sign-in that the guard stopped. */
  readonly blocked: (code: number, url: string) => Blocked | null;
  /** A failed frame load in the tab, when it was Google's sign-in that the guard stopped. */
  readonly blockedFrame: (code: number, url: string) => Blocked | null;
  /** Google's refusal shown without a new page load, as its sign-in pages sometimes do. */
  readonly rejectedInPage: (url: string) => Blocked | null;
  readonly dispose: () => void;
}

/**
 * Follows the tab's Google sign-ins. When another site sends the tab to "Continue with Google",
 * the site it came from is kept across Google's redirects: if Google then asks for credentials or
 * refuses, the sign-in starts again there, never at a Google URL carrying the site's OAuth state.
 * Google's own sign-in starts again at Google. A page that isn't Google's sign-in ends the flow.
 */
export function followTabSignIn(tab: WebContents): TabSignIn {
  let startedAt: string | null = null;
  const navigate = ({ url, isMainFrame }: Navigation) => {
    if (!isMainFrame) return;
    if (googleSignInPage(url) === null) startedAt = null;
    else if (startedAt === null && isGoogleOAuthPage(url)) startedAt = siteInHistory(tab);
  };
  const started = (details: Navigation & { readonly isSameDocument: boolean }) => {
    if (!details.isSameDocument) navigate(details);
  };
  tab.on("did-start-navigation", started);
  tab.on("did-redirect-navigation", navigate);
  const blocked = (page: DesktopPreviewSignInBlockedEvent["page"], url: string): Blocked => ({
    page,
    context: "tab",
    restartUrl: startedAt,
    pageUrl: url,
  });
  return {
    blocked: (code, url) => {
      const page = googleSignInPage(url);
      return page && isBlockedGoogleSignIn(code, url) ? blocked(page, url) : null;
    },
    blockedFrame: (code, url) => blockedFrame(code, url, tab.getURL()),
    rejectedInPage: (url) =>
      googleSignInPage(url) === "rejected" ? blocked("rejected", url) : null,
    dispose: () => {
      tab.off("did-start-navigation", started);
      tab.off("did-redirect-navigation", navigate);
    },
  };
}

/**
 * A window a page opened for "Continue with Google": when the guard stops Google's sign-in in it,
 * the window closes and the tab that opened it explains, offering to sign in again from that
 * page's site where it works. That page is the one the opener showed when the window opened, so a
 * late report can't attach to a page the tab moved on to.
 */
export function watchSignInPopup(window: BrowserWindow, opener: WebContents, report: Report) {
  const popup = window.webContents;
  const pageUrl = opener.getURL();
  const restartUrl = signInRestartUrl(pageUrl);
  let reported = false;
  const stop = (page: DesktopPreviewSignInBlockedEvent["page"]) => {
    if (reported) return;
    reported = true;
    report({ page, context: "popup", restartUrl, pageUrl });
    if (!window.isDestroyed()) window.close();
  };
  popup.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    const page = googleSignInPage(url);
    if (!page || !isBlockedGoogleSignIn(code, url)) return;
    if (isMainFrame) stop(page);
    // A sign-in frame inside the window: the window may still be of use, so it stays open.
    else if (!reported) {
      reported = true;
      report({ page, context: "frame", restartUrl, pageUrl });
    }
  });
  popup.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame && googleSignInPage(url) === "rejected") stop("rejected");
  });
}
