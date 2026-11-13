import * as NodeEvents from "node:events";

import { describe, expect, it, vi } from "vite-plus/test";

import { blockedSignIn, followTabSignIn, watchSignInPopup } from "./googleSignInRecovery.ts";

const OAUTH = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=secret";
const IDENTIFIER = "https://accounts.google.com/v3/signin/identifier";
const REJECTED = "https://accounts.google.com/v3/signin/rejected";
const SITE = "https://www.overleaf.com/login?next=/project";

/** A tab whose navigations the test drives: a page committing joins its history. */
function tab(first: string) {
  const contents = Object.assign(new NodeEvents.EventEmitter(), {
    entries: [first],
    getURL() {
      return this.entries.at(-1)!;
    },
    navigationHistory: {
      getAllEntries: () => contents.entries.map((url) => ({ url })),
      getActiveIndex: () => contents.entries.length - 1,
    },
  });
  const signIn = followTabSignIn(contents as never);
  const start = (url: string) =>
    contents.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false });
  const redirect = (url: string) =>
    contents.emit("did-redirect-navigation", { url, isMainFrame: true });
  const commit = (url: string) => void contents.entries.push(url);
  return { contents, signIn, start, redirect, commit };
}

describe("followTabSignIn", () => {
  it("restarts another site's Continue with Google from that site, after Google's redirects", () => {
    const t = tab(SITE);
    // A stale session lets the OAuth page through; Google then asks for credentials.
    t.start(OAUTH);
    t.redirect(IDENTIFIER);
    expect(t.signIn.blocked(-20, IDENTIFIER)).toEqual({
      page: "credentials",
      context: "tab",
      restartUrl: "https://www.overleaf.com/",
      pageUrl: IDENTIFIER,
    });
    // Or refuses, on a page that committed.
    t.commit(REJECTED);
    expect(t.signIn.rejectedInPage(REJECTED)?.restartUrl).toBe("https://www.overleaf.com/");
  });

  it("follows a site's own redirect to Continue with Google", () => {
    const t = tab(SITE);
    t.start("https://www.overleaf.com/auth/google");
    t.redirect(OAUTH);
    expect(t.signIn.blocked(-20, OAUTH)?.restartUrl).toBe("https://www.overleaf.com/");
  });

  it("starts Google's own sign-in at Google, and forgets a flow once the tab leaves Google", () => {
    const t = tab(SITE);
    t.start(IDENTIFIER);
    expect(t.signIn.blocked(-20, IDENTIFIER)?.restartUrl).toBeNull();
    t.start(OAUTH);
    t.start("https://example.com/");
    t.commit("https://example.com/");
    t.start(IDENTIFIER);
    expect(t.signIn.blocked(-20, IDENTIFIER)?.restartUrl).toBeNull();
  });

  it("never restarts from an insecure page or from Google's pages", () => {
    const t = tab("http://example.com/");
    t.commit("https://accounts.google.com/AccountChooser");
    t.start(OAUTH);
    expect(t.signIn.blocked(-20, OAUTH)?.restartUrl).toBeNull();
  });

  it("explains a frame's stopped sign-in over the page that holds it", () => {
    const t = tab(SITE);
    expect(t.signIn.blockedFrame(-20, IDENTIFIER)).toEqual({
      page: "credentials",
      context: "frame",
      restartUrl: "https://www.overleaf.com/",
      pageUrl: SITE,
    });
    expect(t.signIn.blockedFrame(-105, IDENTIFIER)).toBeNull();
    expect(t.signIn.blockedFrame(-20, "https://example.com/")).toBeNull();
  });

  it("stops following once disposed", () => {
    const t = tab(SITE);
    t.signIn.dispose();
    expect(t.contents.listenerCount("did-start-navigation")).toBe(0);
    expect(t.contents.listenerCount("did-redirect-navigation")).toBe(0);
  });
});

describe("blockedSignIn", () => {
  it("starts a sign-in stopped before its tab was followed at Google", () => {
    expect(blockedSignIn(-20, OAUTH)).toEqual({
      page: "transit",
      context: "tab",
      restartUrl: null,
      pageUrl: OAUTH,
    });
    expect(blockedSignIn(-20, "https://example.com/")).toBeNull();
  });
});

function popupWindow() {
  const contents = new NodeEvents.EventEmitter();
  const window = Object.assign(new NodeEvents.EventEmitter(), {
    webContents: contents,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    close: vi.fn(function (this: { destroyed: boolean }) {
      this.destroyed = true;
    }),
  });
  const opener = { url: "https://www.overleaf.com/login?x=1", getURL: () => opener.url };
  const report = vi.fn();
  watchSignInPopup(window as never, opener as never, report);
  return { contents, window, opener, report };
}

describe("watchSignInPopup", () => {
  it("closes a popup whose Google sign-in was stopped and explains it on the page that opened it", () => {
    const { contents, window, opener, report } = popupWindow();
    // The tab moved on before the popup's sign-in was stopped: the report stays with the old page.
    opener.url = "https://example.com/";
    contents.emit("did-fail-load", {}, -20, "ERR_BLOCKED_BY_CLIENT", OAUTH, true);
    contents.emit("did-navigate-in-page", {}, REJECTED, true);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      page: "transit",
      context: "popup",
      restartUrl: "https://www.overleaf.com/",
      pageUrl: "https://www.overleaf.com/login?x=1",
    });
    expect(window.close).toHaveBeenCalledOnce();
  });

  it("explains Google's refusal shown without a page load", () => {
    const { contents, report } = popupWindow();
    contents.emit("did-navigate-in-page", {}, REJECTED, true);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ page: "rejected" }));
  });

  it("explains a stopped sign-in frame in the popup without closing it", () => {
    const { contents, window, report } = popupWindow();
    contents.emit("did-fail-load", {}, -20, "ERR_BLOCKED_BY_CLIENT", IDENTIFIER, false);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ page: "credentials", context: "frame" }),
    );
    expect(window.close).not.toHaveBeenCalled();
  });

  it("leaves other failures and other sites' popups alone", () => {
    const { contents, window, report } = popupWindow();
    contents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", OAUTH, true);
    contents.emit("did-fail-load", {}, -20, "ERR_BLOCKED_BY_CLIENT", "https://example.com/", true);
    expect(report).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
  });
});
