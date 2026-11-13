import { describe, expect, it } from "vite-plus/test";

import { googleSignInPage, isGoogleOAuthPage, signInRestartUrl } from "./scientGoogleSignIn.ts";

describe("googleSignInPage", () => {
  it.each([
    ["https://accounts.google.com/", "transit"],
    ["https://accounts.google.com/ServiceLogin?continue=https://mail.google.com/", "transit"],
    ["https://accounts.google.com/AccountChooser", "transit"],
    ["https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=y", "transit"],
    ["https://accounts.google.com/o/oauth2/auth?client_id=x", "transit"],
    ["https://accounts.google.com/signin/oauth/id?authuser=0", "transit"],
    ["https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn", "credentials"],
    ["https://accounts.google.com/signin/v2/challenge/pk", "credentials"],
    ["https://accounts.google.com/v3/signin/challenge/pwd", "credentials"],
    ["https://ACCOUNTS.GOOGLE.COM./AddSession", "credentials"],
    ["https://accounts.google.com/v3/signin/rejected", "rejected"],
    ["https://accounts.google.com/signin/rejected?rrk=46", "rejected"],
  ])("recognizes %s", (url, page) => {
    expect(googleSignInPage(url)).toBe(page);
  });

  it.each([
    // Session upkeep and sign-out keep working, with or without a session.
    "https://accounts.google.com/ListAccounts?gpsia=1",
    "https://accounts.google.com/CheckCookie?continue=x",
    "https://accounts.google.com/RotateCookiesPage",
    "https://accounts.google.com/Logout",
    "https://accounts.google.com/o/oauth2/token",
    // Google's apps are not sign-in pages.
    "https://mail.google.com/mail/u/0/",
    "https://myaccount.google.com/",
    // Lookalikes, other schemes and boundaries.
    "https://accounts.google.com.evil.example/ServiceLogin",
    "https://evil.example/accounts.google.com/ServiceLogin",
    "http://accounts.google.com/ServiceLogin",
    "https://user:pass@accounts.google.com/ServiceLogin",
    "https://accounts.google.com:8443/ServiceLogin",
    "https://accounts.google.com/ServiceLoginAuth-not-a-route",
    "https://accounts.google.com/signinx",
    "not a url",
  ])("leaves %s alone", (url) => {
    expect(googleSignInPage(url)).toBeNull();
  });
});

describe("isGoogleOAuthPage", () => {
  it("tells another site's Continue with Google from Google's own sign-in", () => {
    expect(isGoogleOAuthPage("https://accounts.google.com/o/oauth2/v2/auth?client_id=x")).toBe(
      true,
    );
    expect(isGoogleOAuthPage("https://accounts.google.com/signin/oauth/id")).toBe(true);
    expect(isGoogleOAuthPage("https://accounts.google.com/ServiceLogin")).toBe(false);
    expect(isGoogleOAuthPage("https://evil.example/o/oauth2/v2/auth")).toBe(false);
  });
});

describe("signInRestartUrl", () => {
  it("keeps only a site's origin", () => {
    expect(signInRestartUrl("https://www.overleaf.com/login?state=abc#x")).toBe(
      "https://www.overleaf.com/",
    );
  });

  it("never restarts from Google's sign-in, an insecure page or a missing one", () => {
    expect(signInRestartUrl("https://accounts.google.com/o/oauth2/v2/auth?state=abc")).toBeNull();
    expect(signInRestartUrl("http://example.com/login")).toBeNull();
    expect(signInRestartUrl("about:blank")).toBeNull();
    expect(signInRestartUrl(null)).toBeNull();
  });
});
