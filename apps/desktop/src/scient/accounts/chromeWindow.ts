// @effect-diagnostics globalTimers:off globalDate:off -- A browser process outlives any one Effect.
// @effect-diagnostics nodeBuiltinImport:off -- It owns a browser process with two extra pipes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { SessionCookie } from "@t3tools/contracts";
import {
  holdsSignIn,
  jarUnits,
  readJar,
  unitCookies,
  type CdpSend,
} from "@t3tools/shared/scientSessionCookies";

export interface ChromiumBrowser {
  readonly name: string;
  readonly executable: string;
}

interface Locations {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}

/** Where each Chromium browser installs itself, first choice first. Linux skips Snap's wrappers. */
function chromiumCandidates({ platform, env, home }: Locations): ChromiumBrowser[] {
  if (platform === "darwin")
    return [
      ["Chrome", "Google Chrome.app/Contents/MacOS/Google Chrome"],
      ["Edge", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      ["Brave", "Brave Browser.app/Contents/MacOS/Brave Browser"],
      ["Chromium", "Chromium.app/Contents/MacOS/Chromium"],
    ].flatMap(([name, app]) =>
      ["/Applications", NodePath.posix.join(home, "Applications")].map((root) => ({
        name: name!,
        executable: NodePath.posix.join(root, app!),
      })),
    );
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
      (root): root is string => !!root,
    );
    return [
      ["Chrome", "Google\\Chrome\\Application\\chrome.exe"],
      ["Edge", "Microsoft\\Edge\\Application\\msedge.exe"],
      ["Brave", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
      ["Chromium", "Chromium\\Application\\chrome.exe"],
    ].flatMap(([name, exe]) =>
      roots.map((root) => ({ name: name!, executable: NodePath.win32.join(root, exe!) })),
    );
  }
  return [
    { name: "Chrome", executable: "/opt/google/chrome/chrome" },
    { name: "Edge", executable: "/opt/microsoft/msedge/msedge" },
    { name: "Brave", executable: "/opt/brave.com/brave/brave" },
    { name: "Chromium", executable: "/usr/lib/chromium/chromium" },
    { name: "Chromium", executable: "/usr/lib64/chromium-browser/chromium-browser" },
  ];
}

