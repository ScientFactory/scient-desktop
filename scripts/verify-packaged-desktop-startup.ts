#!/usr/bin/env node
// FILE: verify-packaged-desktop-startup.ts
// Purpose: Launches an exact collected desktop release payload from isolated temporary state.
// Layer: Release verification script

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PackagedDesktopPlatform = "mac" | "win";

export interface PackagedDesktopStartupOptions {
  readonly assetsDirectory: string;
  readonly platform: PackagedDesktopPlatform;
  readonly arch: string;
  readonly version: string;
  readonly commit: string;
  readonly timeoutMs: number;
}

interface TerminationSignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

export function monitorPackagedStartupTermination(source: TerminationSignalSource = process): {
  readonly signal: Promise<NodeJS.Signals>;
  readonly readSignal: () => NodeJS.Signals | null;
  readonly dispose: () => void;
} {
  let observedSignal: NodeJS.Signals | null = null;
  let resolveSignal!: (signal: NodeJS.Signals) => void;
  const signal = new Promise<NodeJS.Signals>((resolve) => {
    resolveSignal = resolve;
  });
  const listeners = new Map<NodeJS.Signals, () => void>();

  for (const name of ["SIGINT", "SIGTERM"] as const) {
    const listener = () => {
      if (observedSignal !== null) return;
      observedSignal = name;
      resolveSignal(name);
    };
    listeners.set(name, listener);
    source.once(name, listener);
  }

  return {
    signal,
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

  return {
    assetsDirectory: resolve(required("--assets-dir")),
    platform,
    arch,
    version: required("--version"),
    commit,
    timeoutMs,
  };
}

function runCommand(command: string, args: ReadonlyArray<string>, cwd?: string): void {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const detail = output ? `\n${output}` : "";
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}.${detail}`,
    );
  }
}

function runTextCommand(command: string, args: ReadonlyArray<string>, cwd?: string): string {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${result.error ? `: ${result.error.message}` : ` with exit ${result.status ?? "unknown"}`}${detail ? `\n${detail}` : ""}`,
    );
  }
  return result.stdout.trim();
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

function prepareMacLaunch(
  assetsDirectory: string,
  extractionRoot: string,
  expectedAssetName: string,
  options: Pick<PackagedDesktopStartupOptions, "arch" | "version">,
): PackagedDesktopLaunchCommand {
  const archive = resolveExactPackagedDesktopStartupAsset(assetsDirectory, expectedAssetName);
  runCommand("ditto", ["-x", "-k", archive, extractionRoot]);
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
  const bundleIdentifier = runTextCommand("plutil", [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    infoPlist,
  ]);
  const bundleVersion = runTextCommand("plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    "-o",
    "-",
    infoPlist,
  ]);
  const bundleExecutable = runTextCommand("plutil", [
    "-extract",
    "CFBundleExecutable",
    "raw",
    "-o",
    "-",
    infoPlist,
  ]);
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
  const executableArchitectures = runTextCommand("lipo", ["-archs", executables[0]!])
    .split(/\s+/u)
    .filter(Boolean);
  if (executableArchitectures.length !== 1 || executableArchitectures[0] !== expectedArchitecture) {
    throw new Error(
      `Expected exact macOS ${expectedArchitecture} executable, found ${executableArchitectures.join(", ") || "unknown"}.`,
    );
  }
  return { command: executables[0]!, args: [], cwd: appBundle };
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

