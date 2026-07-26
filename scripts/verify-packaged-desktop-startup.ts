#!/usr/bin/env node
// FILE: verify-packaged-desktop-startup.ts
// Purpose: Launches an exact collected desktop release payload from isolated temporary state.
// Layer: Release verification script

import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertValidTimestampedWindowsAuthenticodeSignature,
  isWindowsAuthenticodeSignatureDetails,
  WINDOWS_AUTHENTICODE_READER_FUNCTION_LINES,
  type WindowsAuthenticodeSignatureDetails,
} from "./lib/windows-authenticode.ts";

const PACKAGED_NATIVE_CHILD_OUTCOME_FILE = "packaged-native-child-outcome.json";
const POSIX_SENTINEL_PATH = fileURLToPath(
  new URL("./lib/packaged-startup-posix-sentinel.mjs", import.meta.url),
);
const WINDOWS_JOB_LAUNCHER_PATH = fileURLToPath(
  new URL("./lib/packaged-startup-windows-job.ps1", import.meta.url),
);

export type PackagedDesktopPlatform = "mac" | "win";

export interface PackagedDesktopStartupOptions {
  readonly assetsDirectory: string;
  readonly platform: PackagedDesktopPlatform;
  readonly arch: string;
  readonly version: string;
  readonly commit: string;
  readonly timeoutMs: number;
  readonly allowUnsignedWindows?: boolean;
  readonly windowsPublisherSubject?: string;
}

interface TerminationSignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

export function monitorPackagedStartupTermination(source: TerminationSignalSource = process): {
  readonly signal: Promise<NodeJS.Signals>;
  readonly abortSignal: AbortSignal;
  readonly readSignal: () => NodeJS.Signals | null;
  readonly dispose: () => void;
} {
  let observedSignal: NodeJS.Signals | null = null;
  let resolveSignal!: (signal: NodeJS.Signals) => void;
  const signal = new Promise<NodeJS.Signals>((resolve) => {
    resolveSignal = resolve;
  });
  const listeners = new Map<NodeJS.Signals, () => void>();
  const abortController = new AbortController();

  for (const name of ["SIGINT", "SIGTERM"] as const) {
    const listener = () => {
      if (observedSignal !== null) return;
      observedSignal = name;
      abortController.abort(new Error(`Packaged startup verification interrupted by ${name}.`));
      resolveSignal(name);
    };
    listeners.set(name, listener);
    source.on(name, listener);
  }

  return {
    signal,
    abortSignal: abortController.signal,
    readSignal: () => observedSignal,
    dispose: () => {
      for (const [name, listener] of listeners) {
        source.removeListener(name, listener);
      }
      listeners.clear();
    },
  };
}

export function parsePackagedDesktopStartupArgs(
  argv: ReadonlyArray<string>,
): PackagedDesktopStartupOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error(`Invalid packaged startup argument near ${name ?? "<end>"}.`);
    }
    values.set(name, value);
  }

  const known = new Set([
    "--assets-dir",
    "--platform",
    "--arch",
    "--version",
    "--commit",
    "--timeout-ms",
    "--allow-unsigned-windows",
    "--windows-publisher-subject",
  ]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`Unknown packaged startup argument: ${name}.`);
  }

  const required = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`Missing packaged startup argument: ${name}.`);
    return value;
  };

  const platform = required("--platform");
  if (platform !== "mac" && platform !== "win") {
    throw new Error(`Unsupported packaged startup platform: ${platform}.`);
  }
  const arch = required("--arch");
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`Unsupported packaged startup architecture: ${arch}.`);
  }

  const timeoutMs = Number(values.get("--timeout-ms") ?? "60000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 180_000) {
    throw new Error("--timeout-ms must be an integer between 5000 and 180000.");
  }
  const commit = required("--commit").toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("--commit must be a complete 40-character Git commit SHA.");
  }
  const allowUnsignedWindowsValue = values.get("--allow-unsigned-windows") ?? "false";
  if (allowUnsignedWindowsValue !== "true" && allowUnsignedWindowsValue !== "false") {
    throw new Error("--allow-unsigned-windows must be true or false.");
  }
  const windowsPublisherSubject = values.get("--windows-publisher-subject")?.trim();
  if (platform === "win" && allowUnsignedWindowsValue === "false" && !windowsPublisherSubject) {
    throw new Error("Signed Windows startup proof requires --windows-publisher-subject.");
  }

  return {
    assetsDirectory: resolve(required("--assets-dir")),
    platform,
    arch,
    version: required("--version"),
    commit,
    timeoutMs,
    ...(platform === "win"
      ? {
          allowUnsignedWindows: allowUnsignedWindowsValue === "true",
          ...(windowsPublisherSubject ? { windowsPublisherSubject } : {}),
        }
      : {}),
  };
}

