import { describe, expect, it, vi } from "vite-plus/test";

import { matchSiteBrowserIdentity, withoutAppName } from "./siteBrowserIdentity.ts";

const prefix =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)";
const engine = "Chrome/152.0.7977.169 Electron/44.10.0 Safari/537.36";

function listen() {
  const onBeforeSendHeaders = vi.fn();
  matchSiteBrowserIdentity({ webRequest: { onBeforeSendHeaders } } as never);
  const [filter, listener] = onBeforeSendHeaders.mock.calls[0]!;
  return { filter, listener };
}

describe("withoutAppName", () => {
  it.each(["Scient/0.6.26", "Scient/0.6.27-beta.20261101.1", "ScientDev/44.10.0"])(
    "removes %s and keeps Chrome and Electron",
    (token) => {
      expect(withoutAppName(`${prefix} ${token} ${engine}`)).toBe(`${prefix} ${engine}`);
    },
  );

  it("leaves an identity without an app name alone", () => {
    expect(withoutAppName(`${prefix} ${engine}`)).toBe(`${prefix} ${engine}`);
  });
});

describe("matchSiteBrowserIdentity", () => {
  it("applies to WhatsApp Web only, so other sites keep the native identity", () => {
    expect(listen().filter).toEqual({ urls: ["*://web.whatsapp.com/*"] });
  });

  it("changes the identity and keeps the other headers", () => {
    const callback = vi.fn();
    listen().listener(
      { requestHeaders: { Accept: "text/html", "User-Agent": `${prefix} Scient/1.0.0 ${engine}` } },
      callback,
    );
    expect(callback).toHaveBeenCalledWith({
      requestHeaders: { Accept: "text/html", "User-Agent": `${prefix} ${engine}` },
    });
  });

  it("passes a request without an identity through", () => {
    const callback = vi.fn();
    listen().listener({ requestHeaders: { Accept: "text/html" } }, callback);
    expect(callback).toHaveBeenCalledWith({ requestHeaders: { Accept: "text/html" } });
  });
});
