// @effect-diagnostics nodeBuiltinImport:off -- Synthetic child and isolated temporary profiles.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { SessionCookie } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import {
  endSignInWindow,
  readArgs,
  signedInCookies,
  signInInWindow,
  windowArgs,
} from "./chromeWindow.ts";

vi.mock("node:child_process", { spy: true });

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

it("still cancels after Done while the browser quits", async () => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "chrome-window-cancel-"));
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    kill: () => {
      child.emit("exit", null, "SIGKILL");
      return true;
    },
  });
  const spawned = Promise.withResolvers<void>();
  using _spawn = vi.spyOn(NodeChildProcess, "spawn").mockImplementation(() => {
    queueMicrotask(() => {
      child.emit("spawn");
      spawned.resolve();
    });
    return child as NodeChildProcess.ChildProcess;
  });
  try {
    const read = signInInWindow({
      browser: { name: "fixture", executable: "/fixture/browser" },
      folder,
      url: "http://fixture/",
      platform: "win32",
    });
    await spawned.promise;
    expect(endSignInWindow(true, "win32")).toBe(true);
    expect(endSignInWindow(true, "win32")).toBe(false);
    expect(endSignInWindow(false, "win32")).toBe(true);
    expect(await read).toEqual({ outcome: "cancelled" });
    expect(NodeFS.existsSync(folder)).toBe(false);
  } finally {
    NodeFS.rmSync(folder, { recursive: true, force: true });
  }
});
