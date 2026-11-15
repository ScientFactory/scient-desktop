// @effect-diagnostics nodeBuiltinImport:off -- Paths are joined as the module joins them, per platform.
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  createBrowserConnections,
  parseActivePort,
  switchSaved,
  type BrowserConnectionDeps,
  type SocketLike,
} from "./browserConnection.ts";
import { importedCookie } from "./browserConnectionImport.ts";

const DIR = NodePath.join("browser", "User Data");
const ACTIVE = NodePath.join(DIR, "DevToolsActivePort");
const STATE = NodePath.join(DIR, "Local State");
const ON = JSON.stringify({ devtools: { remote_debugging: { "user-enabled": true } } });

const times = { startup: 200, answer: 200, tab: 200, command: 200, idle: 30, poll: 5 };

/**
 * A browser with remote debugging: answers the protocol for the tabs it opened, each tab's
 * profile holding its own jar. `answer` is what the person does when it asks.
 */
function fakeBrowser(options: {
  readonly files?: Record<string, string>;
  readonly listening?: boolean;
  readonly answer?: "allow" | "decline" | "never";
  readonly jars?: Record<string, ReadonlyArray<object>>;
}) {
  const files = { ...options.files };
  const tabs: Array<{ targetId: string; url: string; profile: string }> = [];
  const sent: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const sockets: Array<{ closed: boolean; ended: Promise<void> }> = [];
  const opened: Array<{ profile: string; url: string }> = [];
  const deps: BrowserConnectionDeps = {
    readFile: async (path) => files[path] ?? null,
    serverAnswers: async () => options.listening ?? true,
    openTab: (_target, profile, url) => {
      opened.push({ profile, url });
      tabs.push({ targetId: `tab-${tabs.length}`, url, profile });
      return true;
    },
    openSocket: () => {
      const ended = Promise.withResolvers<void>();
      const state = { closed: false, ended: ended.promise };
      sockets.push(state);
      const socket: SocketLike = {
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: (data) => {
          const { id, method, params, sessionId } = JSON.parse(data);
          sent.push({ method, params, sessionId });
          const reply = (result: unknown) =>
            queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ id, result }) }));
          if (method === "Target.getTargets")
            reply({
              targetInfos: tabs.map(({ targetId, url }) => ({ targetId, url, type: "page" })),
            });
          else if (method === "Target.attachToTarget")
            reply({ sessionId: `on-${params.targetId}` });
          else if (method === "Network.getAllCookies") {
            const tab = tabs.find(({ targetId }) => `on-${targetId}` === sessionId);
            reply({ cookies: options.jars?.[tab?.profile ?? ""] ?? [] });
          } else reply({});
        },
        close: () => {
          state.closed = true;
          ended.resolve();
        },
      };
      const answer = options.answer ?? "allow";
      if (answer !== "never")
        queueMicrotask(() => (answer === "allow" ? socket.onopen?.() : socket.onclose?.()));
      return socket;
    },
    times,
  };
  return { deps, sent, sockets, opened, files };
}

const target = { userDataDirectory: DIR, executable: "/browser/chrome.exe" };
const cookie = (name: string, value: string) => ({
  name,
  value,
  domain: ".example.org",
  path: "/",
  expires: 2_000_000_000,
  session: false,
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
});

describe("parseActivePort", () => {
  it("reads the port and the browser's path, and nothing else", () => {
    expect(parseActivePort("9222\n/devtools/browser/ab-12\n")).toEqual({
      port: 9222,
      path: "/devtools/browser/ab-12",
    });
    expect(parseActivePort("9222\r\n/devtools/browser/ab\r\n")?.port).toBe(9222);
    expect(parseActivePort("0\n/devtools/browser/ab")).toBeNull();
    expect(parseActivePort("70000\n/devtools/browser/ab")).toBeNull();
    expect(parseActivePort("9222\n/devtools/page/ab")).toBeNull();
    expect(parseActivePort("9222")).toBeNull();
  });
});

describe("switchSaved", () => {
  it("is on only when the browser saved the person's switch on", () => {
    expect(switchSaved(ON)).toBe(true);
    expect(switchSaved(JSON.stringify({ devtools: { remote_debugging: {} } }))).toBe(false);
    expect(switchSaved("{")).toBe(false);
  });
});

