// @effect-diagnostics globalTimers:off globalDate:off -- It waits on another app's browser and on its person.
// @effect-diagnostics nodeBuiltinImport:off -- It reads that browser's files, starts it and talks to it.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import type { SessionCookie } from "@t3tools/contracts";
import { readJar } from "@t3tools/shared/scientSessionCookies";

/*
 * Cookies a browser hands over itself once the person allowed remote debugging, which Windows'
 * app-bound encryption keeps from every other reader. Each profile is read through a tab opened in
 * it, since the connection reaches only the last used profile. docs/internals/scient-accounts.md.
 */

export type BrowserConnectionFailure =
  | "connectionOff"
  | "connectionDeclined"
  | "connectionUnanswered"
  | "connectionFailed";

export type ProfileRead =
  | {
      readonly ok: true;
      readonly cookies: ReadonlyArray<SessionCookie>;
      readonly unsupported: number;
    }
  | { readonly ok: false; readonly reason: BrowserConnectionFailure };

export interface BrowserConnectionTarget {
  /** The browser's user data folder, which holds `Local State` and `DevToolsActivePort`. */
  readonly userDataDirectory: string;
  /** The browser's own executable, which opens a tab in one of its profiles. */
  readonly executable: string;
}

/** How long each wait lasts. */
export interface BrowserConnectionTimes {
  /** For a browser Scient started to begin listening. */
  readonly startup: number;
  /** For the person to answer the browser's question. */
  readonly answer: number;
  /** For the tab Scient opened to show up. */
  readonly tab: number;
  /** For one protocol command. */
  readonly command: number;
  /** Before an unused connection closes. */
  readonly idle: number;
  /** Between checks while waiting. */
  readonly poll: number;
}

const BROWSER_CONNECTION_TIMES: BrowserConnectionTimes = {
  startup: 30_000,
  answer: 180_000,
  tab: 20_000,
  command: 60_000,
  idle: 10_000,
  poll: 250,
};

/** The parts of a WebSocket the connection uses; the global one in Electron's main process. */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface BrowserConnectionDeps {
  readonly openSocket: (url: string) => SocketLike;
  /** Opens `url` in the browser's profile, starting the browser if it isn't running. */
  readonly openTab: (
    target: BrowserConnectionTarget,
    profileDirectory: string,
    url: string,
  ) => boolean;
  /** Whether the browser's debugging server answers on `port`. Never asks the person. */
  readonly serverAnswers: (port: number) => Promise<boolean>;
  readonly readFile: (path: string) => Promise<string | null>;
  readonly times: BrowserConnectionTimes;
}

const ACTIVE_PORT_FILE = "DevToolsActivePort";

/** The browser's listening address from `DevToolsActivePort`: port, then the browser's path. */
export function parseActivePort(text: string) {
  const [portLine, pathLine] = text.split(/\r?\n/).map((line) => line.trim());
  if (!portLine || !/^\d{1,5}$/.test(portLine) || !pathLine) return null;
  const port = Number(portLine);
  if (port < 1 || port > 65_535 || !/^\/devtools\/browser\/[\w-]+$/.test(pathLine)) return null;
  return { port, path: pathLine };
}

