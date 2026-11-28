import { describe, expect, it } from "vite-plus/test";
import { isIdentityProvider, signInEvidence, signedInSite, siteCookies } from "./sessionDetection";

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
  // YouTube lives on its own domain and is still that one Google session.
  expect(
    signedInSite({
      ...input,
      url: "https://www.youtube.com/feed/subscriptions",
      before: [],
      after: [{ domain: ".youtube.com", httpOnly: true }],
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
    { previousUrl: "https://other.com" },
    { url: "https://accounts.google.com" },
    { after: input.before },
  ])
    expect(signedInSite({ ...input, ...patch })).toBeNull();
});

describe("an authenticated session, not a refusal's cookie (round 6c 10, round 6d)", () => {
  const site = "https://login.example.com/";
  const cookie = (name: string, digest: string, extra: object = {}) => ({
    domain: ".example.com",
    httpOnly: true,
    expires: 4_000_000_000,
    name,
    path: "/",
    digest,
    ...extra,
  });
  it("leaves a bot check's or a request guard's cookie unverified, never signed in or out", () => {
    const before = [cookie("pre_session", "aaaa")];
    for (const name of ["__cf_bm", "_abck", "incap_ses_123_456", "datadome", "XSRF-TOKEN"])
      expect(signInEvidence(before, [...before, cookie(name, "bbbb")], site)).toBe("unverified");
  });

  it("leaves a refusal's new state cookie unverified: no positive evidence", () => {
    // regression: a fieldless refusal that set an HttpOnly state cookie read as signed in.
    for (const name of ["oauth_state", "__Host-next-auth.state", "login_flow", "zx9"])
      expect(signInEvidence([], [cookie(name, "aaaa")], site)).toBe("unverified");
  });

  it("counts a session rotated in place, or a new cookie named as a session", () => {
    // A cookie of no telling name, rotated in place: a refusal may do that too (round 6f).
    expect(signInEvidence([cookie("site_data", "aaaa")], [cookie("site_data", "bbbb")], site)).toBe(
      "unverified",
    );
    // A session's, replaced at the sign-in, counts.
    expect(signInEvidence([cookie("session", "aaaa")], [cookie("session", "bbbb")], site)).toBe(
      "signed-in",
    );
    // A visitor's or a preference's, rotated, is no sign-in (round 6e).
    expect(signInEvidence([cookie("pref", "aaaa")], [cookie("pref", "bbbb")], site)).toBe(
      "unverified",
    );
    expect(signInEvidence([cookie("session", "aaaa")], [cookie("session", "aaaa")], site)).toBe(
      "none",
    );
    expect(signInEvidence([], [cookie("session", "aaaa")], site)).toBe("signed-in");
    expect(signInEvidence([], [cookie("auth_token", "aaaa")], site)).toBe("signed-in");
    // A page's own scripts can't set an HttpOnly cookie, nor is another site's evidence.
    expect(signInEvidence([], [cookie("session", "aaaa", { httpOnly: false })], site)).toBe("none");
    expect(signInEvidence([], [cookie("session", "aaaa", { domain: ".other.org" })], site)).toBe(
      "none",
    );
    // An older desktop gives no names: a new cookie there is unproven.
    expect(
      signInEvidence(
        [],
        [{ domain: ".example.com", httpOnly: true, expires: 4_000_000_000 }],
        site,
      ),
    ).toBe("unverified");
  });
});

it("never takes a visitor's new HttpOnly token for a sign-in (round 6e, row 10)", () => {
  const before = [{ domain: ".example.com", httpOnly: true, name: "theme", path: "/" }];
  const refusal = [
    ...before,
    { domain: ".example.com", httpOnly: true, name: "visitor_token", path: "/" },
  ];
  // regression: "token" in its name made a refusal's visitor cookie a sign-in.
  expect(signInEvidence(before, refusal, "example.com")).toBe("unverified");
  const generic = [...before, { domain: ".example.com", httpOnly: true, name: "token", path: "/" }];
  expect(signInEvidence(before, generic, "example.com")).toBe("unverified");
  // A session the site names as one still counts.
  const signedIn = [
    ...before,
    { domain: ".example.com", httpOnly: true, name: "auth_token", path: "/" },
  ];
  expect(signInEvidence(before, signedIn, "example.com")).toBe("signed-in");
});