describe("createBrowserConnections", () => {
  it("opens nothing while remote debugging is off", async () => {
    const browser = fakeBrowser({ listening: false });
    const connections = createBrowserConnections(browser.deps);
    expect(await connections.isOn(DIR)).toBe(false);
    expect(await connections.readProfile(target, "Default")).toEqual({
      ok: false,
      reason: "connectionOff",
    });
    expect(browser.opened).toEqual([]);
    expect(browser.sockets).toEqual([]);
  });

  it("reads each profile through a tab in it, asking once for the whole import", async () => {
    const browser = fakeBrowser({
      files: { [ACTIVE]: "9222\n/devtools/browser/x", [STATE]: ON },
      jars: { "Profile 2": [cookie("work", "a")], Default: [cookie("home", "b")] },
    });
    const connections = createBrowserConnections(browser.deps);
    const [work, home] = await Promise.all([
      connections.readProfile(target, "Profile 2"),
      connections.readProfile(target, "Default"),
    ]);
    expect(work.ok && work.cookies.map(({ name, value }) => [name, value])).toEqual([
      ["work", "a"],
    ]);
    expect(home.ok && home.cookies.map(({ name, value }) => [name, value])).toEqual([
      ["home", "b"],
    ]);
    expect(browser.opened.map(({ profile }) => profile)).toEqual(["Profile 2", "Default"]);
    // One connection, and so one question, for both.
    expect(browser.sockets).toHaveLength(1);
    // Each jar is read on its own tab, which is closed afterwards.
    const reads = browser.sent.filter(({ method }) => method === "Network.getAllCookies");
    expect(reads.map(({ sessionId }) => sessionId)).toEqual(["on-tab-0", "on-tab-1"]);
    expect(
      browser.sent
        .filter(({ method }) => method === "Target.closeTarget")
        .map(({ params }) => params.targetId),
    ).toEqual(["tab-0", "tab-1"]);
    // Unused, it closes, and the browser's banner goes with it.
    await browser.sockets[0]?.ended;
    expect(browser.sockets[0]?.closed).toBe(true);
  });

  it("finds only the tab it opened, by its nonce", async () => {
    const browser = fakeBrowser({ files: { [ACTIVE]: "9222\n/devtools/browser/x", [STATE]: ON } });
    const connections = createBrowserConnections(browser.deps);
    await connections.readProfile(target, "Default");
    const url = browser.opened[0]?.url ?? "";
    expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url)).toContain(
      "Scient opened this tab to copy this profile’s sign-ins",
    );
  });

  it("says when the person declines or doesn't answer", async () => {
    const files = { [ACTIVE]: "9222\n/devtools/browser/x", [STATE]: ON };
    const declined = createBrowserConnections(fakeBrowser({ files, answer: "decline" }).deps);
    expect(await declined.readProfile(target, "Default")).toEqual({
      ok: false,
      reason: "connectionDeclined",
    });
    const silent = fakeBrowser({ files, answer: "never" });
    expect(await createBrowserConnections(silent.deps).readProfile(target, "Default")).toEqual({
      ok: false,
      reason: "connectionUnanswered",
    });
    expect(silent.sockets[0]?.closed).toBe(true);
  });

  it("fails when a browser with the switch on never starts listening", async () => {
    const browser = fakeBrowser({ files: { [STATE]: ON }, listening: false });
    expect(await createBrowserConnections(browser.deps).readProfile(target, "Default")).toEqual({
      ok: false,
      reason: "connectionFailed",
    });
    expect(browser.sockets).toEqual([]);
  });
});

describe("importedCookie", () => {
  const session = {
    name: "sid",
    value: "v",
    domain: ".example.org",
    hostOnly: false,
    path: "/app",
    secure: true,
    httpOnly: true,
    sameSite: "lax" as const,
    expires: 2_000_000_000,
  };

  it("keeps a domain cookie's domain and a host-only cookie's host in its URL alone", () => {
    expect(importedCookie(session)).toEqual({
      url: "https://example.org/app",
      name: "sid",
      value: "v",
      domain: ".example.org",
      path: "/app",
      secure: true,
      httpOnly: true,
      expirationDate: 2_000_000_000,
      sameSite: "lax",
    });
    const hostOnly = importedCookie({
      ...session,
      domain: "www.example.org",
      hostOnly: true,
      secure: false,
      expires: undefined,
    });
    expect(hostOnly.url).toBe("http://www.example.org/app");
    expect(hostOnly.domain).toBeUndefined();
    expect(hostOnly.expirationDate).toBeUndefined();
  });

  it("sets prefixed cookies over https and keeps a partition", () => {
    const partitionKey = { topLevelSite: "https://example.com", hasCrossSiteAncestor: true };
    const prefixed = importedCookie({ ...session, name: "__Host-x", secure: false, partitionKey });
    expect(prefixed.url.startsWith("https://")).toBe(true);
    expect(prefixed.partitionKey).toEqual(partitionKey);
  });
});
