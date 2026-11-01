import { describe, expect, it } from "vite-plus/test";
import { classifyProfilePage, isAutomaticSignInPage } from "./profileClassification.ts";
import type { ProfileDetection } from "./profileDetection.ts";

const url = "https://docs.example.com/sheet";
const page: ProfileDetection = {
  finalUrl: url,
  title: "Sheet",
  passwordField: false,
  deniedText: false,
};

describe("browser profile page classification", () => {
  it.each([
    { name: "requested host", page, result: "opens" },
    {
      name: "requested subdomain",
      page: { ...page, finalUrl: "https://view.docs.example.com/sheet" },
      result: "opens",
    },
    {
      name: "Google sign-in redirect",
      page: { ...page, finalUrl: "https://accounts.google.com/ServiceLogin" },
      result: "sign-in",
    },
    {
      name: "Microsoft sign-in redirect",
      page: { ...page, finalUrl: "https://login.microsoftonline.com/tenant" },
      result: "sign-in",
    },
    {
      name: "other host sign-in path",
      page: { ...page, finalUrl: "https://identity.example.com/sso/start" },
      result: "sign-in",
    },
    {
      name: "login page on the same site, before any password field",
      page: { ...page, finalUrl: "https://docs.example.com/login?next=/sheet" },
      result: "sign-in",
    },
    {
      name: "sign-in subdomain",
      page: { ...page, finalUrl: "https://sso.docs.example.com/start" },
      result: "sign-in",
    },
    {
      name: "a login address the agent asked for is not a wall",
      requested: "https://docs.example.com/login",
      page: { ...page, finalUrl: "https://docs.example.com/login" },
      result: "opens",
    },
    {
      name: "signing out on purpose is not a wall",
      requested: "https://docs.example.com/logout",
      page: { ...page, finalUrl: "https://docs.example.com/login", passwordField: true },
      result: "opens",
    },
    { name: "visible password field", page: { ...page, passwordField: true }, result: "sign-in" },
    {
      name: "denial text takes priority over a login form",
      page: { ...page, passwordField: true, deniedText: true },
      result: "denied",
    },
    { name: "failed inspection", page: undefined, result: "error" },
    { name: "invalid requested URL", requested: "invalid", page, result: "error" },
    { name: "invalid final URL", page: { ...page, finalUrl: "invalid" }, result: "error" },
    {
      name: "insecure final URL",
      page: { ...page, finalUrl: "http://docs.example.com/sheet" },
      result: "error",
    },
    {
      name: "final URL with credentials",
      page: { ...page, finalUrl: "https://synthetic@docs.example.com/sheet" },
      result: "error",
    },
    {
      name: "lookalike host is not a subdomain",
      page: { ...page, finalUrl: "https://docs.example.com.attacker.test/sheet" },
      result: "error",
    },
  ])("$name", ({ requested, page, result }) => {
    expect(classifyProfilePage(requested ?? url, page)).toBe(result);
  });
});

describe("pages Scient may sign in on by itself", () => {
  const passwordPage = { ...page, passwordField: true };
  it.each([
    { name: "a page made for signing in", finalUrl: "https://docs.example.com/login", yes: true },
    { name: "a redirect to a password form", finalUrl: "https://docs.example.com/auth", yes: true },
    { name: "another site's form", finalUrl: "https://idp.example.org/enter", yes: true },
    { name: "the page the agent opened", finalUrl: url, yes: false },
    { name: "the same page with a trailing slash", finalUrl: `${url}/`, yes: false },
  ])("$name", ({ finalUrl, yes }) => {
    expect(isAutomaticSignInPage(url, { ...passwordPage, finalUrl })).toBe(yes);
  });

  it("never submits a password for someone already signed in", () => {
    const closeAccount = "https://docs.example.com/settings/close-account";
    expect(isAutomaticSignInPage(closeAccount, { ...passwordPage, finalUrl: closeAccount })).toBe(
      false,
    );
    expect(
      isAutomaticSignInPage(url, {
        ...passwordPage,
        finalUrl: "https://docs.example.com/login",
        signOutLink: true,
      }),
    ).toBe(false);
  });
});
