import { expect, it } from "vite-plus/test";
import {
  hasNewSiteCookie,
  isIdentityProvider,
  shouldOfferSession,
  siteCookies,
} from "./sessionDetection";

it("compares live HttpOnly domain/expiry multisets without cookie names or values", () => {
  const cookie = { domain: ".example.com", httpOnly: true };
  expect(hasNewSiteCookie([], [cookie], "https://www.example.com")).toBe(true);
  expect(hasNewSiteCookie([cookie], [cookie], "example.com")).toBe(false);
  expect(hasNewSiteCookie([cookie], [cookie, cookie], "example.com")).toBe(true);
  expect(hasNewSiteCookie([cookie], [{ ...cookie, expires: 500 }], "example.com", 1000)).toBe(true);
  expect(
    siteCookies(
      [
        { domain: "example.com", httpOnly: false },
        { domain: "evil-example.com", httpOnly: true },
        { ...cookie, expires: 1 },
      ],
      "example.com",
      2000,
    ),
  ).toEqual([]);
});

it("recognizes only known HTTPS IdPs and the designated host paths", () => {
  for (const url of [
    "https://accounts.google.com",
    "https://login.microsoftonline.com",
    "https://appleid.apple.com",
    "https://github.com/login/oauth",
    "https://orcid.org/signin",
    "https://tenant.okta.com",
    "https://university.example/idp/login",
    "https://university.example/shibboleth/login",
    "https://university.example/Shibboleth.sso/Login",
  ])
    expect(isIdentityProvider(url)).toBe(true);
  for (const url of [
    "https://accounts.google.com.evil.org",
    "https://github.com/project",
    "https://evilokta.com",
    "http://accounts.google.com",
    "invalid",
  ])
    expect(isIdentityProvider(url)).toBe(false);
});

it("offers only a new site session after an IdP return, excluding existing, offered and incognito accounts", () => {
  const input = {
    previousUrl: "https://accounts.google.com",
    url: "https://example.com/home",
    incognito: false,
    hasAccount: false,
    offered: false,
    before: [],
    after: [{ domain: "example.com", httpOnly: true }],
  };
  expect(shouldOfferSession(input)).toBe(true);
  for (const patch of [
    { incognito: true },
    { hasAccount: true },
    { offered: true },
    { previousUrl: "https://other.com" },
    { url: "https://accounts.google.com" },
    { after: [] },
  ])
    expect(shouldOfferSession({ ...input, ...patch })).toBe(false);
});
