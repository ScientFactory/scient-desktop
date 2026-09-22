#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  DEVELOPMENT_LAUNCH_HANDOFF_GRACE_MS,
  findOwnedDevelopmentChildProcess,
  findOwnedDevelopmentProcesses,
  inspectDevelopmentBackendOwnership,
  listDevelopmentLaunchPaths,
  readOwnedDevelopmentAppProcess,
  readOwnedDevelopmentLauncherProcess,
  removeDevelopmentLaunchFiles,
  removeDevelopmentLaunchRecord,
  resolveDevelopmentAppDisplayName,
  resolveDevelopmentAppLabel,
  writeDevelopmentProcessPid,
} from "../apps/desktop/scripts/dev-app-process.mjs";

export const LOCAL_DEV_APP_NAME = "Scient (Dev)";
export const LOCAL_DEV_APP_STABLE_NAME = "Scient (Dev) Stable";
export const LOCAL_DEV_APP_SCHEMA = "scient-next.local-dev-app/v1";
export const SCIENT_DEV_APP_ROLE_ENV = "SCIENT_DEV_APP_ROLE";
export const SCIENT_NEXT_HOME_ENV = "SCIENT_NEXT_HOME";
export const LOCAL_DEV_APP_SERVICE_LABEL_PREFIX = "com.scientfactory.scient-dev-app";
export const MACOS_LSREGISTER_PATH =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const RUNNER_START_GRACE_MS = 5_000;
const STOP_GRACE_MS = 12_000;
const STOP_POLL_MS = 50;
const SERVICE_STOP_GRACE_MS = 2_000;
const MACOS_LSOF_PATH = "/usr/sbin/lsof";
const BACKGROUND_ENVIRONMENT_KEYS = [
  "ELECTRON_ENABLE_LOGGING",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "SHELL",
  "SSH_AUTH_SOCK",
  "SCIENT_DEV_CODESIGN_IDENTITY",
  "T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT",
  "TMPDIR",
  "USER",
  "npm_execpath",
];

const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const repoRoot = NodePath.resolve(scriptDir, "..");
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher CLI has no Effect runtime.
const hostPlatform = NodeOS.platform();

