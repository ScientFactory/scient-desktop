import { describe, expect, it } from "@effect/vitest";

import {
  inSignOutTarget,
  reachesFromParent,
  siteHost,
  siteOf,
  sitesNest,
  siteUnder,
} from "./scientSiteMatch.ts";

describe("site grouping", () => {
  it("names a host's registrable site, private suffixes included", () => {
    expect(siteOf(".idp.cc.huji.ac.il")).toBe("huji.ac.il");
    expect(siteOf("WWW.GitHub.com")).toBe("github.com");
    expect(siteOf("person.github.io")).toBe("person.github.io");
    expect(siteOf("localhost")).toBe("localhost");
  });

  it("reads a bare site or an https origin as a host", () => {
    expect(siteHost("https://idp.example.ac.il")).toBe("idp.example.ac.il");
    expect(siteHost(".Example.com")).toBe("example.com");
  });

  it("nests a site under its own host only, in either direction for lists", () => {
    expect(siteUnder("https://idp.example.ac.il", "example.ac.il")).toBe(true);
    expect(siteUnder("example.ac.il", "idp.example.ac.il")).toBe(false);
    expect(siteUnder("notexample.ac.il", "example.ac.il")).toBe(false);
    expect(sitesNest(["example.ac.il"], ["https://idp.example.ac.il"])).toBe(true);
    // One registrable site, but neither host lies under the other.
    expect(sitesNest(["mail.google.com"], ["docs.google.com"])).toBe(false);
  });
});

describe("a host's Sign out", () => {
  it("takes only the host's own cookies, and knows a shared parent one still reaches it", () => {
    const host = "proxy.library-vendor.com";
    expect(inSignOutTarget("proxy.library-vendor.com", host)).toBe(true);
    expect(inSignOutTarget(".edge.proxy.library-vendor.com", host)).toBe(true);
    expect(inSignOutTarget("portal.library-vendor.com", host)).toBe(false);
    expect(inSignOutTarget(".library-vendor.com", host)).toBe(false);
    expect(reachesFromParent({ domain: ".library-vendor.com", httpOnly: true }, host)).toBe(true);
    expect(reachesFromParent({ domain: "portal.library-vendor.com", httpOnly: true }, host)).toBe(
      false,
    );
    // A whole site's Sign out takes every cookie of the site, so nothing reaches it from above.
    expect(inSignOutTarget(".moodle.huji.ac.il", "huji.ac.il")).toBe(true);
    expect(reachesFromParent({ domain: ".ac.il", httpOnly: true }, "huji.ac.il")).toBe(false);
  });
});
