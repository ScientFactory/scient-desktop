// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- A real browser against a local page, timed as a person waits.
import * as NodeChildProcess from "node:child_process";
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

/**
 * One case's own page, profile and sign-in; cleanup runs even when the case times out. With
 * `stallFails`, a page that was probed as stalled keeps the case waiting until its timeout.
 */
async function openSignInTestWindow(
  browser: ChromiumBrowser,
  signal: AbortSignal,
  onTestFinished: (cleanup: () => Promise<void>) => void,
  stallFails = false,
) {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "chrome-sign-in-"));
  const signed = Promise.withResolvers<void>();
  const requested: string[] = [];
  const pageAsked = new EventTarget();
  const server = NodeHttp.createServer((request, response) => {
    requested.push(request.url ?? "");
    if (request.url === "/") pageAsked.dispatchEvent(new Event("page"));
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
  const stall: string[] = [];
  const aborted = () =>
    process.stderr.write(
      `Chrome window smoke aborted: ${browser.name}, page ready: ${pageReady}, requests: ${
        requested.join(", ") || "none"
      }${stall.length > 0 ? `\nStall: ${stall.join("; ")}` : ""}\n${describeBrowserWindows()}\n`,
    );
  signal.addEventListener("abort", aborted, { once: true });
  // The probe and any browser it starts end before the profile folder is removed.
  const stopProbe = new AbortController();
  let probing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      signal.removeEventListener("abort", aborted);
      stopProbe.abort();
      await firstLoad;
      await probing;
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
  // A window that never asks for its page: see what the dialog's advice, a reload, does.
  const firstLoad = pageWithin(
    pageAsked,
    STALL_AFTER_MS,
    () => requested.includes("/"),
    stopProbe.signal,
  ).then((asked) => {
    if (!asked && !stopProbe.signal.aborted && platform === "win32") {
      const stop = stopProbe.signal;
      probing = probeStall({ browser, folder, url, pageAsked, requested, notes: stall, stop });
    }
  });
  onTestFinished(close);
  try {
    await Promise.race([
      signed.promise,
      read.then((outcome) => {
        throw new Error(`Sign-in ended before the page was ready: ${outcome.outcome}`);
      }),
    ]);
    await firstLoad;
    if (probing) {
      await probing;
      // The first launch failed even if a reload saved it: the case times out under its row.
      if (stallFails) await new Promise<never>(() => undefined);
    }
    pageReady = true;
    return { folder, read, [Symbol.asyncDispose]: close };
  } catch (cause) {
    await close();
    throw cause;
  }
}

/** A first page request that takes this long is a stall; fresh CI machines take up to ~25 s. */
const STALL_AFTER_MS = 45_000;

/**
 * True once `asked()` holds, checked now and at each page request; false if `ms` pass first or
 * `stop` is aborted.
 */
const pageWithin = (pageAsked: EventTarget, ms: number, asked: () => boolean, stop: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (asked()) return resolve(true);
    if (stop.aborted) return resolve(false);
    const settle = (answer: boolean) => {
      clearTimeout(timer);
      pageAsked.removeEventListener("page", check);
      stop.removeEventListener("abort", stopped);
      resolve(answer);
    };
    const check = () => {
      if (asked()) settle(true);
    };
    const stopped = () => settle(false);
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- how long a real browser takes to ask for a page is the thing measured; no event marks "never"
    const timer = setTimeout(() => settle(false), ms);
    pageAsked.addEventListener("page", check);
    stop.addEventListener("abort", stopped, { once: true });
  });

/** Brings the window of the browser on `profile` to the front and presses F5 there. */
const RELOAD_SCRIPT = [
  "$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \"*$env:SCIENT_PROFILE*\" -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1",
  "if (-not $p) { 'no browser process'; exit }",
  "$w = (Get-Process -Id $p.ProcessId).MainWindowHandle",
  "if ($w -eq 0) { 'no window'; exit }",
  'Add-Type \'using System; using System.Runtime.InteropServices; public static class ScientWindow { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }\'',
  "[void][ScientWindow]::SetForegroundWindow($w); Start-Sleep -Milliseconds 300",
  "if ([ScientWindow]::GetForegroundWindow() -ne $w) { 'not in front'; exit }",
  "(New-Object -ComObject WScript.Shell).SendKeys('{F5}'); 'sent'",
].join("\n");

/** PowerShell's output, without blocking the test page's server while it runs. */
const powershell = (script: string, stop: AbortSignal, extra: Record<string, string> = {}) =>
  new Promise<string>((resolve) => {
    NodeChildProcess.execFile(
      "powershell",
      ["-NoProfile", "-Command", script],
      { encoding: "utf8", timeout: 15_000, signal: stop, env: { ...env, ...extra } },
      (error, stdout) => resolve(error ? `failed: ${error.message}` : stdout.trim()),
    );
  });

