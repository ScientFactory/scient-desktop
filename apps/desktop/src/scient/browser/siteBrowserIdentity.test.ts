import * as NodeEvents from "node:events";

import { describe, expect, it, vi } from "vite-plus/test";

import { asChromeIdentity, matchSiteBrowserIdentity } from "./siteBrowserIdentity.ts";

const prefix =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)";
const chrome = `${prefix} Chrome/152.0.7977.169 Safari/537.36`;
const native = `${prefix} Scient/1.0.0 Chrome/152.0.7977.169 Electron/44.10.0 Safari/537.36`;

function tab(destroyed = false) {
  return Object.assign(new NodeEvents.EventEmitter(), {
    isDestroyed: () => destroyed,
    reload: vi.fn(),
  });
}

function startSession() {
  const onBeforeSendHeaders = vi.fn();
  const onHeadersReceived = vi.fn();
  matchSiteBrowserIdentity({ webRequest: { onBeforeSendHeaders, onHeadersReceived } } as never);
  const [sendFilter, sendListener] = onBeforeSendHeaders.mock.calls[0]!;
  const [receiveFilter, receiveListener] = onHeadersReceived.mock.calls[0]!;

  const send = (url: string, requestHeaders: Record<string, string> = { "User-Agent": native }) => {
    const callback = vi.fn();
    sendListener({ requestHeaders, url }, callback);
    return callback.mock.calls[0]![0].requestHeaders as Record<string, string>;
  };
  const receive = (url: string, details: Record<string, unknown> = {}) => {
    const webContents = tab();
    const callback = vi.fn();
    receiveListener({ method: "GET", statusCode: 403, url, webContents, ...details }, callback);
    return { response: callback.mock.calls[0]![0], webContents };
  };
  return { receive, receiveFilter, send, sendFilter };
}

describe("asChromeIdentity", () => {
  it.each(["Scient/0.6.26", "Scient/0.6.27-beta.20261101.1", "ScientDev/44.10.0"])(
    "removes %s and Electron",
    (token) => {
      expect(
        asChromeIdentity(`${prefix} ${token} Chrome/152.0.7977.169 Electron/44.10.0 Safari/537.36`),
      ).toBe(chrome);
    },
  );

  it("leaves a plain Chrome identity alone", () => {
    expect(asChromeIdentity(chrome)).toBe(chrome);
  });
});

