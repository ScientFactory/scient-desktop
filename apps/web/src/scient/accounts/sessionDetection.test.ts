import { expect, it } from "vite-plus/test";
import { isIdentityProvider, signedInSite, siteCookies } from "./sessionDetection";

it("reads only live HttpOnly cookies of the site, without names or values", () => {
  expect(
    siteCookies(
      [
        { domain: "example.com", httpOnly: false },
        { domain: "evil-example.com", httpOnly: true },
        { domain: ".example.com", httpOnly: true, expires: 1 },
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

it("records the new session's own site after an identity provider, never the provider's own session", () => {
  const input = {
    previousUrl: "https://accounts.google.com/signin",
    url: "https://www.overleaf.com/project",
    incognito: false,
    hasAccount: false,
    before: [{ domain: ".google.com", httpOnly: true }],
    after: [
      { domain: ".google.com", httpOnly: true },
      { domain: "www.overleaf.com", httpOnly: true },
      { domain: ".overleaf.com", httpOnly: true },
    ],
    now: 0,
  };
  expect(signedInSite(input)).toBe("overleaf.com");
  // Google's sign-in, then Docs: the new cookie is Google's own session.
  expect(
    signedInSite({
      ...input,
      url: "https://docs.google.com/spreadsheets/d/1",
      before: [],
      after: [{ domain: ".google.com", httpOnly: true }],
    }),
  ).toBeNull();
  // Gmail's own cookie is still Google's session.
  expect(
    signedInSite({
      ...input,
      url: "https://mail.google.com/mail/u/0/",
      before: [],
      after: [{ domain: "mail.google.com", httpOnly: true }],
    }),
  ).toBeNull();
  // A university sign-in, then a service of the same university, is a session of its own.
  expect(
    signedInSite({
      ...input,
      previousUrl: "https://idp.huji.ac.il/idp/profile/SAML2",
      url: "https://moodle.huji.ac.il/my",
      before: [],
      after: [{ domain: "moodle.huji.ac.il", httpOnly: true }],
    }),
  ).toBe("moodle.huji.ac.il");
  for (const patch of [
    { incognito: true },
    { hasAccount: true },
    { previousUrl: "https://other.com" },
    { url: "https://accounts.google.com" },
    { after: input.before },
  ])
    expect(signedInSite({ ...input, ...patch })).toBeNull();
});
