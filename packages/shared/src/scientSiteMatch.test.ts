import { describe, expect, it } from "@effect/vitest";

import { siteHost, siteOf, sitesNest, siteUnder } from "./scientSiteMatch.ts";

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