function prepareWindowsLaunch(
  assetsDirectory: string,
  extractionRoot: string,
  expectedAssetName: string,
  options: Pick<PackagedDesktopStartupOptions, "arch">,
): PackagedDesktopLaunchCommand {
  const installer = resolveExactPackagedDesktopStartupAsset(assetsDirectory, expectedAssetName);
  const installerRoot = join(extractionRoot, "installer");
  const applicationRoot = join(extractionRoot, "application");
  mkdirSync(installerRoot, { recursive: true });
  mkdirSync(applicationRoot, { recursive: true });
  runCommand("7z", ["x", "-y", `-o${installerRoot}`, installer]);
  const applicationArchives = findFiles(installerRoot, (candidate) =>
    /[/\\]app-(?:32|64|arm64)\.7z$/i.test(candidate),
  );
  if (applicationArchives.length !== 1) {
    throw new Error(
      `Expected one embedded NSIS application archive, found ${applicationArchives.length}.`,
    );
  }
  runCommand("7z", ["x", "-y", `-o${applicationRoot}`, applicationArchives[0]!]);
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
  return { command: executables[0]!, args: [], cwd: dirname(executables[0]!) };
}

function prepareLaunch(
  options: PackagedDesktopStartupOptions,
  extractionRoot: string,
): PackagedDesktopLaunchCommand {
  const expectedAssetName = expectedPackagedDesktopStartupAssetName(
    options.platform,
    options.arch,
    options.version,
  );
  const launch =
    options.platform === "mac"
      ? prepareMacLaunch(options.assetsDirectory, extractionRoot, expectedAssetName, options)
      : prepareWindowsLaunch(options.assetsDirectory, extractionRoot, expectedAssetName, options);
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
  readonly runTaskkill?: (
    pid: number,
    timeoutMs: number,
  ) => {
    readonly error?: Error;
    readonly status: number | null;
  };
  readonly sendSignal?: (target: ProcessTerminationTarget, signal: NodeJS.Signals) => void;
  readonly targetIsAlive?: (target: ProcessTerminationTarget) => boolean;
  readonly waitForTargetsExit?: (
    targets: ReadonlyArray<ProcessTerminationTarget>,
    timeoutMs: number,
  ) => Promise<boolean>;
}

