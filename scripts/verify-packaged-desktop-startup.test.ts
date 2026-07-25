import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachMacDiskImageForInspection,
  assertPackagedLaunchCommandSafety,
  assertWindowsReleaseSignatureDetails,
  createPackagedDesktopSmokeEnvironment,
  expectedPackagedDesktopStartupAssetName,
  expectedPackagedDesktopStartupAssetNames,
  formatPackagedStartupFailures,
  hasPackagedStartupProof,
  isScientWindowsExecutable,
  monitorPackagedStartupTermination,
  parsePackagedDesktopStartupArgs,
  readWindowsExecutableArchitecture,
  readPackagedDesktopLogTail,
  readPackagedBackendProcessIds,
  resolveExactPackagedDesktopStartupAsset,
  resolveNativePackagedDesktopPlatform,
  resolvePackagedDesktopLogPath,
  runPackagedPreparationCommand,
  sanitizePackagedDesktopInheritedEnvironment,
  terminateProcessTree,
  waitForPackagedStartupProof,
  writePackagedStartupFailureDiagnostics,
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
        "mac",
        "--arch",
        "x64",
        "--version",
        "1.2.3",
        "--commit",
        "0123456789abcdef0123456789abcdef01234567",
      ]),
    ).toEqual({
      assetsDirectory: expect.stringMatching(/release-publish$/),
      platform: "mac",
      arch: "x64",
      version: "1.2.3",
      commit: "0123456789abcdef0123456789abcdef01234567",
      timeoutMs: 60_000,
    });

    expect(() =>
      parsePackagedDesktopStartupArgs([
        "--assets-dir",
        "./release-publish",
        "--platform",
        "mac",
        "--arch",
        "x64",
        "--version",
        "1.2.3",
        "--commit",
        "0123456789abcdef0123456789abcdef01234567",
        "--timeout-ms",
        "4999",
      ]),
    ).toThrow("--timeout-ms must be an integer between 5000 and 180000");

    expect(() =>
      parsePackagedDesktopStartupArgs([
        "--assets-dir",
        "./release-publish",
        "--platform",
        "win",
        "--arch",
        "ia32",
        "--version",
        "1.2.3",
        "--commit",
        "0123456789abcdef0123456789abcdef01234567",
      ]),
    ).toThrow("Unsupported packaged startup architecture: ia32");

    expect(() =>
      parsePackagedDesktopStartupArgs([
        "--assets-dir",
        "./release-publish",
        "--platform",
        "win",
        "--arch",
        "x64",
        "--version",
        "1.2.3",
        "--commit",
        "0123456",
      ]),
    ).toThrow("--commit must be a complete 40-character Git commit SHA");
  });

  it("isolates Scient state and removes inherited runtime authority", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-smoke-env-test-"));
    temporaryRoots.push(root);

    const env = createPackagedDesktopSmokeEnvironment(
      root,
      { platform: "mac", version: "1.2.3" },
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
    expect(env.SCIENT_DISABLE_SHELL_ENV_SYNC).toBe("1");
    expect(env.SCIENT_PACKAGED_STARTUP_SMOKE).toBe("1");
    expect(env.SYNARA_TELEMETRY_ENABLED).toBe("false");
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
      "TEMP",
      "TMP",
      "TMPDIR",
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
    expect(expectedPackagedDesktopStartupAssetName("mac", "arm64", "1.2.3")).toBe(
      "Scient-1.2.3-arm64.zip",
    );
    expect(expectedPackagedDesktopStartupAssetName("win", "x64", "1.2.3")).toBe(
      "Scient-1.2.3-x64.exe",
    );

    const root = mkdtempSync(join(tmpdir(), "scient-packaged-smoke-assets-test-"));
    temporaryRoots.push(root);
    const expected = join(root, "Scient-1.2.3-arm64.zip");
    writeFileSync(expected, "payload");
    expect(resolveExactPackagedDesktopStartupAsset(root, "Scient-1.2.3-arm64.zip")).toBe(expected);

    writeFileSync(join(root, "Scient-1.2.2-arm64.zip"), "stale payload");
    expect(() => resolveExactPackagedDesktopStartupAsset(root, "Scient-1.2.3-arm64.zip")).toThrow(
      "found 2 .zip payloads",
    );
  });

  it("requires both exact macOS distributable payloads but one Windows installer", () => {
    expect(expectedPackagedDesktopStartupAssetNames("mac", "arm64", "1.2.3")).toEqual([
      "Scient-1.2.3-arm64.zip",
      "Scient-1.2.3-arm64.dmg",
    ]);
    expect(expectedPackagedDesktopStartupAssetNames("win", "x64", "1.2.3")).toEqual([
      "Scient-1.2.3-x64.exe",
    ]);
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

  it("requires app, window, backend, and renderer readiness from the isolated log", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-smoke-proof-test-"));
    temporaryRoots.push(root);
    const logPath = join(root, "desktop-main.log");
    const requiredMarkers = [
      "app ready",
      "packaged identity name=Scient version=1.2.3 commit=0123456789abcdef0123456789abcdef01234567",
      "bootstrap main window created",
      "packaged main window visible",
      "backend semantic ready generation=1",
      "renderer main frame loaded",
      "packaged responsiveness confirmed generation=1",
    ];

    for (const omittedMarker of requiredMarkers) {
      writeFileSync(
        logPath,
        requiredMarkers.filter((marker) => marker !== omittedMarker).join("\n"),
      );
      expect(
        hasPackagedStartupProof(logPath, {
          version: "1.2.3",
          commit: "0123456789abcdef0123456789abcdef01234567",
        }),
      ).toBe(false);
    }

    writeFileSync(logPath, requiredMarkers.join("\n"));
    expect(
      hasPackagedStartupProof(logPath, {
        version: "1.2.3",
        commit: "0123456789abcdef0123456789abcdef01234567",
      }),
    ).toBe(true);

    for (const failureMarker of [
      "renderer main frame load failed code=-2 message=failed",
      "renderer main process gone reason=crashed exitCode=1",
      "renderer main window unresponsive",
      "packaged responsiveness failed message=frozen",
      "backend process exited generation=1 pid=42 reason=unexpected exit",
    ]) {
      writeFileSync(logPath, [...requiredMarkers, failureMarker].join("\n"));
      expect(
        hasPackagedStartupProof(logPath, {
          version: "1.2.3",
          commit: "0123456789abcdef0123456789abcdef01234567",
        }),
      ).toBe(false);
    }
  });

  it("reads the native architecture from a Windows PE executable header", () => {
    const executable = new Uint8Array(128);
    executable[0] = 0x4d;
    executable[1] = 0x5a;
    new DataView(executable.buffer).setUint32(0x3c, 64, true);
    executable.set([0x50, 0x45, 0, 0], 64);
    new DataView(executable.buffer).setUint16(68, 0x8664, true);
    expect(readWindowsExecutableArchitecture(executable)).toBe("x64");
    new DataView(executable.buffer).setUint16(68, 0xaa64, true);
    expect(readWindowsExecutableArchitecture(executable)).toBe("arm64");
    executable[64] = 0;
    expect(readWindowsExecutableArchitecture(executable)).toBeNull();
  });

  it("requires valid timestamped Windows signatures from the configured publisher", () => {
    const valid = {
      status: "Valid",
      statusMessage: "Signature verified.",
      signerSubject: "CN=Scient Factory Ltd, O=Scient Factory Ltd, C=IL",
      signerThumbprint: "ABC123",
      timestampSubject: "CN=Trusted Timestamp",
    };
    expect(() =>
      assertWindowsReleaseSignatureDetails(
        [valid, valid],
        "CN=Scient Factory Ltd, O=Scient Factory Ltd, C=IL",
      ),
    ).not.toThrow();
    expect(() =>
      assertWindowsReleaseSignatureDetails(
        [{ ...valid, status: "NotSigned" }, valid],
        valid.signerSubject,
      ),
    ).toThrow("not valid");
    expect(() =>
      assertWindowsReleaseSignatureDetails(
        [{ ...valid, signerSubject: "CN=Other Publisher" }, valid],
        valid.signerSubject,
      ),
    ).toThrow("does not match");
    expect(() =>
      assertWindowsReleaseSignatureDetails(
        [{ ...valid, timestampSubject: null }, valid],
        valid.signerSubject,
      ),
    ).toThrow("timestamp signer is missing");
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

  it("turns interrupt signals into an observable cleanup request and removes its listeners", async () => {
    const source = new EventEmitter();
    const termination = monitorPackagedStartupTermination(source);

    source.emit("SIGTERM");

    await expect(termination.signal).resolves.toBe("SIGTERM");
    expect(termination.readSignal()).toBe("SIGTERM");
    expect(source.listenerCount("SIGINT")).toBe(1);
    expect(source.listenerCount("SIGTERM")).toBe(0);

    termination.dispose();
    expect(source.listenerCount("SIGINT")).toBe(0);
    expect(source.listenerCount("SIGTERM")).toBe(0);
  });

  it("cancels a hung preparation command when the smoke receives SIGTERM", async () => {
    const source = new EventEmitter();
    const termination = monitorPackagedStartupTermination(source);
    const spawnProcess = vi.fn((_command, _args, _options) => {
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, {
        exitCode: null,
        pid: 42,
        signalCode: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const terminateProcess = vi.fn(async (child: ChildProcess) => {
      Object.assign(child, { exitCode: null, signalCode: "SIGTERM" });
      child.emit("exit", null, "SIGTERM");
      child.emit("close", null, "SIGTERM");
    });

    const command = runPackagedPreparationCommand("ditto", ["hung.zip"], {
      signal: termination.abortSignal,
      spawnProcess,
      terminateProcess,
    });
    source.emit("SIGTERM");

    await expect(command).rejects.toThrow("interrupted by SIGTERM");
    expect(terminateProcess).toHaveBeenCalledOnce();
    expect(termination.abortSignal.aborted).toBe(true);
    termination.dispose();
  });

  it("attempts to detach a partially mounted DMG after attach fails", async () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const attachError = new Error("attach interrupted");
    const runCommand = vi.fn(async (command: string, args: ReadonlyArray<string>) => {
      calls.push({ command, args });
      if (args[0] === "attach") throw attachError;
      return "";
    }) as unknown as typeof runPackagedPreparationCommand;

    await expect(
      attachMacDiskImageForInspection(
        "/tmp/Scient.dmg",
        "/tmp/scient-mount",
        new AbortController().signal,
        runCommand,
      ),
    ).rejects.toBe(attachError);
    expect(calls).toEqual([
      {
        command: "hdiutil",
        args: [
          "attach",
          "-readonly",
          "-nobrowse",
          "-mountpoint",
          "/tmp/scient-mount",
          "/tmp/Scient.dmg",
        ],
      },
      { command: "hdiutil", args: ["detach", "-force", "/tmp/scient-mount"] },
    ]);
  });

  it("rejects startup proof when the process handle closes before the exit event arrives", async () => {
    let now = 0;
    await expect(
      waitForPackagedStartupProof({
        timeoutMs: 5_000,
        hasProof: () => true,
        readOutcome: () => ({ exited: null, launchError: null }),
        isProcessAlive: () => now < 1_000,
        now: () => now,
        delay: async (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).rejects.toThrow("process handle is closed");
  });

  it("keeps a bounded diagnostic tail from a failed packaged startup log", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-log-tail-test-"));
    temporaryRoots.push(root);
    const logPath = join(root, "desktop-main.log");
    writeFileSync(logPath, "discarded-prefix\nrenderer main process gone reason=crashed");

    const tail = readPackagedDesktopLogTail(logPath, 49);
    expect(tail.length).toBeLessThanOrEqual(49);
    expect(tail).toContain("renderer main process gone reason=crashed");
    expect(readPackagedDesktopLogTail(join(root, "missing.log"))).toBe("");
  });

  it("preserves startup, cleanup, process output, and log diagnostics together", () => {
    expect(
      formatPackagedStartupFailures(
        [
          {
            phase: "startup verification failed",
            error: new Error("renderer froze"),
          },
          {
            phase: "process cleanup failed",
            error: new Error("backend survived"),
          },
        ],
        "stderr detail",
        "desktop log detail",
      ),
    ).toContain(
      "startup verification failed: renderer froze\nprocess cleanup failed: backend survived\nPackaged process output:\nstderr detail\nPackaged desktop log tail:\ndesktop log detail",
    );
  });

  it("exports bounded redacted failure evidence for hosted runners", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-diagnostics-test-"));
    temporaryRoots.push(root);

    const path = writePackagedStartupFailureDiagnostics(
      root,
      "failed https://localhost/?token=private Bearer very-secret",
    );

    expect(readFileSync(path, "utf8")).toContain("token=[REDACTED]");
    expect(readFileSync(path, "utf8")).toContain("Bearer [REDACTED]");
    expect(readFileSync(path, "utf8")).not.toContain("very-secret");
  });

  it("targets a live Windows root once and fails when its complete tree survives", async () => {
    const child = {
      exitCode: null,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    const runTaskkill = vi.fn((_pid: number, _timeoutMs: number) => ({
      status: 0,
    }));
    await expect(
      terminateProcessTree(
        child,
        {
          platform: "win32",
          childIsAlive: () => true,
          runTaskkill,
          waitForTargetsExit: async () => false,
        },
        [84],
      ),
    ).rejects.toThrow("survived Windows cleanup");
    expect(runTaskkill.mock.calls.map(([pid]) => pid)).toEqual([42]);
    expect(runTaskkill.mock.calls.map(([, timeoutMs]) => timeoutMs)).toEqual([5_000]);
  });

  it("fails Windows cleanup when taskkill fails even if observed targets disappear", async () => {
    const child = {
      exitCode: null,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    await expect(
      terminateProcessTree(child, {
        platform: "win32",
        childIsAlive: () => true,
        runTaskkill: () => ({ status: 1 }),
        waitForTargetsExit: async () => true,
      }),
    ).rejects.toThrow("lost authoritative tree termination");
  });

  it("waits for recorded Windows backends without signaling reused PIDs after root exit", async () => {
    const child = {
      exitCode: null,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    const runTaskkill = vi.fn((_pid: number, _timeoutMs: number) => ({
      status: 0,
    }));

    await terminateProcessTree(
      child,
      {
        platform: "win32",
        childIsAlive: () => false,
        runTaskkill,
        waitForTargetsExit: async () => true,
      },
      [84],
    );

    expect(runTaskkill).not.toHaveBeenCalled();
  });

  it("observes detached Windows backend cleanup after the packaged root exits", async () => {
    const child = {
      exitCode: 0,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    const runTaskkill = vi.fn((_pid: number, _timeoutMs: number) => ({
      status: 0,
    }));

    await terminateProcessTree(
      child,
      {
        platform: "win32",
        runTaskkill,
        waitForTargetsExit: async () => true,
      },
      [84],
    );

    expect(runTaskkill).not.toHaveBeenCalled();
  });

  it("recovers every spawned backend PID before runtime state is durable", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-smoke-pids-test-"));
    temporaryRoots.push(root);
    const env = createPackagedDesktopSmokeEnvironment(
      root,
      { platform: "mac", version: "1.2.3" },
      { PATH: process.env.PATH },
    );
    const logPath = resolvePackagedDesktopLogPath(env);
    mkdirSync(join(env.SCIENT_HOME!, "userdata", "logs"), { recursive: true });
    writeFileSync(
      logPath,
      [
        "backend process spawned generation=1 pid=42",
        "backend process spawned generation=2 pid=84",
        "backend process spawned generation=2 pid=84",
      ].join("\n"),
    );

    expect(readPackagedBackendProcessIds(env)).toEqual([42, 84]);
  });

  it("combines the durable runtime PID with every PID observed during startup", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-smoke-pids-test-"));
    temporaryRoots.push(root);
    const env = createPackagedDesktopSmokeEnvironment(
      root,
      { platform: "mac", version: "1.2.3" },
      { PATH: process.env.PATH },
    );
    const userDataPath = join(env.SCIENT_HOME!, "userdata");
    mkdirSync(join(userDataPath, "logs"), { recursive: true });
    writeFileSync(join(userDataPath, "server-runtime.json"), JSON.stringify({ pid: 126 }));
    writeFileSync(
      resolvePackagedDesktopLogPath(env),
      [
        "backend process spawned generation=1 pid=42",
        "backend process spawned generation=2 pid=126",
      ].join("\n"),
    );

    expect(readPackagedBackendProcessIds(env)).toEqual([126, 42]);
  });

  it("does not signal a backend PID that the startup log proves already exited", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-smoke-pids-test-"));
    temporaryRoots.push(root);
    const env = createPackagedDesktopSmokeEnvironment(
      root,
      { platform: "mac", version: "1.2.3" },
      { PATH: process.env.PATH },
    );
    const userDataPath = join(env.SCIENT_HOME!, "userdata");
    mkdirSync(join(userDataPath, "logs"), { recursive: true });
    writeFileSync(join(userDataPath, "server-runtime.json"), JSON.stringify({ pid: 42 }));
    writeFileSync(
      resolvePackagedDesktopLogPath(env),
      [
        "backend process spawned generation=1 pid=42",
        "backend process exited generation=1 pid=42 reason=code=1",
        "backend process spawned generation=2 pid=84",
      ].join("\n"),
    );

    expect(readPackagedBackendProcessIds(env)).toEqual([84]);
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
          platform: "darwin",
          childIsAlive: () => true,
          sendSignal: (target, signal) => signals.push({ pid: target.pid, signal }),
          targetIsAlive: () => true,
          waitForTargetsExit: async () => false,
        },
        [84],
      ),
    ).rejects.toThrow("refusing to signal unverified backend PIDs");
    expect(signals).toEqual([
      { pid: 42, signal: "SIGTERM" },
      { pid: 42, signal: "SIGKILL" },
    ]);
  });

  it("does not escalate a POSIX process tree that exited during the TERM grace period", async () => {
    const child = {
      exitCode: null,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const exitWaits: number[] = [];

    await terminateProcessTree(
      child,
      {
        platform: "darwin",
        childIsAlive: () => true,
        sendSignal: (target, signal) => signals.push({ pid: target.pid, signal }),
        targetIsAlive: () => false,
        waitForTargetsExit: async (_targets, timeoutMs) => {
          exitWaits.push(timeoutMs);
          return true;
        },
      },
      [84],
    );

    expect(signals).toEqual([{ pid: 42, signal: "SIGTERM" }]);
    expect(exitWaits).toEqual([12_000]);
  });

  it("fails closed when the POSIX root exits before escalation", async () => {
    const childState: {
      exitCode: number | null;
      pid: number;
      signalCode: NodeJS.Signals | null;
    } = {
      exitCode: null,
      pid: 42,
      signalCode: null,
    };
    const child = childState as unknown as ChildProcess;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    await expect(
      terminateProcessTree(
        child,
        {
          platform: "darwin",
          childIsAlive: () => true,
          sendSignal: (target, signal) => {
            signals.push({ pid: target.pid, signal });
            if (signal === "SIGTERM") childState.exitCode = 0;
          },
          targetIsAlive: () => true,
          waitForTargetsExit: async () => false,
        },
        [84],
      ),
    ).rejects.toThrow("refusing to signal a potentially reused process group");
    expect(signals).toEqual([{ pid: 42, signal: "SIGTERM" }]);
  });

  it("observes an orphaned POSIX process group without signaling it", async () => {
    const child = {
      exitCode: 0,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    const observed: Array<ReadonlyArray<{ pid: number; processGroup: boolean }>> = [];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    await expect(
      terminateProcessTree(child, {
        platform: "darwin",
        sendSignal: (target, signal) => signals.push({ pid: target.pid, signal }),
        waitForTargetsExit: async (targets) => {
          observed.push(targets);
          return false;
        },
      }),
    ).rejects.toThrow("refusing to signal unverified PIDs or process groups");
    expect(observed).toEqual([[{ pid: 42, processGroup: true }]]);
    expect(signals).toEqual([]);
  });

  it("fails closed without signaling a recorded PID when the root is already gone", async () => {
    const child = {
      exitCode: 0,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    const runTaskkill = vi.fn((_pid: number, _timeoutMs: number) => ({
      status: 0,
    }));

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
    ).rejects.toThrow("refusing to signal unverified PIDs");
    expect(runTaskkill).not.toHaveBeenCalled();
  });

  it("fails closed when a Windows root exits without any recorded descendants", async () => {
    const child = { exitCode: 0, pid: 42, signalCode: null } as unknown as ChildProcess;

    await expect(terminateProcessTree(child, { platform: "win32" })).rejects.toThrow(
      "exited before cleanup ownership was established",
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

    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual({
      version: "1.2.3",
    });
  });

  it("recognizes only the Scient Windows executable identity", () => {
    expect(isScientWindowsExecutable("C:\\payload\\Scient.exe")).toBe(true);
    expect(isScientWindowsExecutable("C:\\payload\\scient.EXE")).toBe(true);
    expect(isScientWindowsExecutable("C:\\payload\\Synara.exe")).toBe(false);
    expect(isScientWindowsExecutable("C:\\payload\\Scient Helper.exe")).toBe(false);
  });

  it("rejects unsafe arguments from every native packaged launch", () => {
    const launch = { command: "/tmp/Scient", args: [], cwd: "/tmp" };
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
    expect(resolveNativePackagedDesktopPlatform("linux")).toBeNull();
  });
});
