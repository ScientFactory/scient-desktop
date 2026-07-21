import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertPackagedLaunchCommandSafety,
  createLinuxPackagedLaunchCommand,
  createPackagedDesktopSmokeEnvironment,
  isScientWindowsExecutable,
  parsePackagedDesktopStartupArgs,
  resolveNativePackagedDesktopPlatform,
  resolvePackagedDesktopLogPath,
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
        PATH: process.env.PATH,
        SCIENT_HOME: "/must/not/leak",
        LEGACY_PRODUCT_HOME: "/must/not/leak-either",
        PROVIDER_AUTH_TOKEN: "must-not-leak",
        ELECTRON_RUN_AS_NODE: "1",
      },
    );

    expect(env.LEGACY_PRODUCT_HOME).toBeUndefined();
    expect(env.PROVIDER_AUTH_TOKEN).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
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
    const launch = createLinuxPackagedLaunchCommand(
      "/tmp/scient-payload/AppRun",
      "/tmp/scient-payload",
    );

    expect(launch).toEqual({
      command: "xvfb-run",
      args: ["-a", "/tmp/scient-payload/AppRun", "--disable-gpu"],
      cwd: "/tmp/scient-payload",
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
