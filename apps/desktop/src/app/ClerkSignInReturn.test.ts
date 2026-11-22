// @effect-diagnostics nodeBuiltinImport:off - Exercises the real loopback listener.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as Electron from "electron";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { handlers, emit } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  emit: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown) => unknown) => {
      if (handlers.has(channel)) throw new Error(`second handler for ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  app: { emit },
}));

import {
  CLERK_ATTEMPT_PARAM,
  CLERK_OPEN_CHANNEL,
  CLERK_REDIRECT_URL_CHANNEL,
  clerkDeepLinkForCallback,
  clerkSignInReturnUrl,
  createClerkBridgeWithSignInReturn,
  isTopLevelNavigation,
  renderClerkSignInReturnPage,
} from "./ClerkSignInReturn.ts";
import { SCIENT_SYMBOL_SVG } from "./scientSymbolSvg.ts";

const navigate = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };
const windowEvent = {};

/** A request with browser fetch-metadata headers, which Node's fetch does not let callers set. */
const visit = (url: string, headers: Record<string, string> = navigate) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    NodeHttp.get(url, { headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    }).on("error", reject);
  });

/** Stands in for @clerk/electron 0.1.10: it tags each sign-in with a fresh attempt id. */
const createBridge = (scheme: string) => () => {
  let attempt = 0;
  const { ipcMain } = Electron;
  ipcMain.handle(CLERK_REDIRECT_URL_CHANNEL, () => {
    attempt += 1;
    return `${scheme}://app/?${CLERK_ATTEMPT_PARAM}=attempt-${attempt}`;
  });
  ipcMain.handle(CLERK_OPEN_CHANNEL, (_event: unknown, url: unknown) => `opened ${String(url)}`);
  ipcMain.handle("clerk:other", () => "other");
  return { cleanup: vi.fn(() => ipcMain.removeHandler(CLERK_REDIRECT_URL_CHANNEL)) };
};

const redirectUrl = async () =>
  String(await handlers.get(CLERK_REDIRECT_URL_CHANNEL)!(windowEvent));

