import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachMacDiskImageForInspection,
  assertPackagedLaunchCommandSafety,
  assertUnsignedWindowsReleaseSignatureDetails,
  assertWindowsReleaseSignatureDetails,
  cleanupPackagedStartupTemporaryRoot,
  createPackagedDesktopSmokeEnvironment,
  expectedPackagedDesktopStartupAssetName,
  expectedPackagedDesktopStartupAssetNames,
  formatPackagedStartupFailures,
  hasProvenPackagedNativeChildOutcome,
  hasPackagedStartupProof,
  isScientWindowsExecutable,
  monitorPackagedStartupTermination,
  PackagedPreparationCleanupError,
  parsePackagedDesktopStartupArgs,
  prepareMacLaunch,
  prepareWindowsJobLauncherAssembly,
  readWindowsExecutableArchitecture,
  readPackagedDesktopLogTail,
  readPackagedBackendProcessIds,
  readPackagedNativeChildOutcome,
  resolveExactPackagedDesktopStartupAsset,
  resolveNativePackagedDesktopPlatform,
  resolvePackagedDesktopLogPath,
  runPackagedPreparationCommand,
  sanitizePackagedDesktopInheritedEnvironment,
  spawnContainedPackagedDesktop,
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
      "packaged main window hidden",
      "packaged main window closed",
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

  it("requires genuinely unsigned Windows payloads in explicit unsigned mode", () => {
    const unsigned = {
      status: "NotSigned",
      statusMessage: "The file is not digitally signed.",
      signerSubject: null,
      signerThumbprint: null,
      timestampSubject: null,
    };
    expect(() => assertUnsignedWindowsReleaseSignatureDetails([unsigned, unsigned])).not.toThrow();
    expect(() =>
      assertUnsignedWindowsReleaseSignatureDetails([
        { ...unsigned, status: "HashMismatch" },
        unsigned,
      ]),
    ).toThrow("must be genuinely unsigned");
    expect(() =>
      assertUnsignedWindowsReleaseSignatureDetails([
        {
          ...unsigned,
          status: "Valid",
          signerSubject: "CN=Other Publisher",
          signerThumbprint: "FOREIGN",
          timestampSubject: "CN=Timestamp",
        },
        unsigned,
      ]),
    ).toThrow("must be genuinely unsigned");
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

  it("rejects proof invalidated by a window close during the stability window", async () => {
    let now = 0;
    let windowClosed = false;
    await expect(
      waitForPackagedStartupProof({
        timeoutMs: 1_000,
        stableForMs: 500,
        hasProof: () => !windowClosed,
        readOutcome: () => ({ exited: null, launchError: null }),
        now: () => now,
        delay: async (milliseconds) => {
          now += milliseconds;
          windowClosed = true;
        },
      }),
    ).rejects.toThrow("timed out");
  });

  it("re-reads the native child outcome at the stability acceptance boundary", async () => {
    let now = 0;
    let outcomeReads = 0;
    await expect(
      waitForPackagedStartupProof({
        timeoutMs: 5_000,
        stableForMs: 1_000,
        hasProof: () => true,
        readOutcome: () => {
          outcomeReads += 1;
          return outcomeReads === 7
            ? { exited: { code: 9, signal: null }, launchError: null }
            : { exited: null, launchError: null };
        },
        isProcessAlive: () => true,
        now: () => now,
        delay: async (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).rejects.toThrow("code=9");
    expect(now).toBe(1_000);
    expect(outcomeReads).toBe(7);
  });

  it("turns interrupt signals into an observable cleanup request and removes its listeners", async () => {
    const source = new EventEmitter();
    const termination = monitorPackagedStartupTermination(source);

    source.emit("SIGTERM");

    await expect(termination.signal).resolves.toBe("SIGTERM");
    expect(termination.readSignal()).toBe("SIGTERM");
    expect(source.listenerCount("SIGINT")).toBe(1);
    expect(source.listenerCount("SIGTERM")).toBe(1);

    source.emit("SIGTERM");
    expect(termination.readSignal()).toBe("SIGTERM");

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

  it("classifies failed preparation termination as cleanup failure", async () => {
    const abortController = new AbortController();
    const spawnProcess = vi.fn(() => {
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
    const command = runPackagedPreparationCommand("ditto", ["hung.zip"], {
      signal: abortController.signal,
      spawnProcess,
      terminateProcess: async () => {
        throw new Error("tree survived");
      },
    });

    abortController.abort(new Error("interrupted"));

    await expect(command).rejects.toBeInstanceOf(PackagedPreparationCleanupError);
  });

  it("fails closed when Windows preparation descendants are not Job-contained", async () => {
    const abortController = new AbortController();
    const kill = vi.fn(() => true);
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, {
        exitCode: null,
        kill,
        pid: 42,
        signalCode: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const command = runPackagedPreparationCommand("7z", ["hung.exe"], {
      platform: "win32",
      signal: abortController.signal,
      spawnProcess,
    });

    abortController.abort(new Error("interrupted"));

    await expect(command).rejects.toBeInstanceOf(PackagedPreparationCleanupError);
    expect(kill).toHaveBeenCalledOnce();
  });

  it("compiles the Windows Job launcher only in the classified preparation phase", async () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-job-prepare-test-"));
    temporaryRoots.push(root);
    const runCommand = vi.fn(async (_command: string, args: ReadonlyArray<string>) => {
      const outputIndex = args.indexOf("-CompileAssemblyPath");
      writeFileSync(args[outputIndex + 1]!, "prepared assembly");
      return "";
    }) as unknown as typeof runPackagedPreparationCommand;

    const assemblyPath = await prepareWindowsJobLauncherAssembly(
      root,
      new AbortController().signal,
      runCommand,
    );

    expect(assemblyPath).toBe(join(root, "packaged-startup-windows-job.dll"));
    expect(runCommand).toHaveBeenCalledWith(
      expect.stringMatching(/powershell\.exe$/i),
      expect.arrayContaining([
        "-File",
        expect.stringMatching(/packaged-startup-windows-job\.ps1$/),
        "-CompileAssemblyPath",
        assemblyPath,
      ]),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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

  it("reports an unknown forced-detach failure after interrupted DMG attach", async () => {
    const runCommand = vi.fn(async (_command: string, args: ReadonlyArray<string>) => {
      if (args[0] === "attach") throw new Error("attach interrupted");
      throw new Error("resource still busy");
    }) as unknown as typeof runPackagedPreparationCommand;

    await expect(
      attachMacDiskImageForInspection(
        "/tmp/Scient.dmg",
        "/tmp/scient-mount",
        new AbortController().signal,
        runCommand,
      ),
    ).rejects.toBeInstanceOf(PackagedPreparationCleanupError);
  });

  it("preserves the attach error when forced detach proves no mount exists", async () => {
    const attachError = new Error("attach interrupted");
    const runCommand = vi.fn(async (_command: string, args: ReadonlyArray<string>) => {
      if (args[0] === "attach") throw attachError;
      throw new Error("hdiutil: detach failed - No such file or directory");
    }) as unknown as typeof runPackagedPreparationCommand;

    await expect(
      attachMacDiskImageForInspection(
        "/tmp/Scient.dmg",
        "/tmp/scient-mount",
        new AbortController().signal,
        runCommand,
      ),
    ).rejects.toBe(attachError);
  });

  it("force-detaches a mounted DMG when ordinary cleanup reports it busy", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const runCommand = vi.fn(async (_command: string, args: ReadonlyArray<string>) => {
      calls.push(args);
      if (args[0] === "detach" && args[1] !== "-force") throw new Error("resource busy");
      return "";
    }) as unknown as typeof runPackagedPreparationCommand;

    const cleanup = await attachMacDiskImageForInspection(
      "/tmp/Scient.dmg",
      "/tmp/scient-mount",
      new AbortController().signal,
      runCommand,
    );
    await cleanup();

    expect(calls).toEqual([
      ["attach", "-readonly", "-nobrowse", "-mountpoint", "/tmp/scient-mount", "/tmp/Scient.dmg"],
      ["detach", "/tmp/scient-mount"],
      ["detach", "-force", "/tmp/scient-mount"],
    ]);
  });

  it("reports both ordinary and forced DMG cleanup failures", async () => {
    const runCommand = vi.fn(async (_command: string, args: ReadonlyArray<string>) => {
      if (args[0] === "detach") throw new Error(args[1] === "-force" ? "force failed" : "busy");
      return "";
    }) as unknown as typeof runPackagedPreparationCommand;
    const cleanup = await attachMacDiskImageForInspection(
      "/tmp/Scient.dmg",
      "/tmp/scient-mount",
      new AbortController().signal,
      runCommand,
    );

    await expect(cleanup()).rejects.toThrow("normally or forcibly");
    expect(runCommand).toHaveBeenCalledTimes(3);
  });

  it("preserves a mounted DMG when inspection and both detach attempts fail", async () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-dmg-inspection-test-"));
    temporaryRoots.push(root);
    writeFileSync(join(root, "Scient-1.2.3-arm64.dmg"), "fixture");
    const extractionRoot = join(root, "mount");
    const executableDirectory = join(extractionRoot, "Scient.app", "Contents", "MacOS");
    mkdirSync(executableDirectory, { recursive: true });
    writeFileSync(join(executableDirectory, "Scient"), "fixture");
    writeFileSync(join(extractionRoot, "Scient.app", "Contents", "Info.plist"), "fixture");
    const runCommand = vi.fn(async (_command: string, args: ReadonlyArray<string>) => {
      if (args[0] === "attach") return "";
      if (args[0] === "detach") throw new Error(args[1] === "-force" ? "force failed" : "busy");
      if (args[0] === "-extract") throw new Error("plist inspection failed");
      return "";
    }) as unknown as typeof runPackagedPreparationCommand;

    await expect(
      prepareMacLaunch(
        root,
        extractionRoot,
        "Scient-1.2.3-arm64.dmg",
        { arch: "arm64", version: "1.2.3" },
        new AbortController().signal,
        runCommand,
      ),
    ).rejects.toBeInstanceOf(PackagedPreparationCleanupError);
    expect(runCommand).toHaveBeenCalledWith(
      "hdiutil",
      ["detach", "-force", extractionRoot],
      expect.any(Object),
    );
  });

  it.each(["zip", "dmg"] as const)(
    "rejects in-root and escaping Scient.app symlinks in the %s inspection path",
    async (extension) => {
      for (const targetLocation of ["inside", "outside"] as const) {
        const root = mkdtempSync(join(tmpdir(), `scient-packaged-${extension}-symlink-test-`));
        temporaryRoots.push(root);
        const expectedAssetName = `Scient-1.2.3-arm64.${extension}`;
        writeFileSync(join(root, expectedAssetName), "fixture");
        const extractionRoot = join(root, "payload");
        mkdirSync(extractionRoot, { recursive: true });
        const target =
          targetLocation === "inside"
            ? join(extractionRoot, "bundle-target")
            : join(root, "outside-bundle-target");
        mkdirSync(join(target, "Contents", "MacOS"), { recursive: true });
        writeFileSync(join(target, "Contents", "Info.plist"), "fixture");
        writeFileSync(join(target, "Contents", "MacOS", "Scient"), "fixture");
        symlinkSync(target, join(extractionRoot, "Scient.app"), "dir");
        const runCommandMock = vi.fn(async (_command: string, args: ReadonlyArray<string>) => {
          if (args[0] === "detach") return "";
          return "";
        });
        const runCommand = runCommandMock as unknown as typeof runPackagedPreparationCommand;

        await expect(
          prepareMacLaunch(
            root,
            extractionRoot,
            expectedAssetName,
            { arch: "arm64", version: "1.2.3" },
            new AbortController().signal,
            runCommand,
          ),
        ).rejects.toThrow("Expected the exact Scient.app bundle");
        expect(runCommandMock.mock.calls.some(([, args]) => args[0] === "-extract")).toBe(false);
      }
    },
  );

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

  it("preserves top-level temporary evidence after process preparation cleanup fails", () => {
    const remove = vi.fn();
    const temporaryRoot = "/tmp/scient-packaged-smoke-preserved";

    const result = cleanupPackagedStartupTemporaryRoot({
      temporaryRoot,
      processCleanupFailed: true,
      remove,
    });

    expect(remove).not.toHaveBeenCalled();
    expect(result).toEqual({
      preserved: true,
      failure: {
        phase: "temporary-state cleanup skipped",
        error: expect.objectContaining({
          message: `Preserved failed process evidence at ${temporaryRoot}.`,
        }),
      },
    });
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

  it("closes a live Windows Job Object launcher by process handle", async () => {
    const child = {
      exitCode: null,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    const terminateRoot = vi.fn(() => true);
    await expect(
      terminateProcessTree(
        child,
        {
          platform: "win32",
          childIsAlive: () => true,
          terminateRoot,
          waitForTargetsExit: async () => false,
        },
        [84],
      ),
    ).rejects.toThrow("survived handle-bound cleanup");
    expect(terminateRoot).toHaveBeenCalledOnce();
    expect(terminateRoot).toHaveBeenCalledWith(child);
  });

  it("fails closed when the Windows Job Object launcher handle cannot terminate", async () => {
    const child = {
      exitCode: null,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    await expect(
      terminateProcessTree(child, {
        platform: "win32",
        childIsAlive: () => true,
        terminateRoot: () => false,
        waitForTargetsExit: async () => true,
      }),
    ).rejects.toThrow("could not be terminated by handle");
  });

  it("only observes Job Object descendants after the Windows launcher exits", async () => {
    const child = {
      exitCode: 0,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    const terminateRoot = vi.fn(() => true);

    await terminateProcessTree(
      child,
      {
        platform: "win32",
        terminateRoot,
        waitForTargetsExit: async () => true,
      },
      [84],
    );

    expect(terminateRoot).not.toHaveBeenCalled();
  });

  it("launches Windows suspended into a kill-on-close Job Object and macOS behind a sentinel", () => {
    const spawnProcess = vi.fn(() => ({ pid: 42 }) as unknown as ChildProcess);
    const launch = {
      command: "/payload/Scient",
      args: [],
      cwd: "/payload",
      windowsJobAssemblyPath: "C:\\payload\\packaged-startup-windows-job.dll",
    };

    spawnContainedPackagedDesktop(
      launch,
      { SystemRoot: "D:\\Windows" },
      "win32",
      spawnProcess as unknown as typeof import("node:child_process").spawn,
    );
    const windowsCall = (
      spawnProcess.mock.calls as unknown as Array<[string, string[], Record<string, unknown>]>
    )[0]!;
    expect(windowsCall[0]).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(windowsCall[1]).toEqual(
      expect.arrayContaining([
        "-File",
        expect.stringMatching(/packaged-startup-windows-job\.ps1$/),
        "-AssemblyPath",
        launch.windowsJobAssemblyPath,
      ]),
    );
    expect(windowsCall[2]).toEqual(expect.objectContaining({ detached: false }));
    const jobScriptPath = (windowsCall[1] as string[])[
      (windowsCall[1] as string[]).indexOf("-File") + 1
    ]!;
    const jobScript = readFileSync(jobScriptPath, "utf8");
    expect(jobScript).toContain("CREATE_SUSPENDED");
    expect(jobScript).toContain("EXTENDED_STARTUPINFO_PRESENT");
    expect(jobScript).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
    expect(jobScript).toContain("PROC_THREAD_ATTRIBUTE_JOB_LIST");
    expect(jobScript).toContain("SCIENT_PACKAGED_STARTUP_SENTINEL_PID");
    expect(jobScript).toContain("Add-Type -Path $AssemblyPath");
    expect(jobScript.indexOf("Add-Type -TypeDefinition $source")).toBeLessThan(
      jobScript.indexOf("exit 0"),
    );
    expect(jobScript.indexOf("exit 0")).toBeLessThan(jobScript.indexOf("Add-Type -Path"));
    expect(jobScript).toContain("[string]$PID");
    expect(jobScript).not.toContain("AssignProcessToJobObject");
    expect(jobScript.indexOf("if (!UpdateProcThreadAttribute(")).toBeLessThan(
      jobScript.indexOf("if (!CreateProcess("),
    );
    expect(jobScript.indexOf("if (!CreateProcess(")).toBeLessThan(
      jobScript.indexOf("ResumeThread(child.hThread)"),
    );

    spawnProcess.mockClear();
    spawnContainedPackagedDesktop(
      launch,
      { SCIENT_HOME: "/isolated" },
      "darwin",
      spawnProcess as unknown as typeof import("node:child_process").spawn,
    );
    const posixCall = (
      spawnProcess.mock.calls as unknown as Array<[string, string[], Record<string, unknown>]>
    )[0]!;
    expect(posixCall[0]).toBe(process.execPath);
    expect(posixCall[1]).toEqual(
      expect.arrayContaining([expect.stringMatching(/packaged-startup-posix-sentinel\.mjs$/)]),
    );
    expect(posixCall[2]).toEqual(expect.objectContaining({ detached: true }));
  });

  it.skipIf(process.platform !== "win32")(
    "passes authenticated direct-parent authority through the actual Windows Job launcher",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "scient-packaged-job-authority-test-"));
      temporaryRoots.push(root);
      const executable = join(root, "AuthorityProbe.exe");
      const markerPath = join(root, "authority.marker");
      const powershell = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const source = [
        "using System;",
        "using System.IO;",
        "public static class AuthorityProbe {",
        "  public static void Main() {",
        '    File.WriteAllText(Environment.GetEnvironmentVariable("SCIENT_AUTHORITY_MARKER_PATH"),',
        '      Environment.GetEnvironmentVariable("SCIENT_PACKAGED_STARTUP_SENTINEL_PID") ?? "missing");',
        "  }",
        "}",
      ].join(" ");
      execFileSync(
        powershell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Add-Type -TypeDefinition $env:SCIENT_AUTHORITY_PROBE_SOURCE -Language CSharp -OutputAssembly '${executable.replaceAll("'", "''")}' -OutputType ConsoleApplication`,
        ],
        { env: { ...process.env, SCIENT_AUTHORITY_PROBE_SOURCE: source }, stdio: "pipe" },
      );
      const windowsJobAssemblyPath = await prepareWindowsJobLauncherAssembly(
        root,
        new AbortController().signal,
      );

      const launcher = spawnContainedPackagedDesktop(
        { command: executable, args: [], cwd: root, windowsJobAssemblyPath },
        {
          ...process.env,
          SCIENT_HOME: join(root, "scient-home"),
          SCIENT_PACKAGED_STARTUP_SMOKE: "1",
          SCIENT_AUTHORITY_MARKER_PATH: markerPath,
        },
        "win32",
      );
      await new Promise<void>((resolve, reject) => {
        launcher.once("error", reject);
        launcher.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`Windows Job launcher exited ${code}.`)),
        );
      });

      expect(readFileSync(markerPath, "utf8")).toBe(String(launcher.pid));
    },
    30_000,
  );

  it.skipIf(process.platform !== "win32")(
    "atomically kills the suspended Windows payload when its launcher is interrupted pre-resume",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "scient-packaged-job-cancel-test-"));
      temporaryRoots.push(root);
      const markerPath = join(root, "pre-resume.marker");
      const gatePath = join(root, "pre-resume.gate");
      const powershell = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const windowsJobAssemblyPath = await prepareWindowsJobLauncherAssembly(
        root,
        new AbortController().signal,
      );
      const launcher = spawn(
        powershell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          fileURLToPath(new URL("./lib/packaged-startup-windows-job.ps1", import.meta.url)),
          "-AssemblyPath",
          windowsJobAssemblyPath,
          "-ExecutablePath",
          powershell,
          "-WorkingDirectory",
          root,
          "-PreResumeMarkerPath",
          markerPath,
          "-PreResumeGatePath",
          gatePath,
        ],
        { stdio: "ignore" },
      );

      const waitUntil = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (predicate()) return true;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        }
        return predicate();
      };
      const markerAppeared = await waitUntil(() => existsSync(markerPath), 15_000);
      const payloadProcessId = markerAppeared ? Number(readFileSync(markerPath, "utf8")) : null;
      const launcherTerminated = launcher.kill();
      const launcherExited = await waitUntil(
        () => launcher.exitCode !== null || launcher.signalCode !== null,
        5_000,
      );

      expect(markerAppeared).toBe(true);
      expect(
        payloadProcessId !== null && Number.isInteger(payloadProcessId) && payloadProcessId > 0,
      ).toBe(true);
      expect(launcherTerminated).toBe(true);
      expect(launcherExited).toBe(true);
      expect(
        await waitUntil(() => {
          try {
            process.kill(payloadProcessId!, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ESRCH";
          }
        }, 5_000),
      ).toBe(true);
    },
    30_000,
  );

  it("reads the POSIX sentinel native-child outcome from isolated state", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-packaged-outcome-test-"));
    temporaryRoots.push(root);
    const environment = { SCIENT_HOME: root };

    expect(readPackagedNativeChildOutcome(environment)).toEqual({
      exited: null,
      launchError: null,
    });
    writeFileSync(
      join(root, "packaged-native-child-outcome.json"),
      JSON.stringify({ exited: { code: 7, signal: null }, launchError: null }),
    );
    expect(readPackagedNativeChildOutcome(environment)).toEqual({
      exited: { code: 7, signal: null },
      launchError: null,
    });
    expect(hasProvenPackagedNativeChildOutcome(environment)).toBe(true);
    for (const invalidOutcome of [
      { exited: { code: null, signal: null }, launchError: null },
      { exited: { code: 0, signal: "SIGKILL" }, launchError: null },
      { exited: { code: 0.5, signal: null }, launchError: null },
      { exited: { code: null, signal: "NOT_A_SIGNAL" }, launchError: null },
      { exited: null, launchError: { message: "   " } },
    ]) {
      writeFileSync(
        join(root, "packaged-native-child-outcome.json"),
        JSON.stringify(invalidOutcome),
      );
      expect(hasProvenPackagedNativeChildOutcome(environment)).toBe(false);
    }
    writeFileSync(join(root, "packaged-native-child-outcome.json"), "{malformed");
    expect(readPackagedNativeChildOutcome(environment).launchError).toBeInstanceOf(Error);
    expect(hasProvenPackagedNativeChildOutcome(environment)).toBe(false);
    rmSync(join(root, "packaged-native-child-outcome.json"));
    mkdirSync(join(root, "packaged-native-child-outcome.json"));
    expect(readPackagedNativeChildOutcome(environment).launchError).toBeInstanceOf(Error);
    expect(hasProvenPackagedNativeChildOutcome(environment)).toBe(false);
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

  it("keeps the POSIX sentinel as group authority through TERM and KILL", async () => {
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
          waitForPosixPayloadExit: async (timeoutMs) => timeoutMs === 12_000,
          waitForTargetsExit: async () => false,
        },
        [84],
      ),
    ).rejects.toThrow("survived authoritative");
    expect(signals).toEqual([
      { pid: 42, signal: "SIGTERM" },
      { pid: 42, signal: "SIGKILL" },
    ]);
  });

  it("waits for the native POSIX payload before killing the retained sentinel group", async () => {
    const child = {
      exitCode: null,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const events: string[] = [];

    await terminateProcessTree(
      child,
      {
        platform: "darwin",
        childIsAlive: () => true,
        sendSignal: (target, signal) => {
          events.push(signal);
          signals.push({ pid: target.pid, signal });
        },
        targetIsAlive: () => true,
        waitForPosixPayloadExit: async (timeoutMs) => {
          events.push(`wait:${timeoutMs}`);
          return true;
        },
        waitForTargetsExit: async (_targets, timeoutMs) => {
          events.push(`reap:${timeoutMs}`);
          return timeoutMs === 2_000;
        },
      },
      [84],
    );

    expect(signals).toEqual([
      { pid: 42, signal: "SIGTERM" },
      { pid: 42, signal: "SIGKILL" },
    ]);
    expect(events).toEqual(["SIGTERM", "wait:12000", "SIGKILL", "reap:2000"]);
  });

  it("fails closed when a POSIX sentinel is gone even after observed processes exit", async () => {
    const child = {
      exitCode: 0,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    await expect(
      terminateProcessTree(child, {
        platform: "darwin",
        sendSignal: (target, signal) => signals.push({ pid: target.pid, signal }),
        targetIsAlive: () => false,
        waitForTargetsExit: async () => true,
      }),
    ).rejects.toThrow("before authoritative whole-group cleanup");

    expect(signals).toEqual([]);
  });

  it("fails closed when the POSIX sentinel vanished without any native outcome", async () => {
    const child = {
      exitCode: 1,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;

    await expect(
      terminateProcessTree(child, {
        platform: "darwin",
      }),
    ).rejects.toThrow("before authoritative whole-group cleanup");
  });

  it("fails closed after observed POSIX descendants exit without proven native completion", async () => {
    const child = {
      exitCode: 1,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;

    await expect(
      terminateProcessTree(
        child,
        {
          platform: "darwin",
          waitForTargetsExit: async () => true,
        },
        [84],
      ),
    ).rejects.toThrow("before authoritative whole-group cleanup");
  });

  it("fails closed when the POSIX sentinel disappears while cleanup is starting", async () => {
    const child = {
      exitCode: null,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;

    await expect(
      terminateProcessTree(
        child,
        {
          platform: "darwin",
          childIsAlive: () => true,
          targetIsAlive: () => false,
          waitForTargetsExit: async () => true,
        },
        [84],
      ),
    ).rejects.toThrow("before authoritative whole-group cleanup");
  });

  it("refuses numeric POSIX signaling after the retained sentinel exits early", async () => {
    const child = {
      exitCode: 0,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    await expect(
      terminateProcessTree(
        child,
        {
          platform: "darwin",
          sendSignal: (target, signal) => signals.push({ pid: target.pid, signal }),
          waitForTargetsExit: async () => false,
        },
        [84],
      ),
    ).rejects.toThrow("refusing numeric signaling authority");
    expect(signals).toEqual([]);
  });

  it("fails closed when the Windows launcher exited but a Job Object descendant survived", async () => {
    const child = {
      exitCode: 0,
      pid: 42,
      signalCode: null,
    } as unknown as ChildProcess;
    const terminateRoot = vi.fn(() => true);

    await expect(
      terminateProcessTree(
        child,
        {
          platform: "win32",
          terminateRoot,
          waitForTargetsExit: async () => false,
        },
        [84],
      ),
    ).rejects.toThrow("survived handle-bound cleanup");
    expect(terminateRoot).not.toHaveBeenCalled();
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
