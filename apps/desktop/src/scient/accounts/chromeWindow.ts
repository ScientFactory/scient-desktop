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
 * The folder is kept, one per Scient profile, so Google offers the account next time. Both launches
 * leave cookie encryption to the browser's own store (macOS Keychain, Windows DPAPI, Linux's
 * keyring), so no cookie stays on disk in plain text and the second reads what the first wrote.
 */
const profileArgs = (folder: string, _platform: NodeJS.Platform) => [
  `--user-data-dir=${folder}`,
  "--no-first-run",
  "--no-default-browser-check",
];

export const WINDOW_SIZE = { width: 520, height: 760 } as const;

/**
 * An ordinary browser window: no debugging and no automation while the person signs in. Placed
 * centred over Scient's window where it is given (not full screen).
 */
export const windowArgs = (
  folder: string,
  url: string,
  platform: NodeJS.Platform,
  position?: { readonly x: number; readonly y: number },
) => [
  ...profileArgs(folder, platform),
  `--window-size=${WINDOW_SIZE.width},${WINDOW_SIZE.height}`,
  ...(position ? [`--window-position=${Math.round(position.x)},${Math.round(position.y)}`] : []),
  "--new-window",
  url,
];

const ACTIVATE_BY_PID = (pid: number) =>
  `ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).activateWithOptions(3)`;

/**
 * macOS: the browser comes to the front, switching Spaces when Scient is full screen, which no
 * other app's window can cover. Windows and Linux raise a new window themselves.
 */
function activate(child: NodeChildProcess.ChildProcess, platform: NodeJS.Platform) {
  if (platform !== "darwin" || child.pid === undefined) return;
  NodeChildProcess.spawn("osascript", ["-l", "JavaScript", "-e", ACTIVATE_BY_PID(child.pid)], {
    stdio: "ignore",
  }).on("error", () => undefined);
}

/** The same profile again, unseen, answering the DevTools protocol on two pipes and no port. */
export const readArgs = (folder: string, platform: NodeJS.Platform) => [
  ...profileArgs(folder, platform),
  "--headless=new",
  "--remote-debugging-pipe",
  "about:blank",
];

/**
 * Whether the browser started, and when it has ended. Call it right after spawning: a failed start
 * emits `error` and never `exit`, and an unwatched `error` would throw.
 */
