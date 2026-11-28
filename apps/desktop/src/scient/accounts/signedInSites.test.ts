import { expect, it } from "vite-plus/test";
import { groupSignedInSites, siteCookieRemovals } from "./signedInSites.ts";

it("groups subdomains using public and private suffixes and returns only domain counts", () => {
  expect(
    groupSignedInSites([
      { domain: ".mail.huji.ac.il" },
      { domain: "HUJI.AC.IL" },
      { domain: "a.user.github.io" },
      { domain: "user.github.io" },
      { domain: "other.github.io" },
      { domain: "localhost" },
      { domain: "127.0.0.1" },
      { domain: "" },
      { domain: "https://bad.test" },
    ]),
  ).toEqual([
    { domain: "huji.ac.il", cookies: 2 },
    { domain: "user.github.io", cookies: 2 },
    { domain: "127.0.0.1", cookies: 1 },
    { domain: "localhost", cookies: 1 },
    { domain: "other.github.io", cookies: 1 },
  ]);
});

it("signs out of exactly one site, including its subdomains", () => {
  expect(
    siteCookieRemovals(
      [
        { domain: ".huji.ac.il", path: "/", name: "sso", secure: true },
        { domain: "moodle.huji.ac.il", path: "/my", name: "session", secure: true },
        { domain: "huji.ac.il.evil.test", path: "/", name: "lookalike", secure: true },
        { domain: "example.com", name: "other" },
      ],
      "huji.ac.il",
    ),
  ).toEqual([
    { url: "https://huji.ac.il/", name: "sso" },
    { url: "https://moodle.huji.ac.il/my", name: "session" },
  ]);
});

it("signs a vendor's host out alone, never its siblings or their shared parent", () => {
  expect(
    siteCookieRemovals(
      [
        { domain: "proxy.library-vendor.com", path: "/", name: "ezproxy", secure: true },
        { domain: ".cdn.proxy.library-vendor.com", path: "/", name: "edge", secure: true },
        { domain: "portal.library-vendor.com", path: "/", name: "other", secure: true },
        { domain: ".library-vendor.com", path: "/", name: "shared", secure: true },
      ],
      "proxy.library-vendor.com",
    ),
  ).toEqual([
    { url: "https://proxy.library-vendor.com/", name: "ezproxy" },
    { url: "https://cdn.proxy.library-vendor.com/", name: "edge" },
  ]);
});
