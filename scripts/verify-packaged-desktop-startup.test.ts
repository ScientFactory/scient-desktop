import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertPackagedLaunchCommandSafety,
  createLinuxPackagedLaunchCommand,
  createPackagedDesktopSmokeEnvironment,
  expectedPackagedDesktopStartupAssetName,
  isScientWindowsExecutable,
  parsePackagedDesktopStartupArgs,
  resolveExactPackagedDesktopStartupAsset,
  resolveNativePackagedDesktopPlatform,
  resolvePackagedDesktopLogPath,
  sanitizePackagedDesktopInheritedEnvironment,
  terminateProcessTree,
  waitForPackagedStartupProof,
} from "./verify-packaged-desktop-startup.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("packaged desktop startup verification", () => {
  it("parses a bounded native payload request", () => {
    expect(
      parsePackagedDesktopStartupArgs([
        "--assets-dir",
        "./release-publish",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        "1.2.3",
      ]),
    ).toEqual({
      assetsDirectory: expect.stringMatching(/release-publish$/),
      platform: "linux",
      arch: "x64",
      version: "1.2.3",
      timeoutMs: 60_000,
    });

    expect(() =>
      parsePackagedDesktopStartupArgs([
        "--assets-dir",
        "./release-publish",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        "1.2.3",
        "--timeout-ms",
        "4999",
      ]),
    ).toThrow("--timeout-ms must be an integer between 5000 and 180000");
  });

  it("isolates Scient state and removes inherited runtime authority", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-smoke-env-test-"));
    temporaryRoots.push(root);

    const env = createPackagedDesktopSmokeEnvironment(
      root,
      { platform: "linux", version: "1.2.3" },
      {
        DISPLAY: ":99",
        NODE_OPTIONS: "--require /tmp/untrusted.js",
        OPENAI_API_KEY: "must-not-leak",
        PATH: process.env.PATH,
        SCIENT_DEV_ALLOW_NO_SANDBOX: "1",
        SCIENT_HOME: "/must/not/leak",
        LEGACY_PRODUCT_HOME: "/must/not/leak-either",
        PROVIDER_AUTH_TOKEN: "must-not-leak",
        ELECTRON_RUN_AS_NODE: "1",
      },
    );

    expect(env.LEGACY_PRODUCT_HOME).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PROVIDER_AUTH_TOKEN).toBeUndefined();
    expect(env.SCIENT_DEV_ALLOW_NO_SANDBOX).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.DISPLAY).toBe(":99");
    for (const name of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "XDG_RUNTIME_DIR",
      "SCIENT_HOME",
    ] as const) {
      expect(env[name]?.startsWith(root)).toBe(true);
      expect(existsSync(env[name]!)).toBe(true);
    }
    if (process.platform !== "win32") {
      expect(statSync(env.XDG_RUNTIME_DIR!).mode & 0o777).toBe(0o700);
    }
    expect(resolvePackagedDesktopLogPath(env)).toBe(
      join(env.SCIENT_HOME!, "userdata", "logs", "desktop-main.log"),
    );
  });

  it("allowlists only host variables needed to launch a native packaged app", () => {
    expect(
      sanitizePackagedDesktopInheritedEnvironment({
        DISPLAY: ":99",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--inspect",
        OPENAI_API_KEY: "secret",
        PATH: "/usr/bin",
        SystemRoot: "C:\\Windows",
      }),
    ).toEqual({ DISPLAY: ":99", PATH: "/usr/bin", SystemRoot: "C:\\Windows" });
  });

  it("requires the exact versioned and architecture-specific release asset", () => {
    expect(expectedPackagedDesktopStartupAssetName("linux", "x64", "1.2.3")).toBe(
      "Scient-1.2.3-amd64.deb",
    );
    expect(expectedPackagedDesktopStartupAssetName("mac", "arm64", "1.2.3")).toBe(
      "Scient-1.2.3-arm64.zip",
    );
    expect(expectedPackagedDesktopStartupAssetName("win", "x64", "1.2.3")).toBe(
      "Scient-1.2.3-x64.exe",
    );

    const root = mkdtempSync(join(tmpdir(), "scient-packaged-smoke-assets-test-"));
    temporaryRoots.push(root);
    const expected = join(root, "Scient-1.2.3-amd64.deb");
    writeFileSync(expected, "payload");
    expect(resolveExactPackagedDesktopStartupAsset(root, "Scient-1.2.3-amd64.deb")).toBe(expected);

    writeFileSync(join(root, "Scient-1.2.2-amd64.deb"), "stale payload");
    expect(() => resolveExactPackagedDesktopStartupAsset(root, "Scient-1.2.3-amd64.deb")).toThrow(
      "found 2 .deb payloads",
    );
  });

  it("does not accept proof from a packaged process that exits immediately", async () => {
    let now = 0;
    let outcome = { exited: null, launchError: null } as {
      exited: { code: number | null; signal: NodeJS.Signals | null } | null;
      launchError: Error | null;
    };

    await expect(
      waitForPackagedStartupProof({
        timeoutMs: 5_000,
        hasProof: () => true,
        readOutcome: () => outcome,
        now: () => now,
        delay: async (milliseconds) => {
          now += milliseconds;
          outcome = { exited: { code: 1, signal: null }, launchError: null };
        },
      }),
    ).rejects.toThrow("exited before stable startup proof");
  });

  it("accepts startup proof only after the process remains alive for the stability window", async () => {
    let now = 0;
    await expect(
      waitForPackagedStartupProof({
        timeoutMs: 5_000,
        hasProof: () => true,
        readOutcome: () => ({ exited: null, launchError: null }),
        now: () => now,
        delay: async (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).resolves.toBeUndefined();
    expect(now).toBeGreaterThanOrEqual(1_000);
  });

  it("fails when Windows process-tree cleanup cannot prove exit", async () => {
    const child = {
      exitCode: null,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    const runTaskkill = vi.fn((_pid: number) => ({ status: 1 }));
    await expect(
      terminateProcessTree(
        child,
        {
          platform: "win32",
          runTaskkill,
          waitForTargetsExit: async () => false,
        },
        [84],
      ),
    ).rejects.toThrow("survived Windows cleanup");
    expect(runTaskkill.mock.calls.map(([pid]) => pid)).toEqual([42, 84]);
  });

  it("still cleans a detached Windows backend after the packaged root exits", async () => {
    const child = {
      exitCode: 0,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    const runTaskkill = vi.fn((_pid: number) => ({ status: 0 }));

    await terminateProcessTree(
      child,
      {
        platform: "win32",
        runTaskkill,
        waitForTargetsExit: async () => true,
      },
      [84],
    );

    expect(runTaskkill.mock.calls.map(([pid]) => pid)).toEqual([84]);
  });

  it("fails when a POSIX process tree survives TERM and KILL", async () => {
    const child = {
      exitCode: null,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    await expect(
      terminateProcessTree(
        child,
        {
          platform: "linux",
          sendSignal: (target, signal) => signals.push({ pid: target.pid, signal }),
          waitForTargetsExit: async () => false,
        },
        [84],
      ),
    ).rejects.toThrow("survived SIGTERM and SIGKILL");
    expect(signals).toEqual([
      { pid: 42, signal: "SIGTERM" },
      { pid: 84, signal: "SIGTERM" },
      { pid: 42, signal: "SIGKILL" },
      { pid: 84, signal: "SIGKILL" },
    ]);
  });

  it("prepares the isolated Scient macOS profile marker", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-smoke-mac-env-test-"));
    temporaryRoots.push(root);

    const env = createPackagedDesktopSmokeEnvironment(
      root,
      { platform: "mac", version: "1.2.3" },
      { PATH: process.env.PATH },
    );
    const markerPath = join(
      env.HOME!,
      "Library",
      "Application Support",
      "scient",
      "last-launch-version.json",
    );

    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual({ version: "1.2.3" });
  });

  it("recognizes only the Scient Windows executable identity", () => {
    expect(isScientWindowsExecutable("C:\\payload\\Scient.exe")).toBe(true);
    expect(isScientWindowsExecutable("C:\\payload\\scient.EXE")).toBe(true);
    expect(isScientWindowsExecutable("C:\\payload\\Synara.exe")).toBe(false);
    expect(isScientWindowsExecutable("C:\\payload\\Scient Helper.exe")).toBe(false);
  });

  it("keeps exact packaged Linux verification on the real sandboxed command line", () => {
    const launch = createLinuxPackagedLaunchCommand("/opt/Scient/scient", "/opt/Scient");

    expect(launch).toEqual({
      command: "xvfb-run",
      args: ["-a", "/opt/Scient/scient", "--disable-gpu"],
      cwd: "/opt/Scient",
    });
    expect(launch.args).not.toContain("--no-sandbox");
    expect(() => assertPackagedLaunchCommandSafety(launch)).not.toThrow();
    expect(() =>
      assertPackagedLaunchCommandSafety({
        ...launch,
        args: [...launch.args, "--no-sandbox"],
      }),
    ).toThrow("must exercise the real sandboxed command line");
  });

  it("maps Node host platforms to release platform names", () => {
    expect(resolveNativePackagedDesktopPlatform("darwin")).toBe("mac");
    expect(resolveNativePackagedDesktopPlatform("win32")).toBe("win");
    expect(resolveNativePackagedDesktopPlatform("linux")).toBe("linux");
  });
});
