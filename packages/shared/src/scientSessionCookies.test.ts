import type { SessionCookie } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  decideUnit,
  jarUnits,
  sameUnit,
  sessionCookieFromCdp,
  sessionCookieFromImported,
  sessionCookieToCdpParam,
} from "./scientSessionCookies.ts";

/** Last two labels, enough for the synthetic hosts here. */
const siteOf = (host: string) => host.split(".").slice(-2).join(".");
const NOW = 1_000_000;

const cookie = (overrides: Partial<SessionCookie> = {}): SessionCookie => ({
  name: "session",
  value: "synthetic-a",
  domain: ".example.test",
  hostOnly: false,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  expires: NOW + 3600,
  ...overrides,
});
const cdp = {
  name: "session",
  value: "synthetic-a",
  domain: "app.example.test",
  path: "/",
  expires: -1,
  session: true,
  secure: false,
  httpOnly: false,
};

describe("conversions", () => {
  it("keeps a session cookie without expiry, a host-only domain and the stored ancestor bit", () => {
    expect(sessionCookieFromCdp(cdp)).toEqual({
      name: "session",
      value: "synthetic-a",
      domain: "app.example.test",
      hostOnly: true,
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "unspecified",
    });
    const partitioned = sessionCookieFromCdp({
      ...cdp,
      domain: ".example.test",
      session: false,
      expires: NOW,
      sameSite: "None",
      partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: true },
    });
    expect(partitioned).toMatchObject({
      hostOnly: false,
      expires: NOW,
      sameSite: "no_restriction",
      partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: true },
    });
  });

  it("refuses opaque and string partition keys", () => {
    expect(sessionCookieFromCdp({ ...cdp, partitionKeyOpaque: true })).toEqual({
      unsupported: "opaque-partition",
    });
    expect(sessionCookieFromCdp({ ...cdp, partitionKey: "https://top.test" })).toEqual({
      unsupported: "string-partition",
    });
  });

  it("writes prefixed and secure cookies from https, host-only ones without a domain", () => {
    const host = sessionCookieToCdpParam(
      cookie({ name: "__Host-x", domain: "app.example.test", hostOnly: true, secure: true }),
    );
    expect(host).toMatchObject({ url: "https://app.example.test/" });
    expect(host).not.toHaveProperty("domain");
    expect(
      sessionCookieToCdpParam(cookie({ name: "__Secure-y", secure: false, expires: undefined })),
    ).toEqual({
      name: "__Secure-y",
      value: "synthetic-a",
      url: "https://example.test/",
      domain: ".example.test",
      path: "/",
      secure: false,
      httpOnly: true,
      sameSite: "Lax",
    });
    expect(
      sessionCookieToCdpParam(cookie({ secure: false, sameSite: "unspecified" })),
    ).toMatchObject({ url: "http://example.test/", expires: NOW + 3600 });
  });

  it("takes an imported cookie's host from its URL when it is host-only", () => {
    expect(
      sessionCookieFromImported({
        url: "https://app.example.test/",
        name: "session",
        value: "synthetic-a",
        domain: undefined,
        path: "/",
        secure: true,
        httpOnly: true,
        expirationDate: undefined,
        sameSite: "strict",
      }),
    ).toEqual({
      name: "session",
      value: "synthetic-a",
      domain: "app.example.test",
      hostOnly: true,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
    });
  });
});

describe("sameUnit", () => {
  it("compares every attribute, the value and the expiry within a second", () => {
    expect(sameUnit([cookie()], [cookie({ expires: NOW + 3600.5 })])).toBe(true);
    for (const different of [
      { value: "synthetic-b" },
      { httpOnly: false },
      { sameSite: "strict" as const },
      { expires: undefined },
      { path: "/app" },
      { partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: false } },
    ])
      expect(sameUnit([cookie()], [cookie(different)])).toBe(false);
  });

  it("does not take a group of JavaScript-readable cookies for an empty one", () => {
    expect(sameUnit([cookie({ httpOnly: false })], [])).toBe(false);
  });
});

describe("decideUnit", () => {
  const decide = (input: Partial<Parameters<typeof decideUnit>[0]>) =>
    decideUnit({
      unit: ["example.test"],
      source: [cookie()],
      target: [],
      mode: "fill",
      replaceAllowed: false,
      nowSeconds: NOW,
      siteOf,
      ...input,
    });

  it("copies into an empty unit, counting expired cookies as empty", () => {
    expect(decide({})).toBe("copy");
    expect(decide({ target: [cookie({ value: "old", expires: NOW - 1 })] })).toBe("copy");
    expect(decide({ target: [cookie()] })).toBe("same");
    expect(decide({ source: [cookie({ domain: ".other.test" })] })).toBe("blocked");
  });

  it("leaves an occupied unit alone unless replace is allowed, and never replaces Google", () => {
    const occupied = { target: [cookie({ value: "synthetic-b" })] };
    expect(decide(occupied)).toBe("conflict");
    expect(decide({ ...occupied, mode: "fill-or-replace" })).toBe("conflict");
    expect(decide({ ...occupied, replaceAllowed: true })).toBe("conflict");
    expect(decide({ ...occupied, mode: "fill-or-replace", replaceAllowed: true })).toBe("copy");
    const google = (value: string) => cookie({ domain: ".google.com", value });
    expect(
      decide({
        unit: ["accounts.google.com"],
        source: [google("synthetic-a")],
        target: [google("synthetic-b")],
        mode: "fill-or-replace",
        replaceAllowed: true,
      }),
    ).toBe("conflict");
  });

  it("decides a multi-site sign-in as one unit", () => {
    const unit = ["https://idp.uni.test", "proxy.test"];
    const source = [
      cookie({ domain: "idp.uni.test", hostOnly: true }),
      cookie({ domain: ".proxy.test" }),
    ];
    // Main holds another identity's proxy session and no IdP session: nothing is copied.
    expect(decide({ unit, source, target: [cookie({ domain: ".proxy.test", value: "b" })] })).toBe(
      "conflict",
    );
    expect(jarUnits(source, siteOf, [unit])).toEqual([["uni.test", "proxy.test"]]);
    expect(jarUnits(source, siteOf)).toEqual([["uni.test"], ["proxy.test"]]);
  });
});