describe("ClerkSignInReturn", () => {
  let bridge: { cleanup(): void } | undefined;
  afterEach(() => {
    bridge?.cleanup();
    bridge = undefined;
    handlers.clear();
    emit.mockReset();
  });

  const install = (isDevelopment = true) => {
    const scheme = isDevelopment ? "scient-next-dev" : "scient";
    bridge = createClerkBridgeWithSignInReturn(createBridge(scheme), {
      scheme,
      host: "app",
      isDevelopment,
    });
    return bridge;
  };

  it("turns the browser callback into the deep link the bridge expects", () => {
    expect(
      clerkDeepLinkForCallback("/clerk/callback?rotating_token_nonce=abc&x=1", "scient", "app"),
    ).toBe("scient://app/?rotating_token_nonce=abc&x=1");
    expect(clerkDeepLinkForCallback("/elsewhere?rotating_token_nonce=abc", "scient", "app")).toBe(
      null,
    );
  });

  it("accepts browser navigations only", () => {
    expect(isTopLevelNavigation(navigate)).toBe(true);
    expect(isTopLevelNavigation({})).toBe(true);
    expect(isTopLevelNavigation({ "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors" })).toBe(
      false,
    );
    expect(isTopLevelNavigation({ "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" })).toBe(
      false,
    );
  });

  it("keeps its copy of the Scient symbol identical to the web asset", () => {
    const asset = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../../../web/src/assets/scient-symbol.svg"),
      "utf8",
    );
    expect(SCIENT_SYMBOL_SVG).toBe(asset);
  });

  it("renders success and failure", () => {
    expect(renderClerkSignInReturnPage(true)).toContain("You're signed in");
    expect(renderClerkSignInReturnPage(false)).toContain("Sign-in didn't finish");
  });

  it("keeps the library's other handlers and its attempt id", async () => {
    install();
    expect(handlers.has("clerk:other")).toBe(true);
    const redirect = await redirectUrl();
    expect(redirect).toBe(`${clerkSignInReturnUrl(true)}?${CLERK_ATTEMPT_PARAM}=attempt-1`);
  });

  it("hands the current attempt's callback to the bridge once", async () => {
    install();
    const redirect = await redirectUrl();
    const response = await visit(`${redirect}&rotating_token_nonce=abc`);
    expect(response.status).toBe(200);
    expect(response.body).toContain("You're signed in");
    expect(emit).toHaveBeenCalledWith(
      "open-url",
      expect.anything(),
      `scient-next-dev://app/?${CLERK_ATTEMPT_PARAM}=attempt-1&rotating_token_nonce=abc`,
    );
    await expect(visit(`${redirect}&rotating_token_nonce=again`)).rejects.toThrow();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("forwards each issued attempt once and ignores the rest", async () => {
    install();
    const first = await redirectUrl();
    const second = await redirectUrl();
    const forged = await visit(`${clerkSignInReturnUrl(true)}?rotating_token_nonce=forged`);
    expect(forged.body).toContain("Sign-in didn't finish");
    const unknown = await visit(
      `${clerkSignInReturnUrl(true)}?${CLERK_ATTEMPT_PARAM}=attempt-9&rotating_token_nonce=x`,
    );
    expect(unknown.body).toContain("Sign-in didn't finish");
    expect(emit).not.toHaveBeenCalled();

    // Another window's attempt still reaches the bridge, which decides which one it awaits.
    expect((await visit(`${first}&rotating_token_nonce=one`)).body).toContain("You're signed in");
    expect(emit).toHaveBeenLastCalledWith(
      "open-url",
      expect.anything(),
      `scient-next-dev://app/?${CLERK_ATTEMPT_PARAM}=attempt-1&rotating_token_nonce=one`,
    );
    expect((await visit(`${first}&rotating_token_nonce=again`)).body).toContain(
      "Sign-in didn't finish",
    );
    await visit(`${second}&rotating_token_nonce=two`);
    expect(emit).toHaveBeenLastCalledWith(
      "open-url",
      expect.anything(),
      `scient-next-dev://app/?${CLERK_ATTEMPT_PARAM}=attempt-2&rotating_token_nonce=two`,
    );
    expect(emit).toHaveBeenCalledTimes(2);
    await expect(visit(`${second}&rotating_token_nonce=late`)).rejects.toThrow();
  });

  it("passes the browser-open call through to the library", async () => {
    install();
    expect(await handlers.get(CLERK_OPEN_CHANNEL)!(windowEvent, "https://accounts.example")).toBe(
      "opened https://accounts.example",
    );
  });

  it("waits long before the browser opens and five minutes after", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      install();
      const redirect = await redirectUrl();
      vi.advanceTimersByTime(10 * 60_000);
      await handlers.get(CLERK_OPEN_CHANNEL)!(windowEvent, "https://accounts.example");
      vi.advanceTimersByTime(4 * 60_000);
      expect((await visit(`${redirect}&rotating_token_nonce=ok`)).body).toContain(
        "You're signed in",
      );

      const later = await redirectUrl();
      await handlers.get(CLERK_OPEN_CHANNEL)!(windowEvent, "https://accounts.example");
      vi.advanceTimersByTime(5 * 60_000 + 1);
      await expect(visit(`${later}&rotating_token_nonce=late`)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores requests that are not page visits", async () => {
    install(false);
    const redirect = await redirectUrl();
    const response = await visit(`${redirect}&rotating_token_nonce=abc`, {
      "sec-fetch-dest": "image",
      "sec-fetch-mode": "no-cors",
    });
    expect(response.status).toBe(404);
    expect(emit).not.toHaveBeenCalled();
  });

  it("falls back to the deep link when the port is taken", async () => {
    const blocker = NodeHttp.createServer();
    await new Promise<void>((resolve) => blocker.listen(34340, "127.0.0.1", resolve));
    try {
      install();
      expect(await redirectUrl()).toBe(`scient-next-dev://app/?${CLERK_ATTEMPT_PARAM}=attempt-1`);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("closes a listener that finishes binding after cleanup", async () => {
    const current = install();
    const pending = redirectUrl();
    current.cleanup();
    bridge = undefined;
    expect(await pending).toBe(`scient-next-dev://app/?${CLERK_ATTEMPT_PARAM}=attempt-1`);
    await expect(
      visit(`${clerkSignInReturnUrl(true)}?rotating_token_nonce=late`),
    ).rejects.toThrow();
  });

  it("cleans up through the library", () => {
    const current = install();
    current.cleanup();
    bridge = undefined;
    expect(handlers.has(CLERK_REDIRECT_URL_CHANNEL)).toBe(false);
  });
});