/** The person's switch as the browser last saved it in `Local State`. */
export function switchSaved(localState: string) {
  try {
    const parsed = JSON.parse(localState) as {
      devtools?: { remote_debugging?: { "user-enabled"?: unknown } };
    };
    return parsed.devtools?.remote_debugging?.["user-enabled"] === true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const listeningAddress = async (deps: BrowserConnectionDeps, userDataDirectory: string) => {
  const text = await deps.readFile(NodePath.join(userDataDirectory, ACTIVE_PORT_FILE));
  const address = text === null ? null : parseActivePort(text);
  // The file outlives the browser; only a server that answers is listening.
  return address && (await deps.serverAnswers(address.port)) ? address : null;
};

/**
 * Whether remote debugging is on: the browser is listening, or it saved the switch on and will
 * listen when it starts. A switch just turned on may not be saved yet, but the browser listens.
 */
async function connectionIsOn(deps: BrowserConnectionDeps, userDataDirectory: string) {
  if (await listeningAddress(deps, userDataDirectory)) return true;
  const localState = await deps.readFile(NodePath.join(userDataDirectory, "Local State"));
  return localState !== null && switchSaved(localState);
}

type Send = (method: string, params?: object, sessionId?: string) => Promise<unknown>;

interface Connection {
  readonly send: Send;
  readonly closed: () => boolean;
  readonly close: () => void;
}

/** Opens the browser-wide protocol connection; resolves once the person allowed it, or why not. */
function connect(
  deps: BrowserConnectionDeps,
  address: { readonly port: number; readonly path: string },
): Promise<Connection | BrowserConnectionFailure> {
  return new Promise((resolve) => {
    let socket: SocketLike;
    try {
      socket = deps.openSocket(`ws://127.0.0.1:${address.port}${address.path}`);
    } catch {
      resolve("connectionFailed");
      return;
    }
    const waiting = new Map<
      number,
      { readonly settle: (message: { result?: unknown; error?: unknown }) => void }
    >();
    let next = 0;
    let open = false;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      for (const { settle } of waiting.values()) settle({ error: "closed" });
      waiting.clear();
    };
    // The browser answers only after the person chose: nothing else ends this wait early.
    const unanswered = setTimeout(() => {
      if (open) return;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {}
      end();
      resolve("connectionUnanswered");
    }, deps.times.answer);
    socket.onopen = () => {
      open = true;
      clearTimeout(unanswered);
      resolve({
        send: (method, params = {}, sessionId) =>
          new Promise((settleResult, reject) => {
            if (ended) {
              reject(new Error(`${method}: connection closed`));
              return;
            }
            const id = ++next;
            const timer = setTimeout(() => {
              waiting.delete(id);
              reject(new Error(`${method}: no answer`));
            }, deps.times.command);
            waiting.set(id, {
              settle: (message) => {
                clearTimeout(timer);
                if (message.error === undefined) settleResult(message.result);
                else reject(new Error(`${method} failed`));
              },
            });
            socket.send(
              JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
            );
          }),
        closed: () => ended,
        close: () => {
          end();
          try {
            socket.close();
          } catch {}
        },
      });
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: { id?: unknown; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(event.data) as typeof message;
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const pending = waiting.get(message.id);
      waiting.delete(message.id);
      pending?.settle(message);
    };
    // Before it opens, a closed socket is the browser's refusal: Cancel, closing the question or
    // "Turn off in settings". The server answered just before, so it was listening.
    socket.onclose = socket.onerror = () => {
      end();
      if (!open) {
        clearTimeout(unanswered);
        resolve("connectionDeclined");
      }
    };
  });
}

/** A page that says what it is for and carries the nonce Scient finds its tab by. */
function markerUrl(nonce: string) {
  const html =
    "<!doctype html><meta charset=utf-8><title>Scient</title>" +
    '<body style="font:15px system-ui;margin:3em;color:#444">' +
    "<p>Scient is copying this profile’s sign-ins. This tab closes by itself.</p>" +
    `<!--scient-import:${nonce}-->`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * One connection per browser, shared by the profiles of one import. It closes once unused for
 * `idle`, so the browser's banner goes with it.
 */
export function createBrowserConnections(deps: BrowserConnectionDeps) {
  const open = new Map<
    string,
    {
      connection: Promise<Connection | BrowserConnectionFailure>;
      idle?: ReturnType<typeof setTimeout>;
    }
  >();
  // Reads queue per browser: one tab, one question and one jar at a time.
  const queues = new Map<string, Promise<unknown>>();

  const release = (userDataDirectory: string) => {
    const entry = open.get(userDataDirectory);
    if (!entry) return;
    entry.idle = setTimeout(() => {
      open.delete(userDataDirectory);
      void entry.connection.then((connection) => {
        if (typeof connection !== "string") connection.close();
      });
    }, deps.times.idle);
  };

  const connection = async (target: BrowserConnectionTarget) => {
    const existing = open.get(target.userDataDirectory);
    if (existing) {
      clearTimeout(existing.idle);
      const settled = await existing.connection;
      if (typeof settled !== "string" && !settled.closed()) return settled;
      open.delete(target.userDataDirectory);
    }
    const created = (async () => {
      // A browser Scient just started takes a moment to begin listening.
      const deadline = Date.now() + deps.times.startup;
      let address = await listeningAddress(deps, target.userDataDirectory);
      while (!address && Date.now() < deadline) {
        await sleep(deps.times.poll);
        address = await listeningAddress(deps, target.userDataDirectory);
      }
      if (!address)
        return (await connectionIsOn(deps, target.userDataDirectory))
          ? ("connectionFailed" as const)
          : ("connectionOff" as const);
      return connect(deps, address);
    })();
    open.set(target.userDataDirectory, { connection: created });
    const settled = await created;
    if (typeof settled === "string") open.delete(target.userDataDirectory);
    return settled;
  };

  const readOnce = async (
    target: BrowserConnectionTarget,
    profileDirectory: string,
  ): Promise<ProfileRead> => {
    // With the switch off nothing opens: no tab, no browser started for nothing.
    if (
      !open.has(target.userDataDirectory) &&
      !(await connectionIsOn(deps, target.userDataDirectory))
    )
      return { ok: false, reason: "connectionOff" };
    const nonce = NodeCrypto.randomBytes(12).toString("hex");
    // The tab first: the browser asks in its last active window, which is then this profile's.
    if (!deps.openTab(target, profileDirectory, markerUrl(nonce)))
      return { ok: false, reason: "connectionFailed" };
    const connected = await connection(target);
    if (typeof connected === "string") return { ok: false, reason: connected };
    let tab: string | undefined;
    try {
      const deadline = Date.now() + deps.times.tab;
      while (tab === undefined && Date.now() < deadline) {
        const { targetInfos } = (await connected.send("Target.getTargets")) as {
          readonly targetInfos: ReadonlyArray<{ targetId: string; type: string; url: string }>;
        };
        tab = targetInfos.find(
          (info) => info.type === "page" && info.url.includes(nonce),
        )?.targetId;
        if (tab === undefined) await sleep(deps.times.poll);
      }
      if (tab === undefined) return { ok: false, reason: "connectionFailed" };
      const { sessionId } = (await connected.send("Target.attachToTarget", {
        targetId: tab,
        flatten: true,
      })) as { sessionId: string };
      // Network commands act on the tab's own context: this profile's jar.
      const jar = await readJar((method, params) => connected.send(method, params, sessionId));
      return { ok: true, ...jar };
    } catch {
      return { ok: false, reason: "connectionFailed" };
    } finally {
      if (tab !== undefined && !connected.closed())
        await connected.send("Target.closeTarget", { targetId: tab }).catch(() => undefined);
      release(target.userDataDirectory);
    }
  };

  return {
    /** The profile's cookies, as its browser holds them; asks the person on a new connection. */
    readProfile: (target: BrowserConnectionTarget, profileDirectory: string) => {
      const previous = queues.get(target.userDataDirectory) ?? Promise.resolve();
      const read = previous.then(() => readOnce(target, profileDirectory));
      const queued = read.catch(() => undefined);
      queues.set(target.userDataDirectory, queued);
      void queued.then(() => {
        if (queues.get(target.userDataDirectory) === queued)
          queues.delete(target.userDataDirectory);
      });
      return read;
    },
    isOn: (userDataDirectory: string) => connectionIsOn(deps, userDataDirectory),
  };
}

const serverAnswers = (port: number) =>
  new Promise<boolean>((resolve) => {
    // In this mode the browser answers plain HTTP with 404; only a WebSocket asks the person.
    const request = NodeHttp.get(
      { host: "127.0.0.1", port, path: "/json/version", timeout: 1_500 },
      (response) => {
        response.resume();
        resolve(true);
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });

const openTab = (target: BrowserConnectionTarget, profileDirectory: string, url: string) => {
  try {
    // A running browser hands this to its open instance and exits; otherwise it is the browser,
    // and outlives Scient like any browser the person started.
    const child = NodeChildProcess.spawn(
      target.executable,
      [`--profile-directory=${profileDirectory}`, url],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", () => undefined);
    child.unref();
    return child.pid !== undefined;
  } catch {
    return false;
  }
};

const readFile = (path: string) => NodeFS.promises.readFile(path, "utf8").catch(() => null);

/** The app's connections, through Electron's own WebSocket. */
export const browserConnections = createBrowserConnections({
  openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  openTab,
  serverAnswers,
  readFile,
  times: BROWSER_CONNECTION_TIMES,
});