const POSIX_DESKTOP_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 12_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

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
  const rootTarget =
    child.pid && childCanStillOwnProcesses
      ? { pid: child.pid, processGroup: platform !== "win32" }
      : null;
  // A POSIX process group can outlive its leader. Once the ChildProcess reports
  // exit we no longer have durable signal authority, but we must still observe
  // that original group before declaring cleanup complete and deleting evidence.
  const exitedRootGroupTarget =
    platform !== "win32" && child.pid && !rootTarget
      ? { pid: child.pid, processGroup: true }
      : null;
  // Backend PIDs recovered from logs/runtime state are observation-only. They
  // prove cleanup completion, but a bare PID is not durable signal authority:
  // the OS may reuse it after an unlogged exit.
  const observedTargets = additionalProcessIds
    .map((pid) => ({ pid, processGroup: platform !== "win32" }))
    .filter(
      (target, index, allTargets) =>
        target.pid > 0 &&
        allTargets.findIndex((candidate) => candidate.pid === target.pid) === index,
    );
  const targets = [
    ...(rootTarget ? [rootTarget] : []),
    ...(exitedRootGroupTarget ? [exitedRootGroupTarget] : []),
    ...observedTargets.filter(
      (target) => target.pid !== (rootTarget?.pid ?? exitedRootGroupTarget?.pid),
    ),
  ];
  if (targets.length === 0) return;
  const awaitTargetsExit = dependencies.waitForTargetsExit ?? waitForProcessTerminationTargets;
  if (!rootTarget) {
    if (await awaitTargetsExit(targets, 5_000)) return;
    throw new Error(
      `Recorded process candidates ${targets.map(({ pid }) => pid).join(", ")} remained after their parent exited; refusing to signal unverified PIDs or process groups.`,
    );
  }
  if (platform === "win32") {
    // The live ChildProcess handle establishes root ownership; taskkill /T
    // derives descendants from that root. Never signal observation-only PIDs.
    const taskkillResult =
      dependencies.runTaskkill?.(rootTarget.pid, WINDOWS_TASKKILL_TIMEOUT_MS) ??
      spawnSync("taskkill", ["/pid", String(rootTarget.pid), "/t", "/f"], {
        stdio: "ignore",
        timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
        windowsHide: true,
      });
    if (await awaitTargetsExit(targets, 5_000)) return;
    const taskkillDetail = taskkillResult.error
      ? `could not start (${taskkillResult.error.message})`
      : `status ${taskkillResult.status ?? "unknown"}`;
    throw new Error(
      `Packaged process trees survived Windows cleanup; root ${rootTarget.pid} taskkill ${taskkillDetail}.`,
    );
  }
  const sendSignal = dependencies.sendSignal ?? sendProcessTreeSignal;
  sendSignal(rootTarget, "SIGTERM");
  // The desktop owns a bounded backend shutdown that can legitimately take up
  // to ten seconds. Preserve its supervisor until that bound has elapsed so it
  // can terminate the backend's separate process group itself.
  if (await awaitTargetsExit(targets, POSIX_DESKTOP_GRACEFUL_SHUTDOWN_TIMEOUT_MS)) return;
  const childStillOwnsRoot =
    child.pid === rootTarget.pid &&
    child.exitCode === null &&
    child.signalCode === null &&
    (dependencies.childIsAlive ?? childProcessHandleIsAlive)(child);
  if (!childStillOwnsRoot) {
    throw new Error(
      `Packaged root ${rootTarget.pid} exited before POSIX escalation; refusing to signal a potentially reused process group.`,
    );
  }
  const targetIsAlive = dependencies.targetIsAlive ?? processTerminationTargetIsAlive;
  if (targetIsAlive(rootTarget)) sendSignal(rootTarget, "SIGKILL");
  if (await awaitTargetsExit(targets, 2_000)) return;
  throw new Error(
    `Packaged process trees ${targets.map(({ pid }) => pid).join(", ")} survived root-only SIGTERM and SIGKILL; refusing to signal unverified backend PIDs.`,
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
  readonly exited: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null;
  readonly launchError: Error | null;
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

export async function verifyPackagedDesktopStartup(
  options: PackagedDesktopStartupOptions,
): Promise<void> {
  const nativePlatform = resolveNativePackagedDesktopPlatform(process.platform);
  if (nativePlatform !== options.platform) {
    throw new Error(
      `Packaged ${options.platform} startup smoke must run on its native host, not ${process.platform}.`,
    );
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), `scient-packaged-smoke-${options.platform}-`));
  const extractionRoot = join(temporaryRoot, "payload");
  mkdirSync(extractionRoot, { recursive: true });

  let child: ChildProcess | null = null;
  let environment: NodeJS.ProcessEnv | null = null;
  let logPath: string | null = null;
  let output = "";
  const failures: Array<{ phase: string; error: unknown }> = [];
  const termination = monitorPackagedStartupTermination();
  try {
    const launch = prepareLaunch(options, extractionRoot);
    environment = createPackagedDesktopSmokeEnvironment(join(temporaryRoot, "state"), options);
    const launchLogPath = resolvePackagedDesktopLogPath(environment);
    logPath = launchLogPath;
    child = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env: environment,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

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
        readOutcome: () => childOutcome,
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
      await terminateProcessTree(child, {}, readPackagedBackendProcessIds(environment));
    }
  } catch (error) {
    processCleanupFailed = true;
    failures.push({ phase: "process cleanup failed", error });
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
      failures.push({ phase: `temporary-state cleanup failed at ${temporaryRoot}`, error });
    }
  }

  if (failures.length > 0) {
    throw new Error(formatPackagedStartupFailures(failures, output, logTail), {
      cause: failures[0]?.error,
    });
  }
  console.log(
    `Packaged ${options.platform}/${options.arch} startup smoke passed from isolated Scient state.`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await verifyPackagedDesktopStartup(parsePackagedDesktopStartupArgs(process.argv.slice(2)));
}