const PREPARATION_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const PREPARATION_CLOSE_TIMEOUT_MS = 2_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function runPackagedPreparationCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly signal: AbortSignal;
    readonly spawnProcess?: typeof spawn;
    readonly terminateProcess?: (child: ChildProcess) => Promise<void>;
  },
): Promise<string> {
  if (options.signal.aborted) throw options.signal.reason;
  const child = (options.spawnProcess ?? spawn)(command, [...args], {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  const append = (current: string, chunk: unknown) =>
    `${current}${String(chunk)}`.slice(-PREPARATION_OUTPUT_LIMIT_BYTES);
  child.stdout?.on("data", (chunk) => {
    stdout = append(stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = append(stderr, chunk);
  });
  let spawnError: Error | null = null;
  const closed = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveClosed) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      resolveClosed({ code, signal });
    });
  });
  let abortReason: unknown = null;
  let abortCleanup: Promise<void> | null = null;
  let resolveAbortStarted!: () => void;
  const abortStarted = new Promise<void>((resolveAbort) => {
    resolveAbortStarted = resolveAbort;
  });
  const handleAbort = () => {
    abortReason = options.signal.reason ?? new Error(`${command} preparation was aborted.`);
    abortCleanup ??= Promise.resolve().then(() =>
      (options.terminateProcess ?? terminateProcessTree)(child),
    );
    resolveAbortStarted();
  };
  options.signal.addEventListener("abort", handleAbort, { once: true });
  if (options.signal.aborted) handleAbort();
  let exitOutcome: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null =
    null;
  try {
    exitOutcome = await Promise.race([closed, abortStarted.then(() => null)]);
    if (abortCleanup) {
      try {
        await abortCleanup;
      } catch (cleanupError) {
        throw new AggregateError(
          [abortReason, cleanupError],
          `${command} preparation was interrupted and cleanup failed.`,
        );
      }
      exitOutcome = await Promise.race([
        closed,
        delay(PREPARATION_CLOSE_TIMEOUT_MS).then(() => {
          throw new Error(
            `${command} did not close its stdio within ${PREPARATION_CLOSE_TIMEOUT_MS}ms after cleanup.`,
          );
        }),
      ]);
      throw abortReason;
    }
    exitOutcome ??= await closed;
  } finally {
    options.signal.removeEventListener("abort", handleAbort);
  }
  if (spawnError) throw spawnError;
  if (exitOutcome.code !== 0) {
    const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${exitOutcome.code ?? "unknown"}${exitOutcome.signal ? ` signal ${exitOutcome.signal}` : ""}.${detail ? `\n${detail}` : ""}`,
    );
  }
  return stdout.trim();
}

function findFiles(root: string, predicate: (path: string) => boolean): string[] {
  const matches: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && predicate(candidate)) {
        matches.push(candidate);
      }
    }
  }
  return matches.toSorted((left, right) => left.localeCompare(right));
}

export function expectedPackagedDesktopStartupAssetName(
  platform: PackagedDesktopPlatform,
  arch: string,
  version: string,
): string {
  const extension = platform === "mac" ? ".zip" : ".exe";
  return `Scient-${version}-${arch}${extension}`;
}

export function expectedPackagedDesktopStartupAssetNames(
  platform: PackagedDesktopPlatform,
  arch: string,
  version: string,
): ReadonlyArray<string> {
  const primary = expectedPackagedDesktopStartupAssetName(platform, arch, version);
  return platform === "mac" ? [primary, `Scient-${version}-${arch}.dmg`] : [primary];
}

export function resolveExactPackagedDesktopStartupAsset(
  directory: string,
  expectedName: string,
): string {
  const suffix = expectedName.slice(expectedName.lastIndexOf("."));
  const matches = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => join(directory, entry.name));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly ${expectedName}; found ${matches.length} ${suffix} payloads: ${matches.map((match) => basename(match)).join(", ") || "none"}.`,
    );
  }
  if (basename(matches[0]!) !== expectedName) {
    throw new Error(
      `Expected exact release asset ${expectedName}, found ${basename(matches[0]!)}.`,
    );
  }
  return matches[0]!;
}

export interface PackagedDesktopLaunchCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly cleanup?: () => Promise<void>;
}

