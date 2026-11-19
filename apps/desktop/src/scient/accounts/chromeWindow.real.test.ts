// @effect-diagnostics nodeBuiltinImport:off -- A real browser against a local page.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";

import {
  canQuitWindow,
  endSignInWindow,
  installedChromiumBrowsers,
  signInInWindow,
  type ChromiumBrowser,
} from "./chromeWindow.ts";

const platform = HostProcess.Platform.defaultValue();
const env = HostProcess.Environment.defaultValue();
const browsers = installedChromiumBrowsers({ platform, env, home: NodeOS.homedir() });
const oneOfEach = [...new Map(browsers.map((found) => [found.name, found])).values()];

/** One case's own page, profile and sign-in; cleanup runs even when the case times out. */
async function openSignInTestWindow(
  browser: ChromiumBrowser,
  signal: AbortSignal,
  onTestFinished: (cleanup: () => Promise<void>) => void,
) {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "chrome-sign-in-"));
  const signed = Promise.withResolvers<void>();
  const server = NodeHttp.createServer((request, response) => {
    if (request.url === "/login")
      response.setHeader("Set-Cookie", [
        "sid=window-sign-in; Max-Age=3600; Path=/; HttpOnly",
        "seen=1; Max-Age=3600; Path=/",
      ]);
    if (request.url === "/signed-in") signed.resolve();
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<p>Signing in</p><script>fetch('/login').then(() => fetch('/signed-in'))</script>",
      );
    } else response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const read = signInInWindow({ browser, folder, url, platform });
  let pageReady = false;
  const aborted = () =>
    process.stderr.write(
      `Chrome window smoke aborted: ${browser.name}, page ready: ${pageReady}\n`,
    );
  signal.addEventListener("abort", aborted, { once: true });
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      signal.removeEventListener("abort", aborted);
      // Cancel is accepted until the result stands, so a timed-out case ends its own sign-in.
      endSignInWindow(false, platform);
      await read;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      NodeFS.rmSync(folder, { recursive: true, force: true });
    })();
    return closing;
  };
  onTestFinished(close);
  try {
    await Promise.race([
      signed.promise,
      read.then((outcome) => {
        throw new Error(`Sign-in ended before the page was ready: ${outcome.outcome}`);
      }),
    ]);
    pageReady = true;
    return { folder, read, [Symbol.asyncDispose]: close };
  } catch (cause) {
    await close();
    throw cause;
  }
}

// Opens visible browser windows: only CI's Windows job, or a person, asks for it. Linux has no
// Done, so the person closes the window there.
describe.runIf(env.SCIENT_CHROME_WINDOW_TEST === "1" && canQuitWindow(platform))(
  "a sign-in window of a real browser",
  () => {
    it("finds an installed Chromium browser, Edge always on Windows", () => {
      expect(browsers.length).toBeGreaterThan(0);
      if (platform === "win32") expect(browsers.map(({ name }) => name)).toContain("Edge");
    });

    it.for(oneOfEach)(
      "brings $name's sign-in back, read by $name itself",
      async (browser, { signal, onTestFinished }) => {
        await using window = await openSignInTestWindow(browser, signal, onTestFinished);
        const { folder, read } = window;
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
      },
    );

    it.for(oneOfEach)(
      "reads nothing when $name's window is cancelled",
      async (browser, { signal, onTestFinished }) => {
        await using window = await openSignInTestWindow(browser, signal, onTestFinished);
        const { folder, read } = window;
        expect(await endSignInWindow(false, platform)).toBe(true);
        expect(await read).toEqual({ outcome: "cancelled" });
        expect(NodeFS.existsSync(folder)).toBe(false);
      },
    );
  },
);