/**
 * Windows: a window still blank after STALL_AFTER_MS. Notes what a reload in it does, then what
 * opening the page again on the same profile does, for the failure to tell which recovers it.
 */
async function probeStall(input: {
  readonly browser: ChromiumBrowser;
  readonly folder: string;
  readonly url: string;
  readonly pageAsked: EventTarget;
  readonly requested: ReadonlyArray<string>;
  readonly notes: string[];
  /** Aborted when the case cleans up: the probe then ends, and any browser it started. */
  readonly stop: AbortSignal;
}) {
  const { browser, folder, url, pageAsked, requested, notes, stop } = input;
  const pages = () => requested.filter((path) => path === "/").length;
  notes.push(`no request for the page after ${STALL_AFTER_MS / 1000} s`);
  const processes = await powershell(
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'chrome|msedge|update' } | ForEach-Object { \"$($_.ProcessId)<-$($_.ParentProcessId) $($_.Name) $($_.CommandLine)\" }",
    stop,
  );
  process.stderr.write(`Browser processes at the stall:\n${processes}\n`);
  if (pages() > 0) {
    notes.push("the page was asked for while processes were listed");
    return;
  }
  if (stop.aborted) return;
  // The page can be asked for again before PowerShell has even returned.
  const beforeReload = pages();
  const reload = await powershell(RELOAD_SCRIPT, stop, { SCIENT_PROFILE: folder });
  if (reload !== "sent") notes.push(`reload not tried: ${reload}`);
  else if (await pageWithin(pageAsked, 20_000, () => pages() > beforeReload, stop)) {
    notes.push("a reload in the window brought the page");
    return;
  } else notes.push("a reload in the window brought nothing");
  if (stop.aborted) return;
  // A second launch on the profile hands the address to the browser already running on it.
  const beforeAgain = pages();
  const again = NodeChildProcess.spawn(browser.executable, [`--user-data-dir=${folder}`, url], {
    stdio: "ignore",
  });
  again.on("error", () => undefined);
  const exited = new Promise<boolean>((resolve) => {
    again.once("exit", () => resolve(true));
    again.once("error", () => resolve(true));
  });
  notes.push(
    (await pageWithin(pageAsked, 20_000, () => pages() > beforeAgain, stop))
      ? "opening the page again brought it"
      : "opening the page again brought nothing",
  );
  // It hands the address over and exits; one that stays would hold the profile folder.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = () => {};
  const handedOver = await Promise.race([
    exited,
    new Promise<false>((resolve) => {
      stopped = () => resolve(false);
      if (stop.aborted) resolve(false);
      else stop.addEventListener("abort", stopped, { once: true });
    }),
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a launcher that never exits has no event; this bounds the wait for it
    new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), 5_000))),
  ]).finally(() => {
    clearTimeout(timer);
    stop.removeEventListener("abort", stopped);
  });
  if (!handedOver && again.exitCode === null && again.signalCode === null) {
    notes.push("the second launch kept running, so it was stopped");
    again.kill("SIGKILL");
    await exited;
  }
}

/**
 * What a stalled window shows, for the next failure to explain itself: on Windows each browser
 * window's title, and a screenshot of the screen into `SCIENT_CHROME_WINDOW_CAPTURE` when set.
 */
let captures = 0;
/** Best effort: a diagnostic that fails says so instead of failing the case. */
function describeBrowserWindows() {
  if (platform !== "win32") return "";
  const capture = env.SCIENT_CHROME_WINDOW_CAPTURE;
  const script = [
    "Get-Process chrome, msedge -ErrorAction SilentlyContinue | Where-Object MainWindowTitle |",
    '  ForEach-Object { "$($_.Name) $($_.Id): $($_.MainWindowTitle)" }',
    ...(capture
      ? [
          "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
          "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen",
          "$i = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
          "[System.Drawing.Graphics]::FromImage($i).CopyFromScreen($b.Left, $b.Top, 0, 0, $i.Size)",
          "$i.Save($env:SCIENT_CAPTURE_FILE)",
        ]
      : []),
  ].join("\n");
  try {
    if (capture) NodeFS.mkdirSync(capture, { recursive: true });
    const result = NodeChildProcess.spawnSync("powershell", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 15_000,
      env: capture
        ? {
            ...env,
            SCIENT_CAPTURE_FILE: NodePath.join(capture, `browser-window-${++captures}.png`),
          }
        : env,
    });
    if (result.error) return `Browser windows unreadable: ${result.error.message}`;
    const windows = result.stdout?.trim() || "none with a title";
    return `Browser windows:\n${windows}\n${result.stderr?.trim() ?? ""}`.trimEnd();
  } catch (cause) {
    return `Browser windows unreadable: ${String(cause)}`;
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
        await using window = await openSignInTestWindow(browser, signal, onTestFinished, true);
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
