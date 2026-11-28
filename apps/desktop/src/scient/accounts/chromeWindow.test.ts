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
  forgetSignInWindow,
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
  // regression: the mock keychain and Linux's basic store kept cookies in plain text in a folder
  // that is now kept; the browser's own store encrypts them.
  for (const platform of ["darwin", "linux", "win32"] as const)
    expect(
      windowArgs("/f", "https://a.test/", platform).filter(
        (arg) => arg === "--use-mock-keychain" || arg.startsWith("--password-store"),
      ),
    ).toEqual([]);
  // Centred over Scient's window when it is given.
  expect(windowArgs("/f", "https://a.test/", "darwin", { x: 340.4, y: 120 })).toContain(
    "--window-position=340,120",
  );
  expect(
    windowArgs("/f", "https://a.test/", "darwin").some((arg) =>
      arg.startsWith("--window-position"),
    ),
  ).toBe(false);
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
    // The profile's folder stays, so the browser remembers its sign-ins next time.
    expect(NodeFS.existsSync(folder)).toBe(true);
  } finally {
    NodeFS.rmSync(folder, { recursive: true, force: true });
  }
});

it("brings the browser to the front on macOS, switching Spaces from a full-screen Scient", async () => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "chrome-window-front-"));
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    pid: 4242,
    kill: () => {
      child.emit("exit", null, "SIGKILL");
      return true;
    },
  });
  const commands: string[] = [];
  const spawned = Promise.withResolvers<void>();
  using _spawn = vi.spyOn(NodeChildProcess, "spawn").mockImplementation(((
    command: string,
    args: string[],
  ) => {
    commands.push([command, ...args].join(" "));
    if (command === "osascript")
      return new NodeEvents.EventEmitter() as NodeChildProcess.ChildProcess;
    queueMicrotask(() => {
      child.emit("spawn");
      spawned.resolve();
    });
    return child as unknown as NodeChildProcess.ChildProcess;
  }) as never);
  try {
    const read = signInInWindow({
      browser: { name: "fixture", executable: "/fixture/browser" },
      folder,
      url: "http://fixture/",
      platform: "darwin",
    });
    await spawned.promise;
    await vi.waitFor(() =>
      expect(
        commands.some(
          (command) => command.includes("activateWithOptions") && command.includes("4242"),
        ),
      ).toBe(true),
    );
    expect(endSignInWindow(false, "darwin")).toBe(true);
    expect(await read).toEqual({ outcome: "cancelled" });
  } finally {
    NodeFS.rmSync(folder, { recursive: true, force: true });
  }
});

it("forgets the window's folder only when no window uses it and nothing signed in there since", async () => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "chrome-window-forget-"));
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
    // Its window is open: not now, and the caller tries again.
    expect(await forgetSignInWindow(folder)).toBe(false);
    expect(NodeFS.existsSync(folder)).toBe(true);
    endSignInWindow(false, "win32");
    await read;
    // Signed in to after the Clear: those sign-ins are newer than what the Clear took.
    NodeFS.writeFileSync(NodePath.join(folder, "Local State"), "{}");
    expect(await forgetSignInWindow(folder, "2000-01-01T00:00:00.000Z")).toBe(true);
    expect(NodeFS.existsSync(folder)).toBe(true);
    expect(await forgetSignInWindow(folder, "2999-01-01T00:00:00.000Z")).toBe(true);
    expect(NodeFS.existsSync(folder)).toBe(false);
  } finally {
    NodeFS.rmSync(folder, { recursive: true, force: true });
  }
});

it("keeps no folder without a protected store", async () => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "chrome-window-plain-"));
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
      platform: "linux",
      remember: false,
    });
    await spawned.promise;
    endSignInWindow(false, "linux");
    await read;
    expect(NodeFS.existsSync(folder)).toBe(false);
  } finally {
    NodeFS.rmSync(folder, { recursive: true, force: true });
  }
});

it("opens no window on a folder while it is being forgotten (round 6d)", async () => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "chrome-window-race-"));
  using spawn = vi.spyOn(NodeChildProcess, "spawn");
  try {
    NodeFS.writeFileSync(NodePath.join(folder, "Local State"), "{}");
    // The forget has begun (it reads the folder's time before deleting it)...
    const forgotten = forgetSignInWindow(folder, "2999-01-01T00:00:00.000Z");
    // ...and a sign-in starts meanwhile: it waits as busy, and no browser starts on it.
    const read = await signInInWindow({
      browser: { name: "fixture", executable: "/fixture/browser" },
      folder,
      url: "http://fixture/",
      platform: "linux",
    });
    expect(read).toEqual({ outcome: "busy" });
    expect(spawn).not.toHaveBeenCalled();
    expect(await forgotten).toBe(true);
    expect(NodeFS.existsSync(folder)).toBe(false);
  } finally {
    NodeFS.rmSync(folder, { recursive: true, force: true });
  }
});
