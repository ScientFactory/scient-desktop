import { describe, expect, it, vi } from "vite-plus/test";

import { guardGoogleSignIn, isBlockedGoogleSignIn } from "./googleSignInGuard.ts";

type Listener = (
  details: { url: string; resourceType: "mainFrame" | "subFrame" },
  callback: (response: { cancel?: boolean }) => void,
) => void;

function startSession(cookies: ReadonlyArray<{ name: string; value?: string }> | Error) {
  const onBeforeRequest = vi.fn();
  const get = vi.fn(() =>
    cookies instanceof Error
      ? Promise.reject(cookies)
      : Promise.resolve(cookies.map(({ name, value = "x" }) => ({ name, value }))),
  );
  guardGoogleSignIn({ webRequest: { onBeforeRequest }, cookies: { get } } as never);
  const [filter, listener] = onBeforeRequest.mock.calls[0] as [unknown, Listener];
  const request = (url: string, resourceType: "mainFrame" | "subFrame" = "mainFrame") => {
    const { promise, resolve } = Promise.withResolvers<{ cancel?: boolean }>();
    listener({ url, resourceType }, resolve);
    return promise;
  };
  return { filter, request };
}

const IDENTIFIER = "https://accounts.google.com/v3/signin/identifier";
const OAUTH = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";

describe("guardGoogleSignIn", () => {
  it("watches only page and frame loads on Google's sign-in host", () => {
    expect(startSession([]).filter).toEqual({
      urls: ["https://accounts.google.com/*"],
      types: ["mainFrame", "subFrame"],
    });
  });

  it("stops Google's sign-in in a profile with no Google session", async () => {
    const { request } = startSession([{ name: "NID" }, { name: "SID", value: "" }]);
    expect(await request("https://accounts.google.com/ServiceLogin")).toEqual({ cancel: true });
    expect(await request(OAUTH)).toEqual({ cancel: true });
  });

  it("lets a profile with a Google session use the account chooser and Continue with Google", async () => {
    const { request } = startSession([{ name: "__Secure-1PSID" }]);
    expect(await request("https://accounts.google.com/AccountChooser")).toEqual({ cancel: false });
    expect(await request(OAUTH)).toEqual({ cancel: false });
  });

  it("stops credential pages and Google's refusal even with a session, which may be stale", async () => {
    const { request } = startSession([{ name: "SID" }]);
    expect(await request(IDENTIFIER)).toEqual({ cancel: true });
    expect(await request("https://accounts.google.com/v3/signin/rejected")).toEqual({
      cancel: true,
    });
  });

  it("stops a frame's credential pages, and leaves a frame passing a session on to Google", async () => {
    const { request } = startSession([]);
    expect(await request(IDENTIFIER, "subFrame")).toEqual({ cancel: true });
    expect(await request("https://accounts.google.com/signin/rejected", "subFrame")).toEqual({
      cancel: true,
    });
    // A silent check by the site; without a session Google sends the frame to a credential page.
    expect(await request(`${OAUTH}&prompt=none`, "subFrame")).toEqual({});
  });

  it("never touches Google's session upkeep", async () => {
    const { request } = startSession([]);
    expect(await request("https://accounts.google.com/ListAccounts?gpsia=1")).toEqual({});
    expect(await request("https://accounts.google.com/CheckCookie")).toEqual({});
  });

  it("lets a passing page load when the cookie store can't be read", async () => {
    const { request } = startSession(new Error("store closed"));
    expect(await request("https://accounts.google.com/ServiceLogin")).toEqual({});
  });
});

describe("isBlockedGoogleSignIn", () => {
  it("tells this guard's stop from other failures", () => {
    expect(isBlockedGoogleSignIn(-20, IDENTIFIER)).toBe(true);
    expect(isBlockedGoogleSignIn(-105, IDENTIFIER)).toBe(false);
    expect(isBlockedGoogleSignIn(-20, "https://example.com/")).toBe(false);
  });
});