function lifecycle(child: NodeChildProcess.ChildProcess) {
  const started = new Promise<boolean>((resolve) => {
    child.once("spawn", () => resolve(true));
    child.once("error", () => resolve(false));
  });
  const ended = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  return { started, ended };
}

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
  // A browser that dies mid-read breaks the pipes; its end, not their errors, settles the read.
  input.on("error", () => undefined);
  output.on("error", () => undefined);
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
async function readProfile(
  browser: ChromiumBrowser,
  folder: string,
  platform: NodeJS.Platform,
  run: Run,
) {
  const child = NodeChildProcess.spawn(browser.executable, readArgs(folder, platform), {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  run.reader = child;
  const { started, ended } = lifecycle(child);
  try {
    if (!(await started)) return null;
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
    const jar = await within(Promise.race([read, ended.then(() => undefined)]), 30_000);
    await within(send("Browser.close"), 5_000);
    return jar ?? null;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await ended;
  }
}

/** The cookies of each site the window holds a sign-in for; whatever else it gathered stays out. */
export function signedInCookies(jar: ReadonlyArray<SessionCookie>, nowSeconds: number) {
  const units = jarUnits(jar).filter((unit) =>
    unitCookies(unit, jar).some((cookie) => holdsSignIn(cookie, nowSeconds)),
  );
  return { units, cookies: units.flatMap((unit) => unitCookies(unit, jar)) };
}

/** True once the folder is gone; a folder that can't be removed is never signed in to again. */
const removeFolder = (folder: string) =>
  NodeFS.promises
    .rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    .then(
      () => true,
      () => false,
    );

export type ChromeWindowOutcome =
  | { readonly outcome: "busy" | "failed" }
  | { readonly outcome: "cancelled" }
  | {
      readonly outcome: "read";
      readonly units: ReadonlyArray<ReadonlyArray<string>>;
      readonly cookies: ReadonlyArray<SessionCookie>;
    };

interface Run {
  folder: string;
  window?: NodeChildProcess.ChildProcess;
  reader?: NodeChildProcess.ChildProcess;
  keep: boolean;
  ended: boolean;
  quitRequested: boolean;
}

/** Folders being forgotten: no window opens on one until that ends. */
const forgetting = new Set<string>();
/** The one sign-in in progress, held from the first step until its folder is removed. */
let running: Run | undefined;

/**
 * Opens `url` in the browser's own small window on a profile folder Scient owns, waits until the
 * person is done, then reads what they signed in to. The folder is gone afterwards.
 */
export async function signInInWindow(input: {
  readonly browser: ChromiumBrowser;
  /** The Scient profile's own folder: kept, so the browser remembers its sign-ins there. */
  readonly folder: string;
  readonly url: string;
  readonly platform: NodeJS.Platform;
  readonly position?: { readonly x: number; readonly y: number } | undefined;
  /** False without a protected store: the folder goes once read, so no cookie stays on disk. */
  readonly remember?: boolean;
}): Promise<ChromeWindowOutcome> {
  // Busy while its folder is being forgotten: the window never opens on a folder going away.
  if (running || forgetting.has(input.folder)) return { outcome: "busy" };
  const run: Run = { folder: input.folder, keep: true, ended: false, quitRequested: false };
  running = run;
  const { browser, folder, url, platform } = input;
  try {
    await NodeFS.promises.mkdir(folder, { recursive: true, mode: 0o700 });
    // Cancel may come before the window opens.
    if (!run.keep) return { outcome: "cancelled" };
    const window = NodeChildProcess.spawn(
      browser.executable,
      windowArgs(folder, url, platform, input.position),
      { stdio: "ignore" },
    );
    run.window = window;
    const { started, ended } = lifecycle(window);
    if (!(await started)) return { outcome: "failed" };
    activate(window, platform);
    // Round 6m: it finishes only with Done, or the person closing it (Linux).
    await ended;
    if (!run.keep) return { outcome: "cancelled" };
    const jar = await readProfile(browser, folder, platform, run);
    // Cancel may come while the profile is read; after this, the result stands.
    if (!run.keep) return { outcome: "cancelled" };
    run.ended = true;
    if (!jar) return { outcome: "failed" };
    return { outcome: "read", ...signedInCookies(jar.cookies, Date.now() / 1000) };
  } catch {
    return { outcome: "failed" };
  } finally {
    if (input.remember === false) await removeFolder(folder);
    running = undefined;
  }
}

/** When the browser last wrote its sign-ins there: the folder's own time or its Local State's. */
const lastUsed = async (folder: string) =>
  Math.max(
    ...(await Promise.all(
      [folder, `${folder}/Local State`].map((path) =>
        NodeFS.promises.stat(path).then(
          (stat) => stat.mtimeMs,
          () => 0,
        ),
      ),
    )),
  );

/**
 * Forget the sign-in window: its folder and every sign-in the browser kept there go. Not while
 * its window is open (false: try again later), and with `since`, not if it was signed in to after.
 */
export async function forgetSignInWindow(folder: string, since?: string) {
  if (running?.folder === folder || forgetting.has(folder)) return false;
  // Marked at once, before any await: a sign-in starting meanwhile waits as busy (round 6d).
  forgetting.add(folder);
  try {
    if (since !== undefined && (await lastUsed(folder)) > Date.parse(since)) return true;
    return await removeFolder(folder);
  } finally {
    forgetting.delete(folder);
  }
}

/**
 * Done (`keep`): the browser quits as if the person quit it, where Scient can do that. Cancel: it
 * is stopped and nothing is read. False when no sign-in is active.
 */
export function endSignInWindow(keep: boolean, platform: NodeJS.Platform) {
  const run = running;
  if (!run || run.ended || (keep && (run.quitRequested || !canQuitWindow(platform)))) return false;
  run.keep = keep;
  if (keep) {
    run.quitRequested = true;
    if (run.window) quit(run.window, platform);
  } else {
    run.ended = true;
    run.window?.kill("SIGKILL");
    run.reader?.kill("SIGKILL");
  }
  return true;
}