function pathExists(path) {
  try {
    NodeFS.lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function readJson(path) {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processMatchesRunner(pid, root) {
  if (!processIsAlive(pid)) return false;
  const command = NodeChildProcess.spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  if (
    command.status !== 0 ||
    !command.stdout.includes("local-dev-app.mjs") ||
    !command.stdout.includes(" run")
  ) {
    return false;
  }
  const cwd = NodeChildProcess.spawnSync(
    hostPlatform === "darwin" ? MACOS_LSOF_PATH : "lsof",
    ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
    { encoding: "utf8" },
  );
  if (cwd.status !== 0) return false;
  const cwdPath = cwd.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  return cwdPath !== undefined && NodePath.resolve(cwdPath) === NodePath.resolve(root);
}

function plistXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function currentUserGuiDomain() {
  return `gui/${process.getuid?.() ?? 0}`;
}

export function resolveLocalDevAppServiceLabel(root, role = "candidate") {
  const identity = NodeCrypto.createHash("sha256")
    .update(`${NodePath.resolve(root)}\0${role}`)
    .digest("hex")
    .slice(0, 16);
  return `${LOCAL_DEV_APP_SERVICE_LABEL_PREFIX}.${role}.${identity}`;
}

export function resolveLocalDevAppPaths({
  root = repoRoot,
  homeDir = NodeOS.homedir(),
  role = process.env[SCIENT_DEV_APP_ROLE_ENV],
} = {}) {
  const appName = role === "stable" ? LOCAL_DEV_APP_STABLE_NAME : LOCAL_DEV_APP_NAME;
  const stateRoot =
    role === "stable" ? resolveStableDevHome(homeDir) : NodePath.join(root, ".scient-next");
  const applicationsDir = NodePath.join(homeDir, "Applications");
  const appBundlePath = NodePath.join(applicationsDir, `${appName}.app`);
  const runtimeDir = NodePath.join(stateRoot, "local-dev-app-runtime");
  const serviceLabel = resolveLocalDevAppServiceLabel(
    root,
    role === "stable" ? "stable" : "candidate",
  );
  return {
    root,
    role: role === "stable" ? "stable" : "candidate",
    appName,
    stateRoot,
    applicationsDir,
    appBundlePath,
    markerPath: NodePath.join(
      appBundlePath,
      "Contents",
      "Resources",
      "scient-next-local-dev-app.json",
    ),
    runnerDir: NodePath.join(stateRoot, "local-dev-app-runner"),
    runnerStatePath: NodePath.join(stateRoot, "local-dev-app-runner", "state.json"),
    runtimeDir,
    appPidPath: NodePath.join(runtimeDir, "electron.pid"),
    backendPidPath: NodePath.join(runtimeDir, "backend.pid"),
    serviceLabel,
    servicePlistPath: NodePath.join(runtimeDir, `${serviceLabel}.plist`),
    logPath: NodePath.join(stateRoot, "local-dev-app.log"),
  };
}

export function makeLocalDevAppLaunchAgentPlist({
  paths = resolveLocalDevAppPaths(),
  nodePath = process.execPath,
  environment = process.env,
} = {}) {
  const scriptPath = NodePath.join(paths.root, "scripts", "local-dev-app.mjs");
  const pathParts = [
    NodePath.dirname(nodePath),
    environment.PATH,
    hostPlatform === "darwin" ? "/usr/sbin:/sbin" : undefined,
  ]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join(":");
  const serviceEnvironment = Object.fromEntries(
    BACKGROUND_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = environment[key];
      return typeof value === "string" && value.length > 0 ? [[key, value]] : [];
    }),
  );
  serviceEnvironment.PATH = pathParts;
  if (paths.role === "stable") {
    serviceEnvironment[SCIENT_DEV_APP_ROLE_ENV] = "stable";
    serviceEnvironment[SCIENT_NEXT_HOME_ENV] = paths.stateRoot;
  }
  const environmentXml = Object.entries(serviceEnvironment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) => `    <key>${plistXml(key)}</key>\n    <string>${plistXml(value)}</string>`,
    )
    .join("\n");
  const stableArgument = paths.role === "stable" ? "\n    <string>--stable</string>" : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistXml(paths.serviceLabel)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${plistXml(nodePath)}</string>
    <string>${plistXml(scriptPath)}</string>
    <string>run</string>${stableArgument}
  </array>
  <key>WorkingDirectory</key>
  <string>${plistXml(paths.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${plistXml(paths.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${plistXml(paths.logPath)}</string>
</dict>
</plist>
`;
}

function runLaunchctl(args, spawnSync = NodeChildProcess.spawnSync) {
  return spawnSync("launchctl", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function unloadLocalDevAppService(
  paths = resolveLocalDevAppPaths(),
  { spawnSync = NodeChildProcess.spawnSync } = {},
) {
  if (!localDevAppServiceIsLoaded(paths, { spawnSync })) {
    NodeFS.rmSync(paths.servicePlistPath, { force: true });
    return false;
  }
  const result = runLaunchctl(
    ["bootout", `${currentUserGuiDomain()}/${paths.serviceLabel}`],
    spawnSync,
  );
  if (result.status !== 0 && localDevAppServiceIsLoaded(paths, { spawnSync })) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(
      `Could not stop ${paths.appName} background service${detail ? `: ${detail}` : "."}`,
    );
  }
  NodeFS.rmSync(paths.servicePlistPath, { force: true });
  return true;
}

export function localDevAppServiceIsLoaded(
  paths = resolveLocalDevAppPaths(),
  { spawnSync = NodeChildProcess.spawnSync } = {},
) {
  const result = runLaunchctl(
    ["print", `${currentUserGuiDomain()}/${paths.serviceLabel}`],
    spawnSync,
  );
  return result.status === 0;
}

async function waitForLocalDevAppServiceToUnload(
  paths,
  { serviceIsLoaded = localDevAppServiceIsLoaded, timeoutMs = SERVICE_STOP_GRACE_MS } = {},
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!serviceIsLoaded(paths)) return true;
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
  return !serviceIsLoaded(paths);
}

export async function startAppInBackground({
  paths = resolveLocalDevAppPaths(),
  platform = hostPlatform,
  spawnSync = NodeChildProcess.spawnSync,
  writeLine = console.log,
} = {}) {
  if (platform !== "darwin") {
    throw new Error("The background local dev app launcher currently supports macOS only.");
  }
  const runner = clearStaleRunner(paths);
  const ownedLaunches = runner ? [] : resolveOwnedDevelopmentLaunches(paths);
  const ownedApps = runner ? [] : resolveOwnedDevelopmentApps(paths);
  const ownedBackends = runner ? [] : resolveOwnedDevelopmentBackends(paths);
  if (runner || ownedLaunches.length > 0 || ownedApps.length > 0 || ownedBackends.length > 0) {
    writeLine(
      `${paths.appName} is already ${runner?.starting ? "starting" : "running"} for ${paths.root}.`,
    );
    return { status: "already-running" };
  }

  const unloaded = unloadLocalDevAppService(paths, { spawnSync });
  if (
    unloaded &&
    !(await waitForLocalDevAppServiceToUnload(paths, {
      serviceIsLoaded: (target) => localDevAppServiceIsLoaded(target, { spawnSync }),
    }))
  ) {
    throw new Error(`Could not finish stopping the previous ${paths.appName} background service.`);
  }
  NodeFS.mkdirSync(paths.runtimeDir, { recursive: true });
  const temporaryPath = `${paths.servicePlistPath}.tmp-${String(process.pid)}`;
  NodeFS.writeFileSync(temporaryPath, makeLocalDevAppLaunchAgentPlist({ paths }), { mode: 0o600 });
  NodeFS.renameSync(temporaryPath, paths.servicePlistPath);

  const result = runLaunchctl(
    ["bootstrap", currentUserGuiDomain(), paths.servicePlistPath],
    spawnSync,
  );
  if (result.status !== 0) {
    NodeFS.rmSync(paths.servicePlistPath, { force: true });
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`Could not launch ${paths.appName}${detail ? `: ${detail}` : "."}`);
  }
  writeLine(`Launching ${paths.appName} for ${paths.root}.`);
  writeLine(`Use pnpm dev:app:status or pnpm dev:app:logs while it starts.`);
  return { status: "started" };
}

export function resolveStableDevHome(homeDir = NodeOS.homedir()) {
  return NodePath.join(homeDir, ".scient-next", "scient-dev-stable");
}

export function readLocalDevAppMarker(paths) {
  const marker = readJson(paths.markerPath);
  if (
    marker?.schema !== LOCAL_DEV_APP_SCHEMA ||
    typeof marker.repoRoot !== "string" ||
    marker.repoRoot.length === 0
  ) {
    return null;
  }
  return marker;
}

function assertOwnedInstallation(paths, { allowDifferentRoot = false } = {}) {
  if (!pathExists(paths.appBundlePath)) return null;
  const marker = readLocalDevAppMarker(paths);
  if (!marker) {
    throw new Error(
      `Refusing to replace unrecognized application at ${paths.appBundlePath}. Move it manually or choose another target.`,
    );
  }
  if (!allowDifferentRoot && NodePath.resolve(marker.repoRoot) !== NodePath.resolve(paths.root)) {
    throw new Error(
      `The installed launcher belongs to ${marker.repoRoot}. Re-run with --replace only after choosing this checkout as the stable dev host.`,
    );
  }
  return marker;
}

export function installDevelopmentAppBundle({
  sourceAppBundlePath,
  paths = resolveLocalDevAppPaths(),
  replace = false,
  register,
  commitStagedApp = NodeFS.renameSync,
}) {
  if (!NodeFS.statSync(sourceAppBundlePath).isDirectory()) {
    throw new Error(`Development app bundle is not a directory: ${sourceAppBundlePath}`);
  }

  const existingMarker = assertOwnedInstallation(paths, { allowDifferentRoot: replace });
  NodeFS.mkdirSync(paths.applicationsDir, { recursive: true });
  const stagingRoot = NodeFS.mkdtempSync(
    NodePath.join(paths.applicationsDir, ".scient-next-dev-install-"),
  );
  const stagedAppPath = NodePath.join(stagingRoot, `${LOCAL_DEV_APP_NAME}.app`);
  const backupPath = `${paths.appBundlePath}.backup-${String(process.pid)}`;

  try {
    NodeFS.cpSync(sourceAppBundlePath, stagedAppPath, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const stagedMarkerPath = NodePath.join(
      stagedAppPath,
      "Contents",
      "Resources",
      "scient-next-local-dev-app.json",
    );
    NodeFS.mkdirSync(NodePath.dirname(stagedMarkerPath), { recursive: true });
    NodeFS.writeFileSync(
      stagedMarkerPath,
      `${JSON.stringify(
        {
          schema: LOCAL_DEV_APP_SCHEMA,
          repoRoot: paths.root,
          role: paths.role,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );

    if (existingMarker) NodeFS.renameSync(paths.appBundlePath, backupPath);
    let stagedInstalled = false;
    try {
      commitStagedApp(stagedAppPath, paths.appBundlePath);
      stagedInstalled = true;
      register?.(paths.appBundlePath);
    } catch (error) {
      if (stagedInstalled && pathExists(paths.appBundlePath)) {
        NodeFS.rmSync(paths.appBundlePath, { recursive: true, force: true });
      }
      if (existingMarker && pathExists(backupPath) && !pathExists(paths.appBundlePath)) {
        NodeFS.renameSync(backupPath, paths.appBundlePath);
      }
      throw error;
    }
    if (pathExists(backupPath)) NodeFS.rmSync(backupPath, { recursive: true, force: true });
  } finally {
    NodeFS.rmSync(stagingRoot, { recursive: true, force: true });
  }

  return paths.appBundlePath;
}

export function uninstallDevelopmentAppBundle(paths = resolveLocalDevAppPaths()) {
  const marker = assertOwnedInstallation(paths);
  if (!marker) return false;
  NodeFS.rmSync(paths.appBundlePath, { recursive: true, force: true });
  return true;
}

export function registerDevelopmentAppBundle(
  appBundlePath,
  { spawnSync = NodeChildProcess.spawnSync } = {},
) {
  const result = spawnSync(MACOS_LSREGISTER_PATH, ["-f", appBundlePath], {
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`Could not register ${appBundlePath} with macOS: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(
      `Could not register ${appBundlePath} with macOS${detail ? `: ${detail}` : "."}`,
    );
  }
}

function readRunnerState(paths) {
  const state = readJson(paths.runnerStatePath);
  if (
    state?.schema !== LOCAL_DEV_APP_SCHEMA ||
    NodePath.resolve(state.repoRoot ?? "") !== NodePath.resolve(paths.root)
  ) {
    return null;
  }
  return state;
}

export function clearStaleRunner(
  paths,
  { matchesRunner = processMatchesRunner, now = Date.now } = {},
) {
  if (!pathExists(paths.runnerDir)) return null;
  const state = readRunnerState(paths);
  if (state && matchesRunner(state.pid, paths.root)) return state;
  if (!state) {
    let modifiedAt;
    try {
      modifiedAt = NodeFS.statSync(paths.runnerDir).mtimeMs;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const ageMs = now() - modifiedAt;
    if (ageMs < RUNNER_START_GRACE_MS) {
      return {
        schema: LOCAL_DEV_APP_SCHEMA,
        repoRoot: paths.root,
        pid: null,
        starting: true,
      };
    }
  }
  NodeFS.rmSync(paths.runnerDir, { recursive: true, force: true });
  return null;
}

export function acquireRunner(paths, dependencies = {}) {
  const makeRunnerDirectory =
    dependencies.makeRunnerDirectory ?? (() => NodeFS.mkdirSync(paths.runnerDir));
  NodeFS.mkdirSync(NodePath.dirname(paths.runnerDir), { recursive: true });
  let acquiredDirectory = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      makeRunnerDirectory();
      acquiredDirectory = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const raced = clearStaleRunner(paths, dependencies);
      if (raced) return { acquired: false, state: raced };
    }
  }
  if (!acquiredDirectory) {
    throw new Error(`Could not acquire the local dev app runner lock at ${paths.runnerDir}.`);
  }
  const state = {
    schema: LOCAL_DEV_APP_SCHEMA,
    repoRoot: paths.root,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  NodeFS.writeFileSync(paths.runnerStatePath, `${JSON.stringify(state, null, 2)}\n`);
  return { acquired: true, state };
}

export function releaseRunner(paths, pid = process.pid) {
  const state = readRunnerState(paths);
  if (state?.pid !== pid) return false;
  NodeFS.rmSync(paths.runnerDir, { recursive: true, force: true });
  return true;
}

function resolveDevelopmentProcessIdentity(paths) {
  const environment =
    paths.role === "stable"
      ? { SCIENT_DEV_APP_ROLE: "stable" }
      : { SCIENT_DEV_APP_LABEL: resolveDevelopmentAppLabel(paths.root) };
  const displayName = resolveDevelopmentAppDisplayName(environment, paths.root);
  const appBundlePath = NodePath.join(
    paths.root,
    "apps",
    "desktop",
    ".electron-runtime",
    `${displayName}.app`,
  );
  const electronBinaryPath = NodePath.join(appBundlePath, "Contents", "MacOS", "Electron");
  const backendCommandPrefix = `${electronBinaryPath} ${NodePath.join(
    paths.root,
    "apps",
    "server",
    "dist",
    "bin.mjs",
  )}`;
  return { appBundlePath, electronBinaryPath, backendCommandPrefix };
}

export function resolveOwnedDevelopmentLaunches(
  paths,
  {
    inspectCommand,
    inspectChildren,
    preserveIncomplete = false,
    now = Date.now,
    listLaunchPaths = listDevelopmentLaunchPaths,
    removeLaunchRecord = removeDevelopmentLaunchRecord,
  } = {},
) {
  const { appBundlePath, electronBinaryPath, backendCommandPrefix } =
    resolveDevelopmentProcessIdentity(paths);
  const records = listLaunchPaths(paths.runtimeDir, {
    legacyAppPidPath: paths.appPidPath,
    legacyBackendPidPath: paths.backendPidPath,
  });
  return records.flatMap((record) => {
    const launcher = readOwnedDevelopmentLauncherProcess({
      pidFilePath: record.launcherPidPath,
      appBundlePath,
      appPidFilePath: record.appPidPath,
      ...(inspectCommand ? { inspectCommand } : {}),
    });
    const app = readOwnedDevelopmentAppProcess({
      pidFilePath: record.appPidPath,
      electronBinaryPath,
      ...(inspectCommand ? { inspectCommand } : {}),
    });
    const backendOwnership = inspectDevelopmentBackendOwnership({
      record,
      pidFilePath: record.backendPidPath,
      commandPrefix: backendCommandPrefix,
      ...(inspectCommand ? { inspectCommand } : {}),
      now,
    });
    const recordedBackend = backendOwnership.backend;
    const backend =
      recordedBackend ??
      (app
        ? findOwnedDevelopmentChildProcess({
            parentPid: app.pid,
            commandPrefix: backendCommandPrefix,
            ...(inspectChildren ? { inspectChildren } : {}),
          })
        : null);
    if (!recordedBackend && backend && record.backendPidPath) {
      writeDevelopmentProcessPid(record.backendPidPath, backend.pid);
    }
    if (backend && record.backendPidPendingPath) {
      removeDevelopmentLaunchFiles(record.backendPidPendingPath);
    }
    if (!launcher && !app && !backend) {
      const handoff = backendOwnership.handoff;
      if (
        record.launchDir &&
        (preserveIncomplete ||
          (handoff !== null && handoff.ageMs < DEVELOPMENT_LAUNCH_HANDOFF_GRACE_MS))
      ) {
        return [{ record, launcher: null, app: null, backend: null, pending: true }];
      }
      removeLaunchRecord(record);
      return [];
    }
    return [{ record, launcher, app, backend }];
  });
}

export function resolveOwnedDevelopmentApp(paths, { inspectCommand } = {}) {
  return (
    resolveOwnedDevelopmentLaunches(paths, inspectCommand ? { inspectCommand } : {}).find(
      (launch) => launch.app,
    )?.app ?? null
  );
}

function resolveOwnedDevelopmentAppCommandPrefix(paths) {
  const environment =
    paths.role === "stable"
      ? { SCIENT_DEV_APP_ROLE: "stable" }
      : { SCIENT_DEV_APP_LABEL: resolveDevelopmentAppLabel(paths.root) };
  const displayName = resolveDevelopmentAppDisplayName(environment, paths.root);
  const electronBinaryPath = NodePath.join(
    paths.root,
    "apps",
    "desktop",
    ".electron-runtime",
    `${displayName}.app`,
    "Contents",
    "MacOS",
    "Electron",
  );
  return `${electronBinaryPath} --t3code-dev-root=${NodePath.join(paths.root, "apps", "desktop")} ${NodePath.join(paths.root, "apps", "desktop", "dist-electron", "main.cjs")}`;
}

export function resolveOwnedDevelopmentApps(paths, { inspectAllProcesses } = {}) {
  return findOwnedDevelopmentProcesses({
    commandPrefix: resolveOwnedDevelopmentAppCommandPrefix(paths),
    ...(inspectAllProcesses ? { inspectAllProcesses } : {}),
  });
}

export function resolveOwnedDevelopmentBackend(paths, { inspectCommand } = {}) {
  return (
    resolveOwnedDevelopmentLaunches(paths, inspectCommand ? { inspectCommand } : {}).find(
      (launch) => launch.backend,
    )?.backend ?? null
  );
}

function resolveOwnedDevelopmentBackendCommandPrefix(paths) {
  const environment =
    paths.role === "stable"
      ? { SCIENT_DEV_APP_ROLE: "stable" }
      : { SCIENT_DEV_APP_LABEL: resolveDevelopmentAppLabel(paths.root) };
  const displayName = resolveDevelopmentAppDisplayName(environment, paths.root);
  return `${NodePath.join(
    paths.root,
    "apps",
    "desktop",
    ".electron-runtime",
    `${displayName}.app`,
    "Contents",
    "MacOS",
    "Electron",
  )} ${NodePath.join(paths.root, "apps", "server", "dist", "bin.mjs")}`;
}

export function resolveOwnedDevelopmentBackends(paths, { inspectAllProcesses } = {}) {
  return findOwnedDevelopmentProcesses({
    commandPrefix: resolveOwnedDevelopmentBackendCommandPrefix(paths),
    ...(inspectAllProcesses ? { inspectAllProcesses } : {}),
  });
}

function signalOwnedDevelopmentLaunches(
  paths,
  signal,
  {
    killProcess = process.kill,
    resolveOwnedLaunches = resolveOwnedDevelopmentLaunches,
    preserveIncomplete = false,
  } = {},
) {
  const launches = resolveOwnedLaunches(paths, { preserveIncomplete });
  const signaled = new Set();
  for (const kind of ["backend", "app", "launcher"]) {
    for (const launch of launches) {
      const currentLaunch = resolveOwnedLaunches(paths, { preserveIncomplete }).find(
        (candidate) => candidate.record.generation === launch.record.generation,
      );
      const owned = currentLaunch?.[kind];
      if (!owned || signaled.has(owned.pid)) continue;
      try {
        killProcess(owned.pid, signal);
        signaled.add(owned.pid);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }
  return launches;
}

function signalOwnedDevelopmentProcesses(processes, signal, killProcess = process.kill) {
  for (const owned of processes) {
    try {
      killProcess(owned.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  return processes;
}

function signalEveryOwnedDevelopmentProcess(
  paths,
  signal,
  {
    killProcess = process.kill,
    resolveOwnedLaunches = resolveOwnedDevelopmentLaunches,
    resolveOwnedApps = resolveOwnedDevelopmentApps,
    resolveOwnedBackends = resolveOwnedDevelopmentBackends,
    preserveIncomplete = false,
  } = {},
) {
  const launches = signalOwnedDevelopmentLaunches(paths, signal, {
    killProcess,
    resolveOwnedLaunches,
    preserveIncomplete,
  });
  const launchPids = new Set(
    launches.flatMap((launch) =>
      [launch.launcher, launch.app, launch.backend].flatMap((owned) => (owned ? [owned.pid] : [])),
    ),
  );
  const apps = signalOwnedDevelopmentProcesses(
    resolveOwnedApps(paths).filter(({ pid }) => !launchPids.has(pid)),
    signal,
    killProcess,
  );
  const backends = signalOwnedDevelopmentProcesses(
    resolveOwnedBackends(paths).filter(({ pid }) => !launchPids.has(pid)),
    signal,
    killProcess,
  );
  return { launches, apps, backends };
}

async function waitForStopped(
  paths,
  runnerPid,
  {
    timeoutMs = STOP_GRACE_MS,
    matchesRunner = processMatchesRunner,
    resolveOwnedLaunches = resolveOwnedDevelopmentLaunches,
    resolveOwnedApps = resolveOwnedDevelopmentApps,
    resolveOwnedBackends = resolveOwnedDevelopmentBackends,
  } = {},
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const runnerAlive = runnerPid ? matchesRunner(runnerPid, paths.root) : false;
    const ownedLaunches = resolveOwnedLaunches(paths, {
      preserveIncomplete: runnerAlive,
    });
    const appsAlive = resolveOwnedApps(paths).length > 0;
    const backendsAlive = resolveOwnedBackends(paths).length > 0;
    if (!runnerAlive && ownedLaunches.length === 0 && !appsAlive && !backendsAlive) return true;
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
  return false;
}

async function runApp() {
  const paths = resolveLocalDevAppPaths();
  const runner = acquireRunner(paths);
  if (!runner.acquired) {
    console.log(
      runner.state.starting
        ? `${LOCAL_DEV_APP_NAME} is already starting for this checkout.`
        : `${LOCAL_DEV_APP_NAME} is already running for this checkout (runner PID ${String(runner.state.pid)}).`,
    );
    return;
  }

  const cleanup = () => releaseRunner(paths, process.pid);
  process.once("exit", cleanup);
  const orphaned = signalEveryOwnedDevelopmentProcess(paths, "SIGTERM");
  if (orphaned.launches.length > 0 || orphaned.apps.length > 0 || orphaned.backends.length > 0) {
    const stopped = await waitForStopped(paths, null);
    if (!stopped) {
      throw new Error(
        `Could not stop the previous owned ${paths.appName} process. Run pnpm dev:app:stop and retry.`,
      );
    }
  } else {
    removeDevelopmentLaunchFiles(paths.appPidPath, paths.backendPidPath);
  }
  const pnpmExecPath = process.env.npm_execpath?.trim();
  const devDesktopArgs = ["dev:desktop"];
  if (paths.role === "stable") {
    devDesktopArgs.push("--home-dir", paths.stateRoot);
  }
  const childEnv = {
    ...process.env,
    SCIENT_LOCAL_DEV_APP_MANAGED: "1",
    SCIENT_DEV_APP_PID_FILE: paths.appPidPath,
  };
  const label = resolveDevelopmentAppLabel(paths.root);
  if (paths.role !== "stable" && label) childEnv.SCIENT_DEV_APP_LABEL = label;
  const child = NodeChildProcess.spawn(
    pnpmExecPath ? process.execPath : "pnpm",
    pnpmExecPath ? [pnpmExecPath, ...devDesktopArgs] : devDesktopArgs,
    {
      cwd: paths.root,
      env: childEnv,
      stdio: "inherit",
    },
  );

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      signalEveryOwnedDevelopmentProcess(paths, "SIGTERM");
      if (!child.killed) child.kill(signal);
    });
  }

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(cleanup);

  if (result.signal) {
    process.removeAllListeners(result.signal);
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code ?? 1;
}

async function installApp({ replace }) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher CLI has no Effect runtime; install remains explicitly macOS-only.
  if (process.platform !== "darwin") {
    throw new Error("The clickable local dev app installer currently supports macOS only.");
  }
  if (process.env[SCIENT_DEV_APP_ROLE_ENV] === "stable" && !process.env[SCIENT_NEXT_HOME_ENV]) {
    process.env[SCIENT_NEXT_HOME_ENV] = resolveStableDevHome();
  }
  process.env.VITE_DEV_SERVER_URL = "http://127.0.0.1:5733";
  const { resolveDevProtocolClient } =
    await import("../apps/desktop/scripts/electron-launcher.mjs");
  const source = resolveDevProtocolClient();
  if (!source) throw new Error("Could not create the macOS development app bundle.");
  const paths = resolveLocalDevAppPaths();
  const installedPath = installDevelopmentAppBundle({
    sourceAppBundlePath: source.appBundlePath,
    paths,
    replace,
    register: registerDevelopmentAppBundle,
  });
  console.log(`Installed ${paths.appName} at ${installedPath}`);
  console.log(`Owning checkout: ${paths.root}`);
}

export function statusApp({
  paths = resolveLocalDevAppPaths(),
  matchesRunner = processMatchesRunner,
  serviceIsLoaded = localDevAppServiceIsLoaded,
  resolveOwnedLaunches = resolveOwnedDevelopmentLaunches,
  resolveOwnedApps = resolveOwnedDevelopmentApps,
  resolveOwnedBackends = resolveOwnedDevelopmentBackends,
  writeLine = console.log,
} = {}) {
  const appName = paths.appName ?? LOCAL_DEV_APP_NAME;
  const state = clearStaleRunner(paths, { matchesRunner });
  const ownedLaunches = resolveOwnedLaunches(paths, {
    preserveIncomplete: typeof state?.pid === "number",
  });
  const ownedApps = ownedLaunches.flatMap((launch) => (launch.app ? [launch.app] : []));
  const ownedBackends = ownedLaunches.flatMap((launch) => (launch.backend ? [launch.backend] : []));
  const ownedLaunchers = ownedLaunches.flatMap((launch) =>
    launch.launcher ? [launch.launcher] : [],
  );
  const pendingLaunches = ownedLaunches.filter((launch) => launch.pending);
  const recordedPids = new Set(
    [...ownedApps, ...ownedBackends, ...ownedLaunchers].map(({ pid }) => pid),
  );
  const unrecordedApps = resolveOwnedApps(paths).filter(({ pid }) => !recordedPids.has(pid));
  const unrecordedBackends = resolveOwnedBackends(paths).filter(
    ({ pid }) => !recordedPids.has(pid),
  );
  const allOwnedApps = [...ownedApps, ...unrecordedApps];
  const allOwnedBackends = [...ownedBackends, ...unrecordedBackends];
  const ownedApp = allOwnedApps[0] ?? null;
  const ownedBackend = allOwnedBackends[0] ?? null;
  if (!state) {
    if (ownedLaunches.length > 0 || unrecordedApps.length > 0 || unrecordedBackends.length > 0) {
      writeLine(
        `${appName} has an owned process without a runner for ${paths.root} (${[
          ...allOwnedApps.map((owned) => `app PID ${String(owned.pid)}`),
          ...allOwnedBackends.map((owned) => `backend PID ${String(owned.pid)}`),
          ...ownedLaunchers.map((owned) => `launcher PID ${String(owned.pid)}`),
          ...pendingLaunches.map(
            (launch) => `pending generation ${String(launch.record.generation)}`,
          ),
        ]
          .filter(Boolean)
          .join(", ")}).`,
      );
      return;
    }
    if (serviceIsLoaded(paths)) {
      writeLine(
        `${appName} background service is loaded for ${paths.root}, but the app is not running. Check pnpm dev:app:logs.`,
      );
      return;
    }
    writeLine(`${appName} is stopped for ${paths.root}`);
    return;
  }
  if (ownedLaunches.length > 1 || allOwnedApps.length > 1 || allOwnedBackends.length > 1) {
    writeLine(
      `${appName} has multiple owned launch generations for ${paths.root} (${[
        ...allOwnedApps.map((owned) => `app PID ${String(owned.pid)}`),
        ...allOwnedBackends.map((owned) => `backend PID ${String(owned.pid)}`),
        ...ownedLaunchers.map((owned) => `launcher PID ${String(owned.pid)}`),
        ...pendingLaunches.map(
          (launch) => `pending generation ${String(launch.record.generation)}`,
        ),
      ].join(", ")}). Run pnpm dev:app:stop before starting it again.`,
    );
    return;
  }
  const completeLaunch = ownedLaunches.find((launch) => launch.app && launch.backend);
  if (state.starting || !completeLaunch || !ownedApp || !ownedBackend) {
    writeLine(
      `${appName} is starting for ${paths.root}${state.pid ? ` (runner PID ${String(state.pid)}${ownedApp ? `, app PID ${String(ownedApp.pid)}` : ""})` : ""}.`,
    );
    return;
  }
  writeLine(
    `${appName} is running for ${paths.root} (runner PID ${String(state.pid)}${ownedApp ? `, app PID ${String(ownedApp.pid)}` : ""}${ownedBackend ? `, backend PID ${String(ownedBackend.pid)}` : ""}).`,
  );
}

function printLogs() {
  const paths = resolveLocalDevAppPaths();
  if (!pathExists(paths.logPath)) {
    console.log(`No ${paths.appName} log exists at ${paths.logPath}`);
    return;
  }
  const lines = NodeFS.readFileSync(paths.logPath, "utf8").split(/\r?\n/);
  console.log(lines.slice(Math.max(0, lines.length - 200)).join("\n"));
}

export async function stopApp({
  paths = resolveLocalDevAppPaths(),
  matchesRunner = processMatchesRunner,
  killProcess = process.kill,
  resolveOwnedLaunches = resolveOwnedDevelopmentLaunches,
  resolveOwnedApps = resolveOwnedDevelopmentApps,
  resolveOwnedBackends = resolveOwnedDevelopmentBackends,
  waitUntilStopped = waitForStopped,
  unloadService = unloadLocalDevAppService,
  serviceIsLoaded = localDevAppServiceIsLoaded,
  writeLine = console.log,
} = {}) {
  const appName = paths.appName ?? LOCAL_DEV_APP_NAME;
  const state = clearStaleRunner(paths, { matchesRunner });
  const ownedLaunches = resolveOwnedLaunches(paths, {
    preserveIncomplete: state !== null,
  });
  const recordedPids = new Set(
    ownedLaunches.flatMap((launch) =>
      [launch.launcher, launch.app, launch.backend].flatMap((owned) => (owned ? [owned.pid] : [])),
    ),
  );
  const ownedApps = resolveOwnedApps(paths).filter(({ pid }) => !recordedPids.has(pid));
  const ownedBackends = resolveOwnedBackends(paths).filter(({ pid }) => !recordedPids.has(pid));
  const stopBackgroundService = async () => {
    const unloaded = unloadService(paths);
    if (unloaded && !(await waitForLocalDevAppServiceToUnload(paths, { serviceIsLoaded }))) {
      throw new Error(`Could not finish stopping ${appName} background service.`);
    }
    return unloaded;
  };
  if (
    !state &&
    ownedLaunches.length === 0 &&
    ownedApps.length === 0 &&
    ownedBackends.length === 0
  ) {
    const unloaded = await stopBackgroundService();
    writeLine(
      unloaded
        ? `Stopped ${appName} background service for ${paths.root}.`
        : `${appName} is already stopped for ${paths.root}`,
    );
    return;
  }

  let serviceStopped = false;
  if (state?.starting) {
    serviceStopped = await stopBackgroundService();
    if (!serviceStopped) {
      writeLine(`${appName} is still starting for ${paths.root}; try again shortly.`);
      return;
    }
  }

  const signalEveryOwnedProcess = (signal) =>
    signalEveryOwnedDevelopmentProcess(paths, signal, {
      killProcess,
      resolveOwnedLaunches,
      resolveOwnedApps,
      resolveOwnedBackends,
      preserveIncomplete: state !== null,
    });

  signalEveryOwnedProcess("SIGTERM");
  if (state?.pid) {
    try {
      killProcess(state.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
      releaseRunner(paths, state.pid);
    }
  }

  let stopped = await waitUntilStopped(paths, state?.pid ?? null, {
    matchesRunner,
    resolveOwnedLaunches,
    resolveOwnedApps,
    resolveOwnedBackends,
  });
  if (!stopped) {
    signalEveryOwnedProcess("SIGKILL");
    if (state?.pid && matchesRunner(state.pid, paths.root)) killProcess(state.pid, "SIGKILL");
    stopped = await waitUntilStopped(paths, state?.pid ?? null, {
      timeoutMs: 2_000,
      matchesRunner,
      resolveOwnedLaunches,
      resolveOwnedApps,
      resolveOwnedBackends,
    });
  }
  if (!stopped) {
    throw new Error(`Could not stop every owned ${appName} process for ${paths.root}.`);
  }

  clearStaleRunner(paths, { matchesRunner });
  resolveOwnedLaunches(paths);
  removeDevelopmentLaunchFiles(paths.appPidPath, paths.backendPidPath);
  if (!serviceStopped) await stopBackgroundService();
  writeLine(
    state?.starting
      ? `Stopped ${appName} while it was starting for ${paths.root}.`
      : !state
        ? `Stopped orphaned ${appName} app processes for ${paths.root}.`
        : `Stopped ${appName} for ${paths.root}.`,
  );
}

function uninstallApp() {
  const paths = resolveLocalDevAppPaths();
  const removed = uninstallDevelopmentAppBundle(paths);
  console.log(
    removed
      ? `Removed ${paths.appName} at ${paths.appBundlePath}`
      : `${paths.appName} is not installed at ${paths.appBundlePath}`,
  );
}

async function main() {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (nodeMajor !== 24) {
    throw new Error(
      `Scient development requires Node 24; received ${process.version}. Activate the repository's Node 24 runtime and retry.`,
    );
  }
  const [command, ...rawFlags] = process.argv.slice(2);
  const flags = rawFlags.filter((flag) => flag !== "--");
  const replace = flags.includes("--replace");
  const stable = flags.includes("--stable");
  if (flags.some((flag) => flag !== "--replace" && flag !== "--stable")) {
    throw new Error(
      `Unknown option: ${flags.find((flag) => flag !== "--replace" && flag !== "--stable")}`,
    );
  }
  if (stable) {
    process.env[SCIENT_DEV_APP_ROLE_ENV] = "stable";
    if (!process.env[SCIENT_NEXT_HOME_ENV]) {
      process.env[SCIENT_NEXT_HOME_ENV] = resolveStableDevHome();
    }
  }
  if (command === "run") return runApp();
  if (command === "start") return startAppInBackground();
  if (command === "install") return installApp({ replace });
  if (command === "logs") return printLogs();
  if (command === "status") return statusApp();
  if (command === "stop") return stopApp();
  if (command === "uninstall") return uninstallApp();
  throw new Error(
    "Usage: node scripts/local-dev-app.mjs <run|start|install|logs|status|stop|uninstall> [--stable] [--replace]",
  );
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