export function spawnContainedPackagedDesktop(
  launch: PackagedDesktopLaunchCommand,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: typeof spawn = spawn,
): ChildProcess {
  if (platform === "win32") {
    if (launch.args.length > 0) {
      throw new Error(
        "Windows Job Object launcher does not accept packaged application arguments.",
      );
    }
    const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows";
    const powershell = win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    return spawnProcess(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        WINDOWS_JOB_LAUNCHER_PATH,
        "-ExecutablePath",
        launch.command,
        "-WorkingDirectory",
        launch.cwd,
      ],
      {
        cwd: launch.cwd,
        env: environment,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  }
  return spawnProcess(
    process.execPath,
    [POSIX_SENTINEL_PATH, launch.command, launch.cwd, JSON.stringify(launch.args)],
    {
      cwd: launch.cwd,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}

type PackagedPreparationCommandRunner = typeof runPackagedPreparationCommand;

export async function attachMacDiskImageForInspection(
  archive: string,
  mountPoint: string,
  signal: AbortSignal,
  runCommand: PackagedPreparationCommandRunner = runPackagedPreparationCommand,
): Promise<() => Promise<void>> {
  try {
    await runCommand(
      "hdiutil",
      ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, archive],
      { signal },
    );
  } catch (attachError) {
    // An interrupted attach can mount the image before reporting failure. The
    // command runner fully reaps the helper before rejection, so this detach
    // cannot race a still-running attach.
    try {
      await runCommand("hdiutil", ["detach", "-force", mountPoint], {
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // A detach failure is expected when the image never mounted. Preserve
      // the authoritative attach/cancellation error.
    }
    throw attachError;
  }
  return async () => {
    try {
      await runCommand("hdiutil", ["detach", mountPoint], {
        signal: AbortSignal.timeout(30_000),
      });
    } catch (detachError) {
      try {
        await runCommand("hdiutil", ["detach", "-force", mountPoint], {
          signal: AbortSignal.timeout(30_000),
        });
      } catch (forcedDetachError) {
        throw new AggregateError(
          [detachError, forcedDetachError],
          `Failed to detach ${mountPoint} normally or forcibly.`,
        );
      }
    }
  };
}

export function assertPackagedLaunchCommandSafety(launch: PackagedDesktopLaunchCommand): void {
  const forbiddenArgument = launch.args.find(
    (argument) => argument === "--no-sandbox" || argument.startsWith("--no-sandbox="),
  );
  if (forbiddenArgument) {
    throw new Error(
      `Packaged desktop verification must exercise the real sandboxed command line; refusing ${forbiddenArgument}.`,
    );
  }
}

async function prepareMacLaunch(
  assetsDirectory: string,
  extractionRoot: string,
  expectedAssetName: string,
  options: Pick<PackagedDesktopStartupOptions, "arch" | "version">,
  signal: AbortSignal,
): Promise<PackagedDesktopLaunchCommand> {
  const archive = resolveExactPackagedDesktopStartupAsset(assetsDirectory, expectedAssetName);
  const isDiskImage = expectedAssetName.endsWith(".dmg");
  const cleanup = isDiskImage
    ? await attachMacDiskImageForInspection(archive, extractionRoot, signal)
    : undefined;
  if (!isDiskImage) {
    await runPackagedPreparationCommand("ditto", ["-x", "-k", archive, extractionRoot], { signal });
  }
  try {
    const appBundles = readdirSync(extractionRoot).filter((entry) => entry.endsWith(".app"));
    if (appBundles.length !== 1 || appBundles[0] !== "Scient.app") {
      throw new Error(`Expected the exact Scient.app bundle in ${basename(archive)}.`);
    }
    const appBundle = join(extractionRoot, appBundles[0]!);
    const executables = findFiles(join(appBundle, "Contents", "MacOS"), (candidate) =>
      statSync(candidate).isFile(),
    );
    if (executables.length !== 1) {
      throw new Error(`Expected one macOS main executable, found ${executables.length}.`);
    }
    const infoPlist = join(appBundle, "Contents", "Info.plist");
    const bundleIdentifier = await runPackagedPreparationCommand(
      "plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist],
      { signal },
    );
    const bundleVersion = await runPackagedPreparationCommand(
      "plutil",
      ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPlist],
      { signal },
    );
    const bundleExecutable = await runPackagedPreparationCommand(
      "plutil",
      ["-extract", "CFBundleExecutable", "raw", "-o", "-", infoPlist],
      { signal },
    );
    if (
      bundleIdentifier !== "com.scientfactory.scient" ||
      bundleVersion !== options.version ||
      bundleExecutable !== "Scient"
    ) {
      throw new Error(
        `Unexpected macOS bundle identity id=${bundleIdentifier} version=${bundleVersion} executable=${bundleExecutable}.`,
      );
    }
    const expectedArchitecture = options.arch === "x64" ? "x86_64" : options.arch;
    const executableArchitectures = (
      await runPackagedPreparationCommand("lipo", ["-archs", executables[0]!], {
        signal,
      })
    )
      .split(/\s+/u)
      .filter(Boolean);
    if (
      executableArchitectures.length !== 1 ||
      executableArchitectures[0] !== expectedArchitecture
    ) {
      throw new Error(
        `Expected exact macOS ${expectedArchitecture} executable, found ${executableArchitectures.join(", ") || "unknown"}.`,
      );
    }
    return {
      command: executables[0]!,
      args: [],
      cwd: appBundle,
      ...(cleanup ? { cleanup } : {}),
    };
  } catch (error) {
    if (cleanup) {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Failed to inspect and detach ${basename(archive)}.`,
        );
      }
    }
    throw error;
  }
}

export function isScientWindowsExecutable(candidate: string): boolean {
  return /[/\\]Scient\.exe$/i.test(candidate);
}

export function readWindowsExecutableArchitecture(executable: Uint8Array): string | null {
  if (executable.length < 64 || executable[0] !== 0x4d || executable[1] !== 0x5a) return null;
  const view = new DataView(executable.buffer, executable.byteOffset, executable.byteLength);
  const peOffset = view.getUint32(0x3c, true);
  if (
    peOffset + 6 > executable.length ||
    executable[peOffset] !== 0x50 ||
    executable[peOffset + 1] !== 0x45 ||
    executable[peOffset + 2] !== 0 ||
    executable[peOffset + 3] !== 0
  ) {
    return null;
  }
  const machine = view.getUint16(peOffset + 4, true);
  if (machine === 0x8664) return "x64";
  if (machine === 0xaa64) return "arm64";
  if (machine === 0x014c) return "ia32";
  return null;
}

export type WindowsReleaseSignatureDetails = WindowsAuthenticodeSignatureDetails;

export function assertWindowsReleaseSignatureDetails(
  signatures: ReadonlyArray<WindowsReleaseSignatureDetails>,
  expectedPublisherSubject: string,
): void {
  for (const [index, signature] of signatures.entries()) {
    const label = index === 0 ? "Windows installer" : "Extracted Scient executable";
    const { signerSubject } = assertValidTimestampedWindowsAuthenticodeSignature(signature, label);
    if (signerSubject !== expectedPublisherSubject) {
      throw new Error(
        `${label} publisher ${signature.signerSubject ?? "missing"} does not match ${expectedPublisherSubject}.`,
      );
    }
  }
}

export function assertUnsignedWindowsReleaseSignatureDetails(
  signatures: ReadonlyArray<WindowsReleaseSignatureDetails>,
): void {
  for (const [index, signature] of signatures.entries()) {
    const label = index === 0 ? "Windows installer" : "Extracted Scient executable";
    if (signature.status !== "NotSigned") {
      throw new Error(
        `${label} must be genuinely unsigned, not ${signature.status}: ${signature.statusMessage}.`,
      );
    }
  }
}

const WINDOWS_RELEASE_SIGNATURE_SCRIPT = [
  "param([string]$InstallerPath, [string]$ExecutablePath)",
  "$ErrorActionPreference = 'Stop'",
  ...WINDOWS_AUTHENTICODE_READER_FUNCTION_LINES,
  "@((Read-AuthenticodeSignature $InstallerPath), (Read-AuthenticodeSignature $ExecutablePath)) | ConvertTo-Json -Compress -Depth 4",
].join("\r\n");

async function verifyWindowsReleaseSignatures(
  installer: string,
  executable: string,
  expectedPublisherSubject: string | null,
  extractionRoot: string,
  signal: AbortSignal,
): Promise<void> {
  const scriptPath = join(extractionRoot, "verify-release-signatures.ps1");
  writeFileSync(scriptPath, WINDOWS_RELEASE_SIGNATURE_SCRIPT, { encoding: "utf8", mode: 0o600 });
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const powershell = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const output = await runPackagedPreparationCommand(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-InstallerPath",
      installer,
      "-ExecutablePath",
      executable,
    ],
    { signal },
  );
  const parsed = JSON.parse(output) as ReadonlyArray<WindowsReleaseSignatureDetails>;
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw new Error("Windows Authenticode verifier returned invalid release signature details.");
  }
  if (!parsed.every(isWindowsAuthenticodeSignatureDetails)) {
    throw new Error("Windows Authenticode verifier returned malformed release signature details.");
  }
  if (expectedPublisherSubject === null) {
    assertUnsignedWindowsReleaseSignatureDetails(parsed);
  } else {
    assertWindowsReleaseSignatureDetails(parsed, expectedPublisherSubject);
  }
}

async function prepareWindowsLaunch(
  assetsDirectory: string,
  extractionRoot: string,
  expectedAssetName: string,
  options: Pick<
    PackagedDesktopStartupOptions,
    "arch" | "allowUnsignedWindows" | "windowsPublisherSubject"
  >,
  signal: AbortSignal,
): Promise<PackagedDesktopLaunchCommand> {
  const installer = resolveExactPackagedDesktopStartupAsset(assetsDirectory, expectedAssetName);
  const installerRoot = join(extractionRoot, "installer");
  const applicationRoot = join(extractionRoot, "application");
  mkdirSync(installerRoot, { recursive: true });
  mkdirSync(applicationRoot, { recursive: true });
  await runPackagedPreparationCommand("7z", ["x", "-y", `-o${installerRoot}`, installer], {
    signal,
  });
  const applicationArchives = findFiles(installerRoot, (candidate) =>
    /[/\\]app-(?:32|64|arm64)\.7z$/i.test(candidate),
  );
  if (applicationArchives.length !== 1) {
    throw new Error(
      `Expected one embedded NSIS application archive, found ${applicationArchives.length}.`,
    );
  }
  await runPackagedPreparationCommand(
    "7z",
    ["x", "-y", `-o${applicationRoot}`, applicationArchives[0]!],
    { signal },
  );
  const executables = findFiles(applicationRoot, isScientWindowsExecutable);
  if (executables.length !== 1) {
    throw new Error(`Expected one extracted Scient.exe, found ${executables.length}.`);
  }
  const executableArchitecture = readWindowsExecutableArchitecture(readFileSync(executables[0]!));
  if (executableArchitecture !== options.arch) {
    throw new Error(
      `Expected exact Windows ${options.arch} executable, found ${executableArchitecture ?? "unknown"}.`,
    );
  }
  const expectedPublisherSubject = options.windowsPublisherSubject?.trim() || null;
  if (!options.allowUnsignedWindows && !expectedPublisherSubject) {
    throw new Error("Signed Windows startup proof requires an expected publisher subject.");
  }
  await verifyWindowsReleaseSignatures(
    installer,
    executables[0]!,
    options.allowUnsignedWindows ? null : expectedPublisherSubject,
    extractionRoot,
    signal,
  );
  return { command: executables[0]!, args: [], cwd: dirname(executables[0]!) };
}

async function prepareLaunch(
  options: PackagedDesktopStartupOptions,
  extractionRoot: string,
  expectedAssetName: string,
  signal: AbortSignal,
): Promise<PackagedDesktopLaunchCommand> {
  const launch =
    options.platform === "mac"
      ? await prepareMacLaunch(
          options.assetsDirectory,
          extractionRoot,
          expectedAssetName,
          options,
          signal,
        )
      : await prepareWindowsLaunch(
          options.assetsDirectory,
          extractionRoot,
          expectedAssetName,
          options,
          signal,
        );
  assertPackagedLaunchCommandSafety(launch);
  return launch;
}

export function createPackagedDesktopSmokeEnvironment(
  root: string,
  options: Pick<PackagedDesktopStartupOptions, "platform" | "version">,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const isolatedHome = join(root, "home");
  const scientHome = join(root, "scient-home");
  const env = sanitizePackagedDesktopInheritedEnvironment(inheritedEnvironment);
  Object.assign(env, {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_RUNTIME_DIR: join(root, "xdg-runtime"),
    TEMP: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TMPDIR: join(root, "tmp"),
    SCIENT_HOME: scientHome,
    SCIENT_DISABLE_SHELL_ENV_SYNC: "1",
    SCIENT_PACKAGED_STARTUP_SMOKE: "1",
    SYNARA_DISABLE_AUTO_UPDATE: "1",
    SYNARA_TELEMETRY_ENABLED: "false",
    ELECTRON_ENABLE_LOGGING: "1",
  });
  for (const path of [
    env.HOME,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_DATA_HOME,
    env.TEMP,
    env.SCIENT_HOME,
  ]) {
    if (path) mkdirSync(path, { recursive: true });
  }
  if (env.XDG_RUNTIME_DIR) {
    mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(env.XDG_RUNTIME_DIR, 0o700);
  }

  if (options.platform === "mac") {
    const userDataPath = join(isolatedHome, "Library", "Application Support", "scient");
    mkdirSync(userDataPath, { recursive: true });
    // Prevent the packaged app's update-only icon repair from registering this
    // temporary bundle in the runner's normal Launch Services database.
    const launchVersionPath = join(userDataPath, "last-launch-version.json");
    writeFileSync(launchVersionPath, `${JSON.stringify({ version: options.version }, null, 2)}\n`);
  }
  return env;
}

const PACKAGED_SMOKE_INHERITED_ENVIRONMENT_ALLOWLIST = new Set([
  "COMSPEC",
  "ComSpec",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "PATHEXT",
  "Path",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "XAUTHORITY",
  "XDG_CURRENT_DESKTOP",
  "XDG_DATA_DIRS",
  "XDG_SESSION_TYPE",
  "windir",
]);

export function sanitizePackagedDesktopInheritedEnvironment(
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(inheritedEnvironment).filter(
      ([name, value]) =>
        value !== undefined && PACKAGED_SMOKE_INHERITED_ENVIRONMENT_ALLOWLIST.has(name),
    ),
  );
}

export function resolvePackagedDesktopLogPath(environment: NodeJS.ProcessEnv): string {
  const scientHome = environment.SCIENT_HOME;
  if (!scientHome) throw new Error("Packaged startup smoke requires an isolated SCIENT_HOME.");
  return join(scientHome, "userdata", "logs", "desktop-main.log");
}

export interface ProcessTerminationTarget {
  readonly pid: number;
  readonly processGroup: boolean;
}

export interface ProcessTerminationDependencies {
  readonly platform?: NodeJS.Platform;
  readonly childIsAlive?: (child: ChildProcess) => boolean;
  readonly terminateRoot?: (child: ChildProcess) => boolean;
  readonly sendSignal?: (target: ProcessTerminationTarget, signal: NodeJS.Signals) => void;
  readonly targetIsAlive?: (target: ProcessTerminationTarget) => boolean;
  readonly waitForPosixPayloadExit?: (timeoutMs: number) => Promise<boolean>;
  readonly waitForTargetsExit?: (
    targets: ReadonlyArray<ProcessTerminationTarget>,
    timeoutMs: number,
  ) => Promise<boolean>;
}

const POSIX_DESKTOP_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 12_000;
const WINDOWS_JOB_CLOSE_TIMEOUT_MS = 5_000;

function childProcessHandleIsAlive(child: ChildProcess): boolean {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
  try {
    // ChildProcess.kill uses the spawned process handle on Windows, avoiding a
    // decision based solely on an asynchronously updated exitCode or reused PID.
    return child.kill(0);
  } catch {
    return false;
  }
}

function processTerminationTargetIsAlive(target: ProcessTerminationTarget): boolean {
  try {
    process.kill(target.processGroup ? -target.pid : target.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function waitForProcessTerminationTargets(
  targets: ReadonlyArray<ProcessTerminationTarget>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveExit) => {
    const poll = () => {
      if (targets.every((target) => !processTerminationTargetIsAlive(target))) {
        resolveExit(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolveExit(false);
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

function sendProcessTreeSignal(target: ProcessTerminationTarget, signal: NodeJS.Signals): void {
  try {
    process.kill(target.processGroup ? -target.pid : target.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function terminateProcessTree(
  child: ChildProcess,
  dependencies: ProcessTerminationDependencies = {},
  additionalProcessIds: ReadonlyArray<number> = [],
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;
  const childCanStillOwnProcesses =
    (dependencies.childIsAlive ?? childProcessHandleIsAlive)(child) &&
    child.exitCode === null &&
    child.signalCode === null;
  const rootTarget: ProcessTerminationTarget | null =
    child.pid && childCanStillOwnProcesses
      ? { pid: child.pid, processGroup: platform !== "win32" }
      : null;
  // Backend PIDs recovered from logs/runtime state are observation-only. The
  // retained POSIX sentinel group or Windows kill-on-close Job Object owns
  // every descendant; numeric backend PIDs are never signaling authority.
  const observedTargets = additionalProcessIds
    .map((pid) => ({ pid, processGroup: false }))
    .filter(
      (target, index, allTargets) =>
        target.pid > 0 &&
        allTargets.findIndex((candidate) => candidate.pid === target.pid) === index,
    );
  const targets = [
    ...(rootTarget ? [rootTarget] : []),
    ...observedTargets.filter((target) => target.pid !== rootTarget?.pid),
  ];
  if (targets.length === 0) return;
  const awaitTargetsExit = dependencies.waitForTargetsExit ?? waitForProcessTerminationTargets;
  if (platform === "win32") {
    // The ChildProcess handle belongs to the verifier-only PowerShell job
    // launcher. Terminating that handle closes its kill-on-close Job Object,
    // atomically terminating Electron and every descendant without PID lookup.
    if (rootTarget) {
      const terminated = dependencies.terminateRoot?.(child) ?? child.kill();
      if (!terminated) {
        throw new Error("Packaged Windows Job Object launcher could not be terminated by handle.");
      }
    }
    if (await awaitTargetsExit(targets, WINDOWS_JOB_CLOSE_TIMEOUT_MS)) return;
    throw new Error(
      `Packaged Windows Job Object tree survived handle-bound cleanup; observed processes ${targets.map(({ pid }) => pid).join(", ")}.`,
    );
  }

  if (!rootTarget) {
    if (await awaitTargetsExit(targets, 2_000)) return;
    throw new Error(
      `Packaged POSIX sentinel exited before cleanup while observed descendants ${targets.map(({ pid }) => pid).join(", ")} remained; refusing numeric signaling authority.`,
    );
  }
  const sendSignal = dependencies.sendSignal ?? sendProcessTreeSignal;
  const targetIsAlive = dependencies.targetIsAlive ?? processTerminationTargetIsAlive;
  if (!targetIsAlive(rootTarget)) {
    if (await awaitTargetsExit(targets, 2_000)) return;
    throw new Error("Packaged POSIX sentinel disappeared before its descendants were reaped.");
  }
  sendSignal(rootTarget, "SIGTERM");
  // The sentinel ignores TERM and remains the original process-group member
  // while Electron performs its bounded graceful backend shutdown. Once the
  // native payload exits (or the deadline expires), KILL targets a group whose
  // identity cannot have been recycled because the sentinel still occupies it.
  await (dependencies.waitForPosixPayloadExit?.(POSIX_DESKTOP_GRACEFUL_SHUTDOWN_TIMEOUT_MS) ??
    awaitTargetsExit(observedTargets, POSIX_DESKTOP_GRACEFUL_SHUTDOWN_TIMEOUT_MS));
  if (targetIsAlive(rootTarget)) sendSignal(rootTarget, "SIGKILL");
  if (await awaitTargetsExit(targets, 2_000)) return;
  throw new Error(
    `Packaged process trees ${targets.map(({ pid }) => pid).join(", ")} survived authoritative SIGTERM and SIGKILL cleanup.`,
  );
}

export function hasPackagedStartupProof(
  logPath: string,
  expected?: Pick<PackagedDesktopStartupOptions, "version" | "commit">,
): boolean {
  try {
    const log = readFileSync(logPath, "utf8");
    const expectedIdentity = expected
      ? `packaged identity name=Scient version=${expected.version} commit=${expected.commit}`
      : "packaged identity name=Scient";
    return (
      log.includes("app ready") &&
      log.includes(expectedIdentity) &&
      log.includes("bootstrap main window created") &&
      log.includes("packaged main window visible") &&
      log.includes("renderer main frame loaded") &&
      log.includes("backend semantic ready generation=") &&
      log.includes("packaged responsiveness confirmed generation=") &&
      !log.includes("renderer main frame load failed") &&
      !log.includes("renderer main process gone") &&
      !log.includes("renderer main window unresponsive") &&
      !log.includes("packaged responsiveness failed") &&
      !log.includes("backend process exited generation=")
    );
  } catch {
    return false;
  }
}

export function readPackagedBackendProcessIds(environment: NodeJS.ProcessEnv | null): number[] {
  const scientHome = environment?.SCIENT_HOME;
  if (!scientHome) return [];
  const processIds = new Set<number>();
  let runtimeProcessId: number | null = null;
  try {
    const state = JSON.parse(
      readFileSync(join(scientHome, "userdata", "server-runtime.json"), "utf8"),
    ) as { readonly pid?: unknown };
    if (Number.isInteger(state.pid) && Number(state.pid) > 0) {
      runtimeProcessId = Number(state.pid);
    }
  } catch {
    // Startup may fail before the runtime-state file is durable. The desktop
    // main log records every backend PID immediately after spawn as a fallback.
  }
  const observedProcessIds = new Set<number>();
  const activeSpawnedProcessIds = new Set<number>();
  try {
    const log = readFileSync(resolvePackagedDesktopLogPath(environment), "utf8");
    for (const line of log.split(/\r?\n/gu)) {
      const spawned = line.match(/backend process spawned generation=\d+ pid=(\d+)/u)?.[1];
      const exited = line.match(/backend process exited generation=\d+ pid=(\d+)/u)?.[1];
      if (spawned !== undefined) {
        const processId = Number(spawned);
        if (Number.isInteger(processId) && processId > 0) {
          observedProcessIds.add(processId);
          activeSpawnedProcessIds.add(processId);
        }
      }
      if (exited !== undefined) {
        const processId = Number(exited);
        if (Number.isInteger(processId) && processId > 0) {
          observedProcessIds.add(processId);
          activeSpawnedProcessIds.delete(processId);
        }
      }
    }
  } catch {
    // No backend was observed yet.
  }
  // Never signal a PID that the same fresh-run log proves already exited: the
  // OS may have reused it for an unrelated process by the time cleanup runs.
  if (
    runtimeProcessId !== null &&
    (!observedProcessIds.has(runtimeProcessId) || activeSpawnedProcessIds.has(runtimeProcessId))
  ) {
    processIds.add(runtimeProcessId);
  }
  for (const processId of activeSpawnedProcessIds) processIds.add(processId);
  return [...processIds];
}

export interface PackagedDesktopChildOutcome {
  readonly exited: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  } | null;
  readonly launchError: Error | null;
}

export function resolvePackagedNativeChildOutcomePath(environment: NodeJS.ProcessEnv): string {
  const scientHome = environment.SCIENT_HOME?.trim();
  if (!scientHome) throw new Error("Packaged startup smoke requires an isolated SCIENT_HOME.");
  return join(scientHome, PACKAGED_NATIVE_CHILD_OUTCOME_FILE);
}

export function readPackagedNativeChildOutcome(
  environment: NodeJS.ProcessEnv,
): PackagedDesktopChildOutcome {
  try {
    const parsed = JSON.parse(
      readFileSync(resolvePackagedNativeChildOutcomePath(environment), "utf8"),
    ) as {
      readonly exited?: { readonly code?: unknown; readonly signal?: unknown } | null;
      readonly launchError?: { readonly message?: unknown } | null;
    };
    const exited = parsed.exited;
    const launchError = parsed.launchError;
    if (
      exited &&
      (typeof exited.code === "number" || exited.code === null) &&
      (typeof exited.signal === "string" || exited.signal === null) &&
      launchError === null
    ) {
      return {
        exited: {
          code: exited.code,
          signal: exited.signal as NodeJS.Signals | null,
        },
        launchError: null,
      };
    }
    if (exited === null && launchError && typeof launchError.message === "string") {
      return { exited: null, launchError: new Error(launchError.message) };
    }
    return { exited: null, launchError: new Error("Malformed packaged native child outcome.") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exited: null, launchError: null };
    }
    return {
      exited: null,
      launchError: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

async function waitForPackagedNativeChildOutcome(
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const outcome = readPackagedNativeChildOutcome(environment);
    if (outcome.exited || outcome.launchError) return true;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  return false;
}

export function readPackagedDesktopLogTail(logPath: string, maxCharacters = 200_000): string {
  try {
    return readFileSync(logPath, "utf8").slice(-maxCharacters).trim();
  } catch {
    return "";
  }
}

export function formatPackagedStartupFailures(
  failures: ReadonlyArray<{ readonly phase: string; readonly error: unknown }>,
  output: string,
  logTail: string,
): string {
  const failureDetail = failures
    .map(
      ({ phase, error }) => `${phase}: ${error instanceof Error ? error.message : String(error)}`,
    )
    .join("\n");
  const processDetail = output.trim() ? `\nPackaged process output:\n${output.trim()}` : "";
  const logDetail = logTail ? `\nPackaged desktop log tail:\n${logTail}` : "";
  return `${failureDetail}${processDetail}${logDetail}`;
}

function redactPackagedStartupDiagnostic(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/([?&](?:token|key|secret|code)=)[^&\s]+/giu, "$1[REDACTED]");
}

export function writePackagedStartupFailureDiagnostics(
  diagnosticsDirectory: string,
  details: string,
): string {
  const resolvedDirectory = resolve(diagnosticsDirectory);
  mkdirSync(resolvedDirectory, { recursive: true });
  const diagnosticPath = join(resolvedDirectory, "packaged-startup-failure.txt");
  writeFileSync(diagnosticPath, `${redactPackagedStartupDiagnostic(details).slice(-400_000)}\n`, {
    mode: 0o600,
  });
  return diagnosticPath;
}

interface PackagedStartupProofWaitOptions {
  readonly timeoutMs: number;
  readonly hasProof: () => boolean;
  readonly readOutcome: () => PackagedDesktopChildOutcome;
  /** Authoritative process-handle probe used when exit events lag behind OS state. */
  readonly isProcessAlive?: () => boolean;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly stableForMs?: number;
}

export async function waitForPackagedStartupProof({
  timeoutMs,
  hasProof,
  readOutcome,
  isProcessAlive = () => true,
  now = Date.now,
  delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
  stableForMs = 1_000,
}: PackagedStartupProofWaitOptions): Promise<void> {
  const deadline = now() + timeoutMs;
  let proofObservedAt: number | null = null;
  while (now() < deadline) {
    const outcome = readOutcome();
    if (outcome.launchError) {
      throw new Error(`Packaged app could not start: ${outcome.launchError.message}`);
    }
    if (outcome.exited) {
      throw new Error(
        `Packaged app exited before stable startup proof (code=${outcome.exited.code ?? "null"}, signal=${outcome.exited.signal ?? "null"}).`,
      );
    }
    if (!isProcessAlive()) {
      throw new Error(
        "Packaged app exited before stable startup proof (process handle is closed).",
      );
    }
    const currentTime = now();
    if (hasProof()) {
      proofObservedAt ??= currentTime;
      if (currentTime - proofObservedAt >= stableForMs) {
        // Recheck at the acceptance boundary: Windows can close the process
        // handle before Node delivers the asynchronous `exit` event.
        if (!isProcessAlive()) {
          throw new Error(
            "Packaged app exited before stable startup proof (process handle is closed).",
          );
        }
        return;
      }
    } else {
      proofObservedAt = null;
    }
    await delay(Math.min(200, Math.max(1, deadline - currentTime)));
  }
  throw new Error(`Packaged startup proof timed out after ${timeoutMs}ms.`);
}

export function resolveNativePackagedDesktopPlatform(
  platform: NodeJS.Platform,
): PackagedDesktopPlatform | null {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  return null;
}

async function verifyPackagedDesktopPayload(
  options: PackagedDesktopStartupOptions,
  expectedAssetName: string,
): Promise<void> {
  const nativePlatform = resolveNativePackagedDesktopPlatform(process.platform);
  if (nativePlatform !== options.platform) {
    throw new Error(
      `Packaged ${options.platform} startup smoke must run on its native host, not ${process.platform}.`,
    );
  }

  const temporaryRoot = mkdtempSync(
    join(
      tmpdir(),
      `scient-packaged-smoke-${options.platform}-${expectedAssetName.endsWith(".dmg") ? "dmg" : "primary"}-`,
    ),
  );
  const extractionRoot = join(temporaryRoot, "payload");
  mkdirSync(extractionRoot, { recursive: true });

  let child: ChildProcess | null = null;
  let launch: PackagedDesktopLaunchCommand | null = null;
  let environment: NodeJS.ProcessEnv | null = null;
  let logPath: string | null = null;
  let output = "";
  const failures: Array<{ phase: string; error: unknown }> = [];
  const termination = monitorPackagedStartupTermination();
  try {
    const preparationSignal = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs),
      termination.abortSignal,
    ]);
    launch = await prepareLaunch(options, extractionRoot, expectedAssetName, preparationSignal);
    if (preparationSignal.aborted) throw preparationSignal.reason;
    environment = createPackagedDesktopSmokeEnvironment(join(temporaryRoot, "state"), options);
    const launchLogPath = resolvePackagedDesktopLogPath(environment);
    logPath = launchLogPath;
    child = spawnContainedPackagedDesktop(launch, environment);

    const childOutcome: {
      exited: PackagedDesktopChildOutcome["exited"];
      launchError: PackagedDesktopChildOutcome["launchError"];
    } = { exited: null, launchError: null };
    child.once("exit", (code, signal) => {
      childOutcome.exited = { code, signal };
    });
    child.once("error", (error) => {
      childOutcome.launchError = error;
    });
    const recordOutput = (chunk: unknown) => {
      output = `${output}${String(chunk)}`.slice(-200_000);
    };
    child.stdout?.on("data", recordOutput);
    child.stderr?.on("data", recordOutput);

    await Promise.race([
      waitForPackagedStartupProof({
        timeoutMs: options.timeoutMs,
        hasProof: () => hasPackagedStartupProof(launchLogPath, options),
        readOutcome: () => {
          if (process.platform === "win32") return childOutcome;
          const payloadOutcome = readPackagedNativeChildOutcome(environment!);
          return payloadOutcome.exited || payloadOutcome.launchError
            ? payloadOutcome
            : childOutcome;
        },
        isProcessAlive: () => childProcessHandleIsAlive(child!),
      }),
      termination.signal.then((signal) => {
        throw new Error(`Packaged startup verification interrupted by ${signal}.`);
      }),
    ]);
  } catch (error) {
    failures.push({ phase: "startup verification failed", error });
  }

  let processCleanupFailed = false;
  try {
    if (child) {
      await terminateProcessTree(
        child,
        {
          ...(process.platform !== "win32" && environment
            ? {
                waitForPosixPayloadExit: (timeoutMs: number) =>
                  waitForPackagedNativeChildOutcome(environment!, timeoutMs),
              }
            : {}),
        },
        readPackagedBackendProcessIds(environment),
      );
    }
  } catch (error) {
    processCleanupFailed = true;
    failures.push({ phase: "process cleanup failed", error });
  }

  if (launch?.cleanup) {
    try {
      await launch.cleanup();
    } catch (error) {
      processCleanupFailed = true;
      failures.push({ phase: "payload unmount failed", error });
    }
  }

  const interruptedBy = termination.readSignal();
  termination.dispose();
  if (
    interruptedBy !== null &&
    failures.every((failure) => failure.phase !== "startup verification failed")
  ) {
    failures.push({
      phase: "startup verification failed",
      error: new Error(`Packaged startup verification interrupted by ${interruptedBy}.`),
    });
  }

  // Capture diagnostics after cleanup attempts but before deleting isolated state.
  const logTail = logPath ? readPackagedDesktopLogTail(logPath) : "";
  if (processCleanupFailed) {
    failures.push({
      phase: "temporary-state cleanup skipped",
      error: new Error(`Preserved failed process evidence at ${temporaryRoot}.`),
    });
  } else {
    try {
      rmSync(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      failures.push({
        phase: `temporary-state cleanup failed at ${temporaryRoot}`,
        error,
      });
    }
  }

  if (failures.length > 0) {
    const details = formatPackagedStartupFailures(failures, output, logTail);
    const diagnosticsDirectory = process.env.SCIENT_PACKAGED_STARTUP_DIAGNOSTICS_DIR?.trim();
    if (diagnosticsDirectory) {
      try {
        writePackagedStartupFailureDiagnostics(diagnosticsDirectory, details);
      } catch (error) {
        failures.push({ phase: "failure-diagnostic export failed", error });
      }
    }
    throw new Error(
      redactPackagedStartupDiagnostic(formatPackagedStartupFailures(failures, output, logTail)),
    );
  }
  console.log(
    `Packaged ${options.platform}/${options.arch} startup smoke passed for ${expectedAssetName} from isolated Scient state.`,
  );
}

export async function verifyPackagedDesktopStartup(
  options: PackagedDesktopStartupOptions,
): Promise<void> {
  for (const expectedAssetName of expectedPackagedDesktopStartupAssetNames(
    options.platform,
    options.arch,
    options.version,
  )) {
    await verifyPackagedDesktopPayload(options, expectedAssetName);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await verifyPackagedDesktopStartup(parsePackagedDesktopStartupArgs(process.argv.slice(2)));
}