/** Every Chromium browser installed here, first choice first. */
export const installedChromiumBrowsers = (locations: Locations) =>
  chromiumCandidates(locations).filter(({ executable }) => {
    try {
      NodeFS.accessSync(executable, NodeFS.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

/**
 * Both launches store cookies the same way, so the second reads what the first wrote. On macOS
 * the user's own Keychain item is never asked for, and on Linux no keyring is.
 */
const storageSwitch = (platform: NodeJS.Platform) =>
  platform === "darwin"
    ? ["--use-mock-keychain"]
    : platform === "linux"
      ? ["--password-store=basic"]
      : [];

const profileArgs = (folder: string, platform: NodeJS.Platform) => [
  `--user-data-dir=${folder}`,
  "--no-first-run",
  "--no-default-browser-check",
  ...storageSwitch(platform),
];

/** An ordinary browser window: no debugging and no automation while the person signs in. */
export const windowArgs = (folder: string, url: string, platform: NodeJS.Platform) => [
  ...profileArgs(folder, platform),
  "--window-size=520,760",
  "--new-window",
  url,
];

/** The same profile again, unseen, answering the DevTools protocol on two pipes and no port. */
export const readArgs = (folder: string, platform: NodeJS.Platform) => [
  ...profileArgs(folder, platform),
  "--headless=new",
  "--remote-debugging-pipe",
  "about:blank",
];

const exited = (child: NodeChildProcess.ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });

/** The promise's value, or undefined if it fails or takes longer than `ms`. */
const within = <A>(promise: Promise<A>, ms: number) => {
  let timeUp = () => {};
  const timer = setTimeout(() => timeUp(), ms);
  return Promise.race([
    promise.catch(() => undefined),
    new Promise<undefined>((resolve) => {
      timeUp = () => resolve(undefined);
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * Where Scient can quit the browser the way the person would, so it saves its cookies first. A
 * signal doesn't do: Chrome then ends as at logout, without writing cookies of the last ~30 s.
 */
export const canQuitWindow = (platform: NodeJS.Platform) =>
  platform === "darwin" || platform === "win32";

const QUIT_BY_PID = (pid: number) =>
  `ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).terminate`;

/** macOS: the Quit that Cmd+Q and the Dock send, to this process only. Windows: close its windows. */
function quit(child: NodeChildProcess.ChildProcess, platform: NodeJS.Platform) {
  if (child.pid === undefined) return;
  const [command, args] =
    platform === "darwin"
      ? ["osascript", ["-l", "JavaScript", "-e", QUIT_BY_PID(child.pid)]]
      : // Without /F, taskkill asks the process's windows to close.
        ["taskkill", ["/PID", String(child.pid)]];
  NodeChildProcess.spawn(command, args, { stdio: "ignore", windowsHide: true }).on(
    "error",
    () => undefined,
  );
}

const parseMessage = (text: string) => {
  try {
    return JSON.parse(text) as { id?: number; result?: unknown; error?: unknown };
  } catch {
    return undefined;
  }
};

/** The DevTools protocol over `--remote-debugging-pipe`: fd 3 in, fd 4 out, NUL-separated JSON. */
function pipeConnection(child: NodeChildProcess.ChildProcess) {
  const input = child.stdio[3] as NodeJS.WritableStream;
  const output = child.stdio[4] as NodeJS.ReadableStream;
  const waiting = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  let buffered = "";
  let next = 0;
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (let end = buffered.indexOf("\0"); end !== -1; end = buffered.indexOf("\0")) {
      const message = parseMessage(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      if (message?.id === undefined) continue;
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  return (method: string, params: object = {}, sessionId?: string) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++next;
      waiting.set(id, (message) =>
        message.error === undefined
          ? resolve(message.result)
          : reject(new Error(`${method} failed`)),
      );
      input.write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      );
    });
}

/** The profile's cookies, decrypted by the browser itself from a second, headless start. */
async function readProfile(browser: ChromiumBrowser, folder: string, platform: NodeJS.Platform) {
  const child = NodeChildProcess.spawn(browser.executable, readArgs(folder, platform), {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    const send = pipeConnection(child);
    const read = (async () => {
      const { targetInfos } = (await send("Target.getTargets")) as {
        targetInfos: ReadonlyArray<{ targetId: string; type: string }>;
      };
      const page =
        targetInfos.find((target) => target.type === "page")?.targetId ??
        ((await send("Target.createTarget", { url: "about:blank" })) as { targetId: string })
          .targetId;
      const { sessionId } = (await send("Target.attachToTarget", {
        targetId: page,
        flatten: true,
      })) as { sessionId: string };
      // Network commands act on the page's own context: the profile's jar.
      const onPage: CdpSend = (method, params) => send(method, params, sessionId);
      return readJar(onPage);
    })();
    const jar = await within(Promise.race([read, exited(child).then(() => undefined)]), 30_000);
    await within(send("Browser.close"), 5_000);
    return jar ?? null;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited(child);
  }
}

/** The cookies of each site the window holds a sign-in for; whatever else it gathered stays out. */
export function signedInCookies(jar: ReadonlyArray<SessionCookie>, nowSeconds: number) {
  const units = jarUnits(jar).filter((unit) =>
    unitCookies(unit, jar).some((cookie) => holdsSignIn(cookie, nowSeconds)),
  );
  return { units, cookies: units.flatMap((unit) => unitCookies(unit, jar)) };
}

const removeFolder = (folder: string) =>
  NodeFS.promises
    .rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    .catch(() => undefined);

export type ChromeWindowOutcome =
  | { readonly outcome: "busy" | "failed" }
  | { readonly outcome: "cancelled" }
  | {
      readonly outcome: "read";
      readonly units: ReadonlyArray<ReadonlyArray<string>>;
      readonly cookies: ReadonlyArray<SessionCookie>;
    };

let running:
  | { readonly child: NodeChildProcess.ChildProcess; keep: boolean; ended: boolean }
  | undefined;

/**
 * Opens `url` in the browser's own small window on a profile folder Scient owns, waits until the
 * person is done, then reads what they signed in to. The folder is gone afterwards.
 */
export async function signInInWindow(input: {
  readonly browser: ChromiumBrowser;
  readonly folder: string;
  readonly url: string;
  readonly platform: NodeJS.Platform;
}): Promise<ChromeWindowOutcome> {
  if (running) return { outcome: "busy" };
  const { browser, folder, url, platform } = input;
  await removeFolder(folder);
  try {
    await NodeFS.promises.mkdir(folder, { recursive: true, mode: 0o700 });
    const child = NodeChildProcess.spawn(browser.executable, windowArgs(folder, url, platform), {
      stdio: "ignore",
    });
    const run = { child, keep: true, ended: false };
    running = run;
    const started = await new Promise<boolean>((resolve) => {
      child.once("spawn", () => resolve(true));
      child.once("error", () => resolve(false));
    });
    if (!started) return { outcome: "failed" };
    await exited(child);
    if (!run.keep) return { outcome: "cancelled" };
    const jar = await readProfile(browser, folder, platform);
    if (!jar) return { outcome: "failed" };
    return { outcome: "read", ...signedInCookies(jar.cookies, Date.now() / 1000) };
  } finally {
    running = undefined;
    await removeFolder(folder);
  }
}

/**
 * Done (`keep`): the browser quits as if the person quit it, where Scient can do that. Cancel: it
 * is stopped and nothing is read. False when no window is open.
 */
export function endSignInWindow(keep: boolean, platform: NodeJS.Platform) {
  const run = running;
  if (!run || run.ended || (keep && !canQuitWindow(platform))) return false;
  run.ended = true;
  run.keep = keep;
  if (keep) quit(run.child, platform);
  else run.child.kill("SIGKILL");
  return true;
}
