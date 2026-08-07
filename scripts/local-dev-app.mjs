#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const LOCAL_DEV_APP_NAME = "Scient (Dev)";
export const LOCAL_DEV_APP_STABLE_NAME = "Scient (Dev) Stable";
export const LOCAL_DEV_APP_SCHEMA = "scient-next.local-dev-app/v1";
export const SCIENT_DEV_APP_ROLE_ENV = "SCIENT_DEV_APP_ROLE";
export const SCIENT_NEXT_HOME_ENV = "SCIENT_NEXT_HOME";
export const MACOS_LSREGISTER_PATH =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const RUNNER_START_GRACE_MS = 5_000;

const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const repoRoot = NodePath.resolve(scriptDir, "..");

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
  const cwd = NodeChildProcess.spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
  });
  if (cwd.status !== 0) return false;
  const cwdPath = cwd.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  return cwdPath !== undefined && NodePath.resolve(cwdPath) === NodePath.resolve(root);
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
    logPath: NodePath.join(stateRoot, "local-dev-app.log"),
  };
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

  const cleanup = () => NodeFS.rmSync(paths.runnerDir, { recursive: true, force: true });
  process.once("exit", cleanup);
  const pnpmExecPath = process.env.npm_execpath?.trim();
  const devDesktopArgs = ["dev:desktop"];
  if (paths.role === "stable") {
    devDesktopArgs.push("--home-dir", paths.stateRoot);
  }
  const child = NodeChildProcess.spawn(
    pnpmExecPath ? process.execPath : "pnpm",
    pnpmExecPath ? [pnpmExecPath, ...devDesktopArgs] : devDesktopArgs,
    {
      cwd: paths.root,
      env: process.env,
      stdio: "inherit",
    },
  );

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
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
  writeLine = console.log,
} = {}) {
  const appName = paths.appName ?? LOCAL_DEV_APP_NAME;
  const state = clearStaleRunner(paths, { matchesRunner });
  if (!state) {
    writeLine(`${appName} is stopped for ${paths.root}`);
    return;
  }
  if (state.starting) {
    writeLine(`${appName} is starting for ${paths.root}`);
    return;
  }
  writeLine(`${appName} is running for ${paths.root} (runner PID ${String(state.pid)}).`);
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

export function stopApp({
  paths = resolveLocalDevAppPaths(),
  matchesRunner = processMatchesRunner,
  killProcess = process.kill,
  writeLine = console.log,
} = {}) {
  const appName = paths.appName ?? LOCAL_DEV_APP_NAME;
  const state = clearStaleRunner(paths, { matchesRunner });
  if (!state) {
    writeLine(`${appName} is already stopped for ${paths.root}`);
    return;
  }
  if (state.starting) {
    writeLine(`${appName} is still starting for ${paths.root}; try again shortly.`);
    return;
  }
  try {
    killProcess(state.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    NodeFS.rmSync(paths.runnerDir, { recursive: true, force: true });
    writeLine(`${appName} is already stopped for ${paths.root}`);
    return;
  }
  writeLine(`Requested stop for ${appName} runner PID ${String(state.pid)}.`);
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
  if (command === "install") return installApp({ replace });
  if (command === "logs") return printLogs();
  if (command === "status") return statusApp();
  if (command === "stop") return stopApp();
  if (command === "uninstall") return uninstallApp();
  throw new Error(
    "Usage: node scripts/local-dev-app.mjs <run|install|logs|status|stop|uninstall> [--stable] [--replace]",
  );
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