describe("matchSiteBrowserIdentity", () => {
  it("covers every site and leaves Cloudflare's challenge alone", () => {
    const { sendFilter } = startSession();
    expect(sendFilter).toEqual({
      urls: ["*://*/*"],
      excludeUrls: ["*://challenges.cloudflare.com/*"],
    });
  });

  it("watches page loads only, so a refused image or frame changes nothing", () => {
    expect(startSession().receiveFilter).toEqual({ urls: ["*://*/*"], types: ["mainFrame"] });
  });

  it("says Chrome and keeps the other headers", () => {
    expect(
      startSession().send("https://web.whatsapp.com/", {
        Accept: "text/html",
        "User-Agent": native,
      }),
    ).toEqual({ Accept: "text/html", "User-Agent": chrome });
  });

  it("passes a request without an identity through", () => {
    expect(startSession().send("https://example.com/", { Accept: "text/html" })).toEqual({
      Accept: "text/html",
    });
  });

  it("retries a refused page with the true identity once it has arrived", () => {
    const { receive, send } = startSession();
    const { response, webContents } = receive("https://www.sciencedirect.com/");

    expect(response).toEqual({});
    expect(webContents.reload).not.toHaveBeenCalled();
    expect(send("https://www.sciencedirect.com/search")["User-Agent"]).toBe(native);

    webContents.emit("did-navigate", {}, "https://www.sciencedirect.com/");
    expect(webContents.reload).toHaveBeenCalledOnce();
  });

  it("recognises the refused page when it arrives with a fragment", () => {
    const { webContents } = startSession().receive("https://example.com/paper");
    webContents.emit("did-navigate", {}, "https://example.com/paper#results");
    expect(webContents.reload).toHaveBeenCalledOnce();
  });

  it("leaves the next page alone if the user left before the refused page arrived", () => {
    const { webContents } = startSession().receive("https://example.com/");
    webContents.emit("did-navigate", {}, "https://example.org/");
    webContents.emit("did-navigate", {}, "https://example.com/");
    expect(webContents.reload).not.toHaveBeenCalled();
  });

  it("retries when the refused page is an empty error", () => {
    const { webContents } = startSession().receive("https://example.com/");
    webContents.emit("did-fail-load", {}, -379, "", "https://example.com/", true);
    expect(webContents.reload).toHaveBeenCalledOnce();
  });

  it("ignores a frame failing while the refused page arrives", () => {
    const { webContents } = startSession().receive("https://example.com/");
    webContents.emit("did-fail-load", {}, -3, "", "https://ads.example/", false);
    expect(webContents.reload).not.toHaveBeenCalled();
  });

  it("stops listening after the retry, so later pages aren't reloaded", () => {
    const { webContents } = startSession().receive("https://example.com/");
    webContents.emit("did-navigate", {}, "https://example.com/");
    webContents.emit("did-navigate", {}, "https://example.com/");
    webContents.emit("did-fail-load", {}, -3, "", "https://example.com/", true);
    expect(webContents.reload).toHaveBeenCalledOnce();
  });

  it("skips the retry if the tab closed first", () => {
    const { receive } = startSession();
    const callback = tab();
    const { webContents } = receive("https://example.com/", { webContents: callback });
    vi.spyOn(callback, "isDestroyed").mockReturnValue(true);
    webContents.emit("did-navigate", {}, "https://example.com/");
    expect(callback.reload).not.toHaveBeenCalled();
  });

  it("keeps Chrome for every other site after one refuses", () => {
    const { receive, send } = startSession();
    receive("https://www.sciencedirect.com/");
    expect(send("https://web.whatsapp.com/")["User-Agent"]).toBe(chrome);
  });

  it("retries once, so a site that refuses both identities keeps its own page", () => {
    const { receive } = startSession();
    receive("https://example.com/private");
    const { response, webContents } = receive("https://example.com/private");

    webContents.emit("did-navigate", {}, "https://example.com/");
    expect(webContents.reload).not.toHaveBeenCalled();
    expect(response).toEqual({});
  });

  it("remembers refusals per session, so profiles stay separate", () => {
    const first = startSession();
    const second = startSession();
    first.receive("https://www.sciencedirect.com/");
    expect(second.send("https://www.sciencedirect.com/")["User-Agent"]).toBe(chrome);
  });

  it.each([
    ["a page that loaded", { statusCode: 200 }],
    ["a different failure", { statusCode: 500 }],
    ["a refused form, which must not be sent twice", { method: "POST" }],
  ])("leaves %s alone", (_name, details) => {
    const { receive, send } = startSession();
    const { response, webContents } = receive("https://example.com/", details);

    webContents.emit("did-navigate", {}, "https://example.com/");
    expect(webContents.reload).not.toHaveBeenCalled();
    expect(response).toEqual({});
    expect(send("https://example.com/")["User-Agent"]).toBe(chrome);
  });

  it("does nothing for a request with no tab to retry in", () => {
    const { receive, send } = startSession();
    expect(receive("https://example.com/", { webContents: undefined }).response).toEqual({});
    expect(send("https://example.com/")["User-Agent"]).toBe(chrome);
  });

  it("does nothing for a tab that already closed", () => {
    const { receive, send } = startSession();
    const webContents = tab(true);

    expect(receive("https://example.com/", { webContents }).response).toEqual({});
    expect(send("https://example.com/")["User-Agent"]).toBe(chrome);
  });
});
