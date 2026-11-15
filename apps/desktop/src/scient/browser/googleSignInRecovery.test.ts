import * as NodeEvents from "node:events";

import { describe, expect, it, vi } from "vite-plus/test";

import { followTabSignIn, watchSignInPopup } from "./googleSignInRecovery.ts";

const OAUTH = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=secret";
const IDENTIFIER = "https://accounts.google.com/v3/signin/identifier";
const PASSWORD = "https://accounts.google.com/v3/signin/challenge/pwd";
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
  const report = vi.fn();
  const signIn = followTabSignIn(contents as never, report);
  const start = (url: string) =>
    contents.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false });
  const redirect = (url: string) =>
    contents.emit("did-redirect-navigation", { url, isMainFrame: true });
  const commit = (url: string) => {
    contents.entries.push(url);
    contents.emit("did-navigate", {}, url, 200, "OK");
    contents.emit("did-frame-navigate", {}, url, 200, "OK", true, 1, 1);
  };
  const frame = (url: string) =>
    contents.emit("did-frame-navigate", {}, url, 200, "OK", false, 1, 2);
  return { contents, report, signIn, start, redirect, commit, frame };
}

describe("followTabSignIn", () => {
  it("lets Google's sign-in pages load without reporting anything", () => {
    const t = tab(SITE);
    for (const url of [OAUTH, IDENTIFIER, PASSWORD]) {
      t.start(url);
      t.commit(url);
    }
    t.frame(IDENTIFIER);
    expect(t.report).not.toHaveBeenCalled();
  });

  it("restarts another site's refused Continue with Google from that site", () => {
    const t = tab(SITE);
    t.start(OAUTH);
    t.redirect(IDENTIFIER);
    t.commit(IDENTIFIER);
    t.start(REJECTED);
    t.commit(REJECTED);
    expect(t.report).toHaveBeenCalledExactlyOnceWith({
      page: "rejected",
      context: "tab",
      restartUrl: "https://www.overleaf.com/",
      pageUrl: REJECTED,
    });
  });

  it("reports Google's refusal shown without a page load", () => {
    const t = tab(SITE);
    t.start(IDENTIFIER);
    t.commit(IDENTIFIER);
    t.contents.emit("did-navigate-in-page", {}, REJECTED, true);
    t.contents.emit("did-navigate-in-page", {}, REJECTED, false);
    expect(t.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ page: "rejected", context: "tab", pageUrl: REJECTED }),
    );
  });

  it("follows a site's own redirect to Continue with Google", () => {
    const t = tab(SITE);
    t.start("https://www.overleaf.com/auth/google");
    t.redirect(OAUTH);
    t.commit(REJECTED);
    expect(t.report.mock.lastCall?.[0].restartUrl).toBe("https://www.overleaf.com/");
  });

  it("starts Google's own sign-in at Google, and forgets a flow once the tab leaves Google", () => {
    const t = tab(SITE);
    t.start(IDENTIFIER);
    t.commit(REJECTED);
    expect(t.report.mock.lastCall?.[0].restartUrl).toBeNull();
    t.start(OAUTH);
    t.start("https://example.com/");
    t.commit("https://example.com/");
    t.start(IDENTIFIER);
    t.commit(REJECTED);
    expect(t.report.mock.lastCall?.[0].restartUrl).toBeNull();
  });

  it("never restarts from an insecure page or from Google's pages", () => {
    const t = tab("http://example.com/");
    t.commit("https://accounts.google.com/AccountChooser");
    t.start(OAUTH);
    t.commit(REJECTED);
    expect(t.report.mock.lastCall?.[0].restartUrl).toBeNull();
  });

  it("explains a frame's refusal over the page that holds it", () => {
    const t = tab(SITE);
    t.frame("https://example.com/");
    t.frame(REJECTED);
    expect(t.report).toHaveBeenCalledExactlyOnceWith({
      page: "rejected",
      context: "frame",
      restartUrl: "https://www.overleaf.com/",
      pageUrl: SITE,
    });
  });

  it("explains a refusal the tab already showed when it was first followed", () => {
    const contents = Object.assign(new NodeEvents.EventEmitter(), {
      getURL: () => REJECTED,
      navigationHistory: {
        getAllEntries: () => [SITE, OAUTH, IDENTIFIER, REJECTED].map((url) => ({ url })),
        getActiveIndex: (): number => 3,
      },
    });
    const report = vi.fn();
    followTabSignIn(contents as never, report);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      page: "rejected",
      context: "tab",
      restartUrl: "https://www.overleaf.com/",
      pageUrl: REJECTED,
    });
    // Google's own sign-in, refused before the tab was followed, starts again at Google.
    contents.navigationHistory.getAllEntries = () => [IDENTIFIER, REJECTED].map((url) => ({ url }));
    contents.navigationHistory.getActiveIndex = () => 1;
    followTabSignIn(contents as never, report);
    expect(report.mock.lastCall?.[0].restartUrl).toBeNull();
  });

  it("stops following once disposed", () => {
    const t = tab(SITE);
    t.signIn.dispose();
    for (const event of [
      "did-start-navigation",
      "did-redirect-navigation",
      "did-navigate",
      "did-navigate-in-page",
      "did-frame-navigate",
    ]) {
      expect(t.contents.listenerCount(event)).toBe(0);
    }
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
  it("closes a popup Google refused and explains it on the page that opened it", () => {
    const { contents, window, opener, report } = popupWindow();
    contents.emit("did-navigate", {}, IDENTIFIER, 200, "OK");
    expect(window.close).not.toHaveBeenCalled();
    // The tab moved on before Google refused: the report stays with the old page.
    opener.url = "https://example.com/";
    contents.emit("did-navigate", {}, REJECTED, 200, "OK");
    contents.emit("did-navigate-in-page", {}, REJECTED, true);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      page: "rejected",
      context: "popup",
      restartUrl: "https://www.overleaf.com/",
      pageUrl: "https://www.overleaf.com/login?x=1",
    });
    expect(window.close).toHaveBeenCalledOnce();
  });

  it("explains Google's refusal shown without a page load", () => {
    const { contents, window, report } = popupWindow();
    contents.emit("did-navigate-in-page", {}, REJECTED, false);
    expect(report).not.toHaveBeenCalled();
    contents.emit("did-navigate-in-page", {}, REJECTED, true);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ page: "rejected" }));
    expect(window.close).toHaveBeenCalledOnce();
  });

  it("explains a refused frame inside the popup without closing it", () => {
    const { contents, window, report } = popupWindow();
    contents.emit("did-frame-navigate", {}, IDENTIFIER, 200, "OK", false, 1, 2);
    contents.emit("did-frame-navigate", {}, REJECTED, 200, "OK", false, 1, 2);
    contents.emit("did-frame-navigate", {}, REJECTED, 200, "OK", false, 1, 3);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      page: "rejected",
      context: "frame",
      restartUrl: "https://www.overleaf.com/",
      pageUrl: "https://www.overleaf.com/login?x=1",
    });
    expect(window.close).not.toHaveBeenCalled();
    // The window itself is then refused: it closes, and says so.
    contents.emit("did-navigate", {}, REJECTED, 200, "OK");
    expect(window.close).toHaveBeenCalledOnce();
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ context: "popup" }));
  });

  it("leaves Google's other pages and other sites alone", () => {
    const { contents, window, report } = popupWindow();
    contents.emit("did-navigate", {}, OAUTH, 200, "OK");
    contents.emit("did-navigate", {}, PASSWORD, 200, "OK");
    contents.emit("did-navigate", {}, "https://example.com/", 200, "OK");
    expect(report).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
  });
});
