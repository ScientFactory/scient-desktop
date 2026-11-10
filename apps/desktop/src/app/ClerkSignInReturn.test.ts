// @effect-diagnostics nodeBuiltinImport:off - Exercises the real loopback listener.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { handlers, emit } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => unknown>(),
  emit: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  app: { emit },
}));

import {
  CLERK_REDIRECT_URL_CHANNEL,
  clerkDeepLinkForCallback,
  clerkSignInReturnUrl,
  installClerkSignInReturn,
  isTopLevelNavigation,
  renderClerkSignInReturnPage,
} from "./ClerkSignInReturn.ts";
import { SCIENT_SYMBOL_SVG } from "./scientSymbolSvg.ts";

const mainFrame = {};
const navigate = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };

/** A request with browser fetch-metadata headers, which Node's fetch does not let callers set. */
const visit = (url: string, headers: Record<string, string>) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    NodeHttp.get(url, { headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    }).on("error", reject);
  });
const windowEvent = { sender: { getType: () => "window", mainFrame }, senderFrame: mainFrame };

describe("ClerkSignInReturn", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
    handlers.clear();
    emit.mockReset();
  });

  it("turns the browser callback into the deep link the bridge expects", () => {
    expect(
      clerkDeepLinkForCallback("/clerk/callback?rotating_token_nonce=abc&x=1", "scient", "app"),
    ).toBe("scient://app/?rotating_token_nonce=abc&x=1");
    expect(clerkDeepLinkForCallback("/elsewhere?rotating_token_nonce=abc", "scient", "app")).toBe(
      null,
    );
  });

  it("accepts browser navigations only", () => {
    expect(
      isTopLevelNavigation({ "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" }),
    ).toBe(true);
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

  it("renders success and failure without the provider's details", () => {
    expect(renderClerkSignInReturnPage(true)).toContain("You're signed in");
    expect(renderClerkSignInReturnPage(false)).toContain("Sign-in didn't finish");
  });

  it("serves the return page once and hands the callback to the bridge", async () => {
    stop = installClerkSignInReturn({
      scheme: "scient-next-dev",
      host: "app",
      isDevelopment: true,
    });
    const redirect = await handlers.get(CLERK_REDIRECT_URL_CHANNEL)!(windowEvent);
    expect(redirect).toBe(clerkSignInReturnUrl(true));

    const response = await visit(`${redirect}?rotating_token_nonce=abc`, navigate);
    expect(response.status).toBe(200);
    expect(response.body).toContain("You're signed in");
    expect(emit).toHaveBeenCalledWith(
      "open-url",
      expect.anything(),
      "scient-next-dev://app/?rotating_token_nonce=abc",
    );
    await expect(visit(`${redirect}?rotating_token_nonce=again`, navigate)).rejects.toThrow();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("ignores requests that are not page visits", async () => {
    stop = installClerkSignInReturn({ scheme: "scient", host: "app", isDevelopment: false });
    const redirect = String(await handlers.get(CLERK_REDIRECT_URL_CHANNEL)!(windowEvent));
    const response = await visit(`${redirect}?rotating_token_nonce=abc`, {
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
      stop = installClerkSignInReturn({
        scheme: "scient-next-dev",
        host: "app",
        isDevelopment: true,
      });
      expect(await handlers.get(CLERK_REDIRECT_URL_CHANNEL)!(windowEvent)).toBe(
        "scient-next-dev://app/",
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("rejects requests from subframes", async () => {
    stop = installClerkSignInReturn({ scheme: "scient", host: "app", isDevelopment: false });
    await expect(
      Promise.resolve().then(() =>
        handlers.get(CLERK_REDIRECT_URL_CHANNEL)!({ ...windowEvent, senderFrame: {} }),
      ),
    ).rejects.toThrow("main frame");
  });
});
