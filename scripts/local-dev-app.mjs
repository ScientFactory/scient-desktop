#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  findOwnedDevelopmentProcesses,
  readOwnedDevelopmentAppProcess,
  removeDevelopmentLaunchFiles,
  resolveDevelopmentAppDisplayName,
  resolveDevelopmentAppLabel,
} from "../apps/desktop/scripts/dev-app-process.mjs";
import {
  readDevelopmentAppFailure,
  SCIENT_DEV_APP_BACKGROUND_SERVICE_ENV,
  SCIENT_DEV_APP_FAILURE_FILE_ENV,
} from "../apps/desktop/scripts/dev-app-bundle.mjs";
import {
  claimColdHandoff,
  processStartToken,
  readClaimedColdHandoff,
  takeClaimedColdHandoff,
  writeApprovedHandoff,
} from "../apps/desktop/scripts/dev-cold-handoff.mjs";

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
    failurePath: NodePath.join(runtimeDir, "last-failure.json"),
  };
}

export function makeLocalDevAppLaunchAgentPlist({
  paths = resolveLocalDevAppPaths(),
  nodePath = process.execPath,
  environment = process.env,
  coldClaimPath,
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
  // The service launches an app that `start` already built and signed.
  serviceEnvironment[SCIENT_DEV_APP_BACKGROUND_SERVICE_ENV] = "1";
  if (coldClaimPath) serviceEnvironment.SCIENT_DEV_COLD_CLAIM_PATH = coldClaimPath;
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

/**
 * Calls `onFailure` once the desktop launcher records a failure. The web dev
 * server outlives a failed desktop launch, so without this the runner would
 * report "starting" indefinitely.
 */
export function watchForLaunchFailure(paths, onFailure, { intervalMs = 1_000 } = {}) {
  const timer = setInterval(() => {
    const failure = readDevelopmentAppFailure(paths.failurePath);
    if (failure === null) return;
    clearInterval(timer);
    onFailure(failure);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The app name and role a launch uses; the prepared bundle must match it. */
export function resolveDevelopmentAppEnvironment(paths, environment = process.env) {
  const result = { ...environment };
  // The service derives its name from the checkout alone; an inherited label
  // (for example from a terminal inside another dev app) must not rename it.
  delete result.SCIENT_DEV_APP_LABEL;
  if (paths.role === "stable") {
    result[SCIENT_DEV_APP_ROLE_ENV] = "stable";
    result[SCIENT_NEXT_HOME_ENV] ??= paths.stateRoot;
    return result;
  }
  const label = resolveDevelopmentAppLabel(paths.root);
  if (label) result.SCIENT_DEV_APP_LABEL = label;
  return result;
}

/**
 * Builds and signs the development app bundle in this (foreground) process
 * before the background service launches it. The service never signs.
 */
export function prepareDevelopmentAppBundle({
  paths = resolveLocalDevAppPaths(),
  spawnSync = NodeChildProcess.spawnSync,
} = {}) {
  const environment = resolveDevelopmentAppEnvironment(paths);
  delete environment[SCIENT_DEV_APP_BACKGROUND_SERVICE_ENV];
  // Selects the development bundle; the runner writes the live URL at launch.
  environment.VITE_DEV_SERVER_URL ??= "http://127.0.0.1:5733";
  environment[SCIENT_DEV_APP_FAILURE_FILE_ENV] = paths.failurePath;
  const result = spawnSync(
    process.execPath,
    [NodePath.join(paths.root, "apps", "desktop", "scripts", "prepare-dev-app-bundle.mjs")],
    { cwd: paths.root, env: environment, stdio: "inherit" },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      readDevelopmentAppFailure(paths.failurePath) ??
        `Could not prepare the ${paths.appName} app bundle${result.error ? `: ${result.error.message}` : "; see the output above."}`,
    );
  }
}

export async function startAppInBackground({
  paths = resolveLocalDevAppPaths(),
  platform = hostPlatform,
  spawnSync = NodeChildProcess.spawnSync,
  prepareAppBundle = prepareDevelopmentAppBundle,
  writeLine = console.log,
  coldHandoffPath,
  resolveOwnedApp = resolveOwnedDevelopmentApp,
  resolveOwnedApps = resolveOwnedDevelopmentApps,
  clearRunner = clearStaleRunner,
} = {}) {
  if (platform !== "darwin") {
    throw new Error("The background local dev app launcher currently supports macOS only.");
  }
  let coldClaim = null;
  if (coldHandoffPath) {
    const marker = assertOwnedInstallation(paths);
    if (!marker || NodePath.resolve(marker.repoRoot) !== NodePath.resolve(paths.root)) {
      throw new Error("Cold handoff requires this checkout's installed development app.");
    }
    coldClaim = claimColdHandoff({
      path: coldHandoffPath,
      stateRoot: paths.stateRoot,
      root: paths.root,
      role: paths.role,
    });
    const binary = NodePath.join(paths.appBundlePath, "Contents", "MacOS", "Electron");
    const command = spawnSync("ps", ["-p", String(coldClaim.receipt.coldPid), "-o", "command="], {
      encoding: "utf8",
    });
    if (
      processStartToken(coldClaim.receipt.coldPid, { spawnSync }) !== coldClaim.receipt.coldStart ||
      command.status !== 0 ||
      !(command.stdout.trim() === binary || command.stdout.trim().startsWith(`${binary} `))
    ) {
      NodeFS.rmSync(coldClaim.path, { force: true });
      throw new Error("Cold handoff did not come from this installed development app process.");
    }
  }
  let started = false;
  try {
    const runner = clearRunner(paths);
    const ownedAppCandidate = resolveOwnedApp(paths);
    const ownedApp =
      ownedAppCandidate?.pid === coldClaim?.receipt.coldPid ? null : ownedAppCandidate;
    // The validated Finder receiver may still be alive during the handshake;
    // exclude exactly that PID, never another app or backend process.
    const ownedApps = resolveOwnedApps(paths).filter(
      ({ pid }) => pid !== coldClaim?.receipt.coldPid,
    );
    if (runner || ownedApp || ownedApps.length > 0) {
      if (coldClaim) NodeFS.rmSync(coldClaim.path, { force: true });
      if (coldClaim) {
        throw new Error(
          "Another managed development app is already running; the reviewed file was not handed off.",
        );
      }
      writeLine(
        `${paths.appName} is already ${runner?.starting ? "starting" : "running"} for ${paths.root}.`,
      );
      return { status: "already-running" };
    }

    if (coldClaim && localDevAppServiceIsLoaded(paths, { spawnSync })) {
      NodeFS.rmSync(coldClaim.path, { force: true });
      throw new Error("A managed development service is already loaded for this checkout.");
    }

    const unloaded = unloadLocalDevAppService(paths, { spawnSync });
    if (
      unloaded &&
      !(await waitForLocalDevAppServiceToUnload(paths, {
        serviceIsLoaded: (target) => localDevAppServiceIsLoaded(target, { spawnSync }),
      }))
    ) {
      throw new Error(
        `Could not finish stopping the previous ${paths.appName} background service.`,
      );
    }
    NodeFS.mkdirSync(paths.runtimeDir, { recursive: true });
    NodeFS.rmSync(paths.failurePath, { force: true });
    // Sign here, in the caller's session: macOS can refuse it to the service.
    if (!coldClaim) prepareAppBundle({ paths });
    const temporaryPath = `${paths.servicePlistPath}.tmp-${String(process.pid)}`;
    NodeFS.writeFileSync(
      temporaryPath,
      makeLocalDevAppLaunchAgentPlist({
        paths,
        coldClaimPath: coldClaim?.path,
      }),
      { mode: 0o600 },
    );
    NodeFS.renameSync(temporaryPath, paths.servicePlistPath);

    const result = runLaunchctl(
      ["bootstrap", currentUserGuiDomain(), paths.servicePlistPath],
      spawnSync,
    );
    if (result.status !== 0) {
      if (coldClaim) NodeFS.rmSync(coldClaim.path, { force: true });
      NodeFS.rmSync(paths.servicePlistPath, { force: true });
      const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      throw new Error(`Could not launch ${paths.appName}${detail ? `: ${detail}` : "."}`);
    }
    writeLine(`Launching ${paths.appName} for ${paths.root}.`);
    writeLine(`Use pnpm dev:app:status or pnpm dev:app:logs while it starts.`);
    started = true;
    return { status: "started" };
  } finally {
    if (!started && coldClaim) NodeFS.rmSync(coldClaim.path, { force: true });
  }
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

export function resolveOwnedDevelopmentApp(paths, { inspectCommand } = {}) {
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
  return readOwnedDevelopmentAppProcess({
    pidFilePath: paths.appPidPath,
    electronBinaryPath,
    ...(inspectCommand ? { inspectCommand } : {}),
  });
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
  return `${electronBinaryPath} --t3code-dev-root=${NodePath.join(paths.root, "apps", "desktop")}`;
}

export function resolveOwnedDevelopmentApps(paths, { inspectAllProcesses } = {}) {
  return findOwnedDevelopmentProcesses({
    commandPrefix: resolveOwnedDevelopmentAppCommandPrefix(paths),
    ...(inspectAllProcesses ? { inspectAllProcesses } : {}),
  });
}

export function resolveOwnedDevelopmentBackend(paths, { inspectCommand } = {}) {
  const environment =
    paths.role === "stable"
      ? { SCIENT_DEV_APP_ROLE: "stable" }
      : { SCIENT_DEV_APP_LABEL: resolveDevelopmentAppLabel(paths.root) };
  const displayName = resolveDevelopmentAppDisplayName(environment, paths.root);
  const commandPrefix = `${NodePath.join(
    paths.root,
    "apps",
    "desktop",
    ".electron-runtime",
    `${displayName}.app`,
    "Contents",
    "MacOS",
    "Electron",
  )} ${NodePath.join(paths.root, "apps", "server", "dist", "bin.mjs")}`;
  return readOwnedDevelopmentAppProcess({
    pidFilePath: paths.backendPidPath,
    electronBinaryPath: commandPrefix,
    ...(inspectCommand ? { inspectCommand } : {}),
  });
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

function signalOwnedDevelopmentApp(paths, signal, killProcess = process.kill) {
  const owned = resolveOwnedDevelopmentApp(paths);
  if (!owned) return null;
  try {
    killProcess(owned.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    removeDevelopmentLaunchFiles(paths.appPidPath);
    return null;
  }
  return owned;
}

function signalOwnedDevelopmentBackend(paths, signal, killProcess = process.kill) {
  const owned = resolveOwnedDevelopmentBackend(paths);
  if (!owned) return null;
  try {
    killProcess(owned.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    removeDevelopmentLaunchFiles(paths.backendPidPath);
    return null;
  }
  return owned;
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

async function waitForStopped(
  paths,
  runnerPid,
  {
    timeoutMs = STOP_GRACE_MS,
    matchesRunner = processMatchesRunner,
    resolveOwnedApp = resolveOwnedDevelopmentApp,
    resolveOwnedBackend = resolveOwnedDevelopmentBackend,
    resolveOwnedApps = resolveOwnedDevelopmentApps,
    resolveOwnedBackends = resolveOwnedDevelopmentBackends,
  } = {},
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const runnerAlive = runnerPid ? matchesRunner(runnerPid, paths.root) : false;
    const appAlive = resolveOwnedApp(paths) !== null;
    const backendAlive = resolveOwnedBackend(paths) !== null;
    const appsAlive = resolveOwnedApps(paths).length > 0;
    const backendsAlive = resolveOwnedBackends(paths).length > 0;
    if (!runnerAlive && !appAlive && !backendAlive && !appsAlive && !backendsAlive) return true;
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
  return false;
}

/**
 * Voice needs a native helper that is built once per machine, not stored in
 * Git. A checkout that lacks it takes the one another checkout staged, and a
 * checkout that has it shares it; nothing is built or downloaded here, and a
 * failure never stops the app from starting.
 */
export function shareDevelopmentVoiceRuntime({
  root,
  spawnSync = NodeChildProcess.spawnSync,
} = {}) {
  try {
    spawnSync(
      process.execPath,
      [NodePath.join(root, "scripts", "stage-whisper-runtime.ts"), "--dev-cache-only"],
      { cwd: root, stdio: "ignore", timeout: 30_000 },
    );
  } catch {
    // Voice then reports that it is unavailable, as it did before.
  }
}

async function runApp() {
  const paths = resolveLocalDevAppPaths();
  shareDevelopmentVoiceRuntime({ root: paths.root });
  const coldClaimPath = process.env.SCIENT_DEV_COLD_CLAIM_PATH;
  let coldApprovedPath = null;
  if (coldClaimPath) {
    const receipt = readClaimedColdHandoff({
      path: coldClaimPath,
      stateRoot: paths.stateRoot,
      root: paths.root,
      role: paths.role,
    });
    const deadline = Date.now() + 45_000;
    while (processStartToken(receipt.coldPid) === receipt.coldStart) {
      if (Date.now() > deadline) throw new Error("Cold development app did not yield ownership.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const claimed = takeClaimedColdHandoff({
      path: coldClaimPath,
      stateRoot: paths.stateRoot,
      root: paths.root,
      role: paths.role,
    });
    if (claimed.nonce !== receipt.nonce)
      throw new Error("Cold handoff changed during ownership transfer.");
    if (claimed.files.length > 0) {
      coldApprovedPath = writeApprovedHandoff({
        stateRoot: paths.stateRoot,
        root: paths.root,
        role: paths.role,
        files: claimed.files,
      });
    }
  }
  const runner = acquireRunner(paths);
  if (!runner.acquired) {
    if (coldApprovedPath) NodeFS.rmSync(coldApprovedPath, { force: true });
    console.log(
      runner.state.starting
        ? `${LOCAL_DEV_APP_NAME} is already starting for this checkout.`
        : `${LOCAL_DEV_APP_NAME} is already running for this checkout (runner PID ${String(runner.state.pid)}).`,
    );
    return;
  }

  const cleanup = () => NodeFS.rmSync(paths.runnerDir, { recursive: true, force: true });
  process.once("exit", cleanup);
  const orphan = signalOwnedDevelopmentApp(paths, "SIGTERM");
  const orphanedBackend = signalOwnedDevelopmentBackend(paths, "SIGTERM");
  const orphanedApps = signalOwnedDevelopmentProcesses(
    resolveOwnedDevelopmentApps(paths).filter(({ pid }) => pid !== orphan?.pid),
    "SIGTERM",
  );
  const orphanedBackends = signalOwnedDevelopmentProcesses(
    resolveOwnedDevelopmentBackends(paths).filter(({ pid }) => pid !== orphanedBackend?.pid),
    "SIGTERM",
  );
  if (orphan || orphanedBackend || orphanedApps.length > 0 || orphanedBackends.length > 0) {
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
  NodeFS.rmSync(paths.failurePath, { force: true });
  const childEnv = {
    ...resolveDevelopmentAppEnvironment(paths),
    SCIENT_LOCAL_DEV_APP_MANAGED: "1",
    SCIENT_DEV_APP_PID_FILE: paths.appPidPath,
    [SCIENT_DEV_APP_FAILURE_FILE_ENV]: paths.failurePath,
  };
  delete childEnv.SCIENT_DEV_COLD_CLAIM_PATH;
  if (coldApprovedPath) childEnv.SCIENT_DEV_COLD_APPROVED_PATH = coldApprovedPath;
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
      signalOwnedDevelopmentApp(paths, "SIGTERM");
      signalOwnedDevelopmentBackend(paths, "SIGTERM");
      if (!child.killed) child.kill(signal);
    });
  }

  let launchFailed = false;
  const stopWatching = watchForLaunchFailure(paths, (failure) => {
    launchFailed = true;
    console.error(`${paths.appName} could not start: ${failure}`);
    signalOwnedDevelopmentApp(paths, "SIGTERM");
    signalOwnedDevelopmentBackend(paths, "SIGTERM");
    if (!child.killed) child.kill("SIGTERM");
  });

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    stopWatching();
    if (coldApprovedPath) NodeFS.rmSync(coldApprovedPath, { force: true });
    cleanup();
  });

  if (launchFailed) {
    // Status reports the recorded reason once this runner has exited.
    process.exitCode = 1;
    return;
  }
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
  resolveOwnedApp = resolveOwnedDevelopmentApp,
  resolveOwnedBackend = resolveOwnedDevelopmentBackend,
  writeLine = console.log,
} = {}) {
  const appName = paths.appName ?? LOCAL_DEV_APP_NAME;
  const state = clearStaleRunner(paths, { matchesRunner });
  const ownedApp = resolveOwnedApp(paths);
  const ownedBackend = resolveOwnedBackend(paths);
  if (!state) {
    if (ownedApp || ownedBackend) {
      writeLine(
        `${appName} has an owned process without a runner for ${paths.root} (${[
          ownedApp ? `app PID ${String(ownedApp.pid)}` : null,
          ownedBackend ? `backend PID ${String(ownedBackend.pid)}` : null,
        ]
          .filter(Boolean)
          .join(", ")}).`,
      );
      return;
    }
    const failure = paths.failurePath ? readDevelopmentAppFailure(paths.failurePath) : null;
    if (serviceIsLoaded(paths)) {
      writeLine(
        failure
          ? `${appName} failed to start for ${paths.root}: ${failure}`
          : `${appName} background service is loaded for ${paths.root}, but the app is not running. Check pnpm dev:app:logs.`,
      );
      return;
    }
    writeLine(
      failure
        ? `${appName} is stopped for ${paths.root}. Last launch failed: ${failure}`
        : `${appName} is stopped for ${paths.root}`,
    );
    return;
  }
  if (state.starting || !ownedApp || !ownedBackend) {
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
  resolveOwnedApp = resolveOwnedDevelopmentApp,
  resolveOwnedBackend = resolveOwnedDevelopmentBackend,
  resolveOwnedApps = resolveOwnedDevelopmentApps,
  resolveOwnedBackends = resolveOwnedDevelopmentBackends,
  waitUntilStopped = waitForStopped,
  unloadService = unloadLocalDevAppService,
  serviceIsLoaded = localDevAppServiceIsLoaded,
  writeLine = console.log,
} = {}) {
  const appName = paths.appName ?? LOCAL_DEV_APP_NAME;
  const state = clearStaleRunner(paths, { matchesRunner });
  const ownedApp = resolveOwnedApp(paths);
  const ownedBackend = resolveOwnedBackend(paths);
  const ownedApps = resolveOwnedApps(paths).filter(({ pid }) => pid !== ownedApp?.pid);
  const ownedBackends = resolveOwnedBackends(paths).filter(({ pid }) => pid !== ownedBackend?.pid);
  const stopBackgroundService = async () => {
    const unloaded = unloadService(paths);
    if (unloaded && !(await waitForLocalDevAppServiceToUnload(paths, { serviceIsLoaded }))) {
      throw new Error(`Could not finish stopping ${appName} background service.`);
    }
    return unloaded;
  };
  const resolvers = {
    matchesRunner,
    resolveOwnedApp,
    resolveOwnedBackend,
    resolveOwnedApps,
    resolveOwnedBackends,
  };
  const forceStopRemaining = async (runnerPid) => {
    const remainingApp = resolveOwnedApp(paths);
    if (remainingApp) killProcess(remainingApp.pid, "SIGKILL");
    const remainingBackend = resolveOwnedBackend(paths);
    if (remainingBackend) killProcess(remainingBackend.pid, "SIGKILL");
    signalOwnedDevelopmentProcesses(resolveOwnedApps(paths), "SIGKILL", killProcess);
    signalOwnedDevelopmentProcesses(resolveOwnedBackends(paths), "SIGKILL", killProcess);
    if (runnerPid && matchesRunner(runnerPid, paths.root)) killProcess(runnerPid, "SIGKILL");
    return waitUntilStopped(paths, runnerPid, { ...resolvers, timeoutMs: 2_000 });
  };
  const failStop = async () => {
    await stopBackgroundService();
    throw new Error(
      `Could not stop every owned ${appName} process for ${paths.root}; some are still running.`,
    );
  };
  if (
    !state &&
    !ownedApp &&
    !ownedBackend &&
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
  if (state?.starting) {
    if (await stopBackgroundService()) {
      signalOwnedDevelopmentProcesses(
        [ownedApp, ...ownedApps].filter(Boolean),
        "SIGTERM",
        killProcess,
      );
      signalOwnedDevelopmentProcesses(
        [ownedBackend, ...ownedBackends].filter(Boolean),
        "SIGTERM",
        killProcess,
      );
      const stopped =
        (await waitUntilStopped(paths, null, { ...resolvers, timeoutMs: 2_000 })) ||
        (await forceStopRemaining(null));
      if (!stopped) await failStop();
      NodeFS.rmSync(paths.runnerDir, { recursive: true, force: true });
      removeDevelopmentLaunchFiles(paths.appPidPath, paths.backendPidPath);
      writeLine(`Stopped ${appName} while it was starting for ${paths.root}.`);
      return;
    }
    writeLine(`${appName} is still starting for ${paths.root}; try again shortly.`);
    return;
  }
  if (ownedApp) {
    try {
      killProcess(ownedApp.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
      removeDevelopmentLaunchFiles(paths.appPidPath);
    }
  }
  if (ownedBackend) {
    try {
      killProcess(ownedBackend.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
      removeDevelopmentLaunchFiles(paths.backendPidPath);
    }
  }
  signalOwnedDevelopmentProcesses(ownedApps, "SIGTERM", killProcess);
  signalOwnedDevelopmentProcesses(ownedBackends, "SIGTERM", killProcess);
  if (!state) {
    const stopped =
      (await waitUntilStopped(paths, null, resolvers)) || (await forceStopRemaining(null));
    if (!stopped) await failStop();
    removeDevelopmentLaunchFiles(paths.appPidPath, paths.backendPidPath);
    await stopBackgroundService();
    writeLine(`Stopped orphaned ${appName} app process for ${paths.root}.`);
    return;
  }
  try {
    killProcess(state.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    NodeFS.rmSync(paths.runnerDir, { recursive: true, force: true });
    await stopBackgroundService();
    writeLine(`${appName} is already stopped for ${paths.root}`);
    return;
  }
  const stopped =
    (await waitUntilStopped(paths, state.pid, resolvers)) || (await forceStopRemaining(state.pid));
  if (!stopped) await failStop();
  clearStaleRunner(paths, { matchesRunner });
  removeDevelopmentLaunchFiles(paths.appPidPath, paths.backendPidPath);
  await stopBackgroundService();
  writeLine(`Stopped ${appName} for ${paths.root}.`);
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
  const coldHandoffFlag = flags.find((flag) => flag.startsWith("--cold-handoff="));
  if (
    flags.some((flag) => flag !== "--replace" && flag !== "--stable" && flag !== coldHandoffFlag)
  ) {
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
  if (command === "start")
    return startAppInBackground({
      coldHandoffPath: coldHandoffFlag?.slice("--cold-handoff=".length),
    });
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
