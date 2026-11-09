// @effect-diagnostics nodeBuiltinImport:off -- A real browser against a local page.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  canQuitWindow,
  endSignInWindow,
  installedChromiumBrowsers,
  signInInWindow,
} from "./chromeWindow.ts";

const platform = HostProcess.Platform.defaultValue();
const env = HostProcess.Environment.defaultValue();
const browsers = installedChromiumBrowsers({ platform, env, home: NodeOS.homedir() });
const oneOfEach = [...new Map(browsers.map((found) => [found.name, found])).values()];

/** Resolves once the page in the window has its sign-in cookies. */
let signedIn = () => {};
const server = NodeHttp.createServer((request, response) => {
  if (request.url === "/login")
    response.setHeader("Set-Cookie", [
      "sid=window-sign-in; Max-Age=3600; Path=/; HttpOnly",
      "seen=1; Max-Age=3600; Path=/",
    ]);
  if (request.url === "/signed-in") signedIn();
  if (request.url === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end(
      "<p>Signing in</p><script>fetch('/login').then(() => fetch('/signed-in'))</script>",
    );
  } else response.end("ok");
});
let url = "";
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
});

const openWindow = async (browser: (typeof browsers)[number]) => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "chrome-sign-in-"));
  const signed = new Promise<void>((resolve) => {
    signedIn = resolve;
  });
  const read = signInInWindow({ browser, folder, url, platform });
  await signed;
  return { folder, read };
};

// Opens visible browser windows: only CI's Windows job, or a person, asks for it. Linux has no
// Done, so the person closes the window there.
describe.runIf(env.SCIENT_CHROME_WINDOW_TEST === "1" && canQuitWindow(platform))(
  "a sign-in window of a real browser",
  () => {
    it("finds an installed Chromium browser, Edge always on Windows", () => {
      expect(browsers.length).toBeGreaterThan(0);
      if (platform === "win32") expect(browsers.map(({ name }) => name)).toContain("Edge");
    });

    it.each(oneOfEach)("brings $name's sign-in back, read by $name itself", async (browser) => {
      const { folder, read } = await openWindow(browser);
      expect(await endSignInWindow(true, platform)).toBe(true);
      const outcome = await read;
      expect(outcome.outcome).toBe("read");
      if (outcome.outcome !== "read") return;
      expect(outcome.units).toEqual([["127.0.0.1"]]);
      expect(outcome.cookies.map(({ name, value }) => `${name}=${value}`).toSorted()).toEqual([
        "seen=1",
        "sid=window-sign-in",
      ]);
      expect(NodeFS.existsSync(folder)).toBe(false);
    });

    it.each(oneOfEach)("reads nothing when $name's window is cancelled", async (browser) => {
      const { folder, read } = await openWindow(browser);
      expect(await endSignInWindow(false, platform)).toBe(true);
      expect(await read).toEqual({ outcome: "cancelled" });
      expect(NodeFS.existsSync(folder)).toBe(false);
    });
  },
);
