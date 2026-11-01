import { describe, expect, it } from "vite-plus/test";

import { declaredIcons, iconHost } from "./siteIcons.ts";

describe("iconHost", () => {
  it.each([
    ["accounts.spotify.com", "accounts.spotify.com"],
    [" Example.COM ", "example.com"],
    ["localhost", null],
    ["127.0.0.1", null],
    ["printer.local", null],
    ["example.com:8080", null],
    ["https://example.com", null],
  ])("%s → %s", (site, expected) => {
    expect(iconHost(site)).toBe(expected);
  });
});

it("picks declared PNG or SVG icons first, then other icons, then touch icons", () => {
  const html = `<head>
    <link rel="apple-touch-icon" href="/touch.png">
    <link rel="shortcut icon" href="/old.ico">
    <link rel='icon' type='image/png' href='/logo.png?v=1&amp;x=2'>
    <link rel="stylesheet" href="/site.css">
    <link rel="icon" href="http://insecure.example/icon.png">
  </head>`;
  expect(declaredIcons(html, "https://ankiweb.net/start")).toEqual([
    "https://ankiweb.net/logo.png?v=1&x=2",
    "https://ankiweb.net/old.ico",
    "https://ankiweb.net/touch.png",
  ]);
});
