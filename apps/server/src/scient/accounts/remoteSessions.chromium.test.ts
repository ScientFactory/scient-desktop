// @effect-diagnostics nodeBuiltinImport:off -- The test owns throwaway profile directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { chromium } from "playwright-core";
import { afterAll, expect, it } from "vite-plus/test";

import { openProfileCookieJar } from "./profileCookieJar.ts";
import { qualifyProfileCookies } from "./qualifyProfileCookies.ts";

const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-profile-cookies-"));
afterAll(() => NodeFSP.rm(root, { recursive: true, force: true }));

it("copies cookies exactly into a persistent profile's own context, and keeps them", async () => {
  const results = await qualifyProfileCookies({
    open: async (profileId) => {
      const context = await chromium.launchPersistentContext(NodePath.join(root, profileId), {
        headless: true,
      });
      for (const page of context.pages()) await page.close();
      const { jar, close } = await openProfileCookieJar(context);
      return {
        jar,
        release: async () => {
          await close();
          await context.close();
        },
      };
    },
    clear: (profileId) =>
      NodeFSP.rm(NodePath.join(root, profileId), { recursive: true, force: true }),
  });
  expect(results.filter((result) => !result.ok)).toEqual([]);
  expect(results.map((result) => result.name)).toEqual([
    "isolation",
    "host-only",
    "domain",
    "prefixes",
    "same-site",
    "expiry",
    "partitions",
    "read-back",
    "exact delete",
    "helper page",
    "persistence",
  ]);
  expect(await NodeFSP.readdir(root)).toEqual([]);
});

it("names the sites of the profile's open pages, never its own helper page", async () => {
  const context = await chromium.launchPersistentContext(NodePath.join(root, "tabs"), {
    headless: true,
  });
  try {
    const tab = context.pages()[0] ?? (await context.newPage());
    await tab.route("https://**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: "" }),
    );
    await tab.goto("https://www.github.com/login");
    const { jar, close } = await openProfileCookieJar(context);
    expect(jar.openTabSites()).toEqual(["github.com"]);
    await close();
    expect(context.pages()).toEqual([tab]);
  } finally {
    await context.close();
  }
});
