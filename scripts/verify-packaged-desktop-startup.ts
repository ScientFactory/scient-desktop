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
  readonly timeoutMs: number;
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

  const known = new Set(["--assets-dir", "--platform", "--arch", "--version", "--timeout-ms"]);
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

  const timeoutMs = Number(values.get("--timeout-ms") ?? "60000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 180_000) {
    throw new Error("--timeout-ms must be an integer between 5000 and 180000.");
  }

  return {
    assetsDirectory: resolve(required("--assets-dir")),
    platform,
    arch: required("--arch"),
    version: required("--version"),
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
): PackagedDesktopLaunchCommand {
  const archive = resolveExactPackagedDesktopStartupAsset(assetsDirectory, expectedAssetName);
  runCommand("ditto", ["-x", "-k", archive, extractionRoot]);
  const appBundles = readdirSync(extractionRoot).filter((entry) => entry.endsWith(".app"));
  if (appBundles.length !== 1) {
    throw new Error(`Expected one packaged macOS app in ${basename(archive)}.`);
  }
  const appBundle = join(extractionRoot, appBundles[0]!);
  const executables = findFiles(join(appBundle, "Contents", "MacOS"), (candidate) =>
    statSync(candidate).isFile(),
  );
  if (executables.length !== 1) {
    throw new Error(`Expected one macOS main executable, found ${executables.length}.`);
  }
  return { command: executables[0]!, args: [], cwd: appBundle };
}

export function isScientWindowsExecutable(candidate: string): boolean {
  return /[/\\]Scient\.exe$/i.test(candidate);
}

function prepareWindowsLaunch(
  assetsDirectory: string,
  extractionRoot: string,
  expectedAssetName: string,
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
      ? prepareMacLaunch(options.assetsDirectory, extractionRoot, expectedAssetName)
      : prepareWindowsLaunch(options.assetsDirectory, extractionRoot, expectedAssetName);
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
    SCIENT_HOME: scientHome,
    SCIENT_DISABLE_SHELL_ENV_SYNC: "1",
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
  readonly runTaskkill?: (pid: number) => {
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
    platform !== "win32" ||
    ((dependencies.childIsAlive ?? childProcessHandleIsAlive)(child) &&
      child.exitCode === null &&
      child.signalCode === null);
  const targets = [
    ...(child.pid && childCanStillOwnProcesses
      ? [{ pid: child.pid, processGroup: platform !== "win32" }]
      : []),
    ...additionalProcessIds.map((pid) => ({ pid, processGroup: platform !== "win32" })),
  ].filter(
    (target, index, allTargets) =>
      target.pid > 0 && allTargets.findIndex((candidate) => candidate.pid === target.pid) === index,
  );
  if (targets.length === 0) return;
  const awaitTargetsExit = dependencies.waitForTargetsExit ?? waitForProcessTerminationTargets;
  if (platform === "win32") {
    // taskkill /T already owns every descendant of a live packaged root. Do
    // not target recorded backend PIDs again after killing that tree: Windows
    // could reuse one between calls. When the root has already exited, the
    // recorded active backend PIDs are the only remaining cleanup authority.
    const liveRootProcessId = child.pid && childCanStillOwnProcesses ? child.pid : null;
    const taskkillTargets = liveRootProcessId
      ? targets.filter((target) => target.pid === liveRootProcessId)
      : targets;
    const taskkillResults = taskkillTargets.map((target) => ({
      pid: target.pid,
      result:
        dependencies.runTaskkill?.(target.pid) ??
        spawnSync("taskkill", ["/pid", String(target.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        }),
    }));
    if (await awaitTargetsExit(targets, 5_000)) return;
    const taskkillResult = taskkillResults
      .map(({ pid, result }) =>
        result.error
          ? `${pid}: could not start (${result.error.message})`
          : `${pid}: status ${result.status ?? "unknown"}`,
      )
      .join(", ");
    throw new Error(
      `Packaged process trees survived Windows cleanup; taskkill results: ${taskkillResult}.`,
    );
  }
  const sendSignal = dependencies.sendSignal ?? sendProcessTreeSignal;
  for (const target of targets) sendSignal(target, "SIGTERM");
  if (await awaitTargetsExit(targets, 5_000)) return;
  const targetIsAlive = dependencies.targetIsAlive ?? processTerminationTargetIsAlive;
  const survivingTargets = targets.filter((target) => targetIsAlive(target));
  if (survivingTargets.length === 0) return;
  for (const target of survivingTargets) sendSignal(target, "SIGKILL");
  if (await awaitTargetsExit(survivingTargets, 2_000)) return;
  throw new Error(
    `Packaged process trees ${survivingTargets.map(({ pid }) => pid).join(", ")} survived SIGTERM and SIGKILL.`,
  );
}

export function hasPackagedStartupProof(logPath: string): boolean {
  try {
    const log = readFileSync(logPath, "utf8");
    return (
      log.includes("app ready") &&
      log.includes("bootstrap main window created") &&
      log.includes("renderer main frame loaded") &&
      log.includes("backend semantic ready generation=") &&
      !log.includes("renderer main frame load failed") &&
      !log.includes("renderer main process gone") &&
      !log.includes("renderer main window unresponsive") &&
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

    await waitForPackagedStartupProof({
      timeoutMs: options.timeoutMs,
      hasProof: () => hasPackagedStartupProof(launchLogPath),
      readOutcome: () => childOutcome,
      isProcessAlive: () => childProcessHandleIsAlive(child!),
    });
    console.log(
      `Packaged ${options.platform}/${options.arch} startup smoke passed from isolated Scient state.`,
    );
  } catch (error) {
    const detail = output.trim() ? `\nPackaged process output:\n${output.trim()}` : "";
    let logDetail = "";
    if (logPath) {
      const boundedLog = readPackagedDesktopLogTail(logPath);
      if (boundedLog) logDetail = `\nPackaged desktop log tail:\n${boundedLog}`;
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${detail}${logDetail}`,
      {
        cause: error,
      },
    );
  } finally {
    try {
      if (child) {
        await terminateProcessTree(child, {}, readPackagedBackendProcessIds(environment));
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await verifyPackagedDesktopStartup(parsePackagedDesktopStartupArgs(process.argv.slice(2)));
}
