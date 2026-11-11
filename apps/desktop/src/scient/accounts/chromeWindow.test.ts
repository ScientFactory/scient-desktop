import type { SessionCookie } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { readArgs, signedInCookies, windowArgs } from "./chromeWindow.ts";

it("signs in in an ordinary window, and reads with the same storage", () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    const window = windowArgs("/scient/folder", "https://accounts.google.com/", platform);
    expect(window.filter((arg) => /debugging|automation|headless/.test(arg))).toEqual([]);
    expect(window).toContain("--user-data-dir=/scient/folder");
    const read = readArgs("/scient/folder", platform);
    expect(read).toContain("--remote-debugging-pipe");
    const storage = (args: ReadonlyArray<string>) =>
      args.filter((arg) => arg === "--use-mock-keychain" || arg.startsWith("--password-store"));
    expect(storage(read)).toEqual(storage(window));
  }
  expect(windowArgs("/f", "https://a.test/", "darwin")).toContain("--use-mock-keychain");
  expect(windowArgs("/f", "https://a.test/", "linux")).toContain("--password-store=basic");
});

it("takes only the sites the window signed in to", () => {
  const cookie = (domain: string, httpOnly: boolean, expires?: number): SessionCookie => ({
    name: "c",
    value: "v",
    domain,
    hostOnly: !domain.startsWith("."),
    path: "/",
    secure: true,
    httpOnly,
    sameSite: "lax",
    ...(expires === undefined ? {} : { expires }),
  });
  const jar = [
    cookie(".google.com", true, 2000),
    cookie("accounts.google.com", false, 2000),
    cookie(".consent.test", false, 2000),
    cookie(".gone.test", true, 500),
  ];
  const { units, cookies } = signedInCookies(jar, 1000);
  expect(units).toEqual([["google.com"]]);
  expect(cookies.map(({ domain }) => domain)).toEqual([".google.com", "accounts.google.com"]);
});
