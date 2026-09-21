import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  desktopDir,
  resolveDevProtocolClient,
  resolveElectronLaunchCommand,
} from "./electron-launcher.mjs";
import {
  createCoalescedRestartScheduler,
  createDevelopmentLaunchGeneration,
  developmentLauncherIsActive,
  inspectDevelopmentBackendOwnership,
  inspectProcessCommand,
  makeMacDevelopmentAppLaunchCommand,
  readDevelopmentLaunchHandoff,
  readOwnedDevelopmentAppProcess,
  removeDevelopmentLaunchFiles,
  removeDevelopmentLaunchRecord,
  resolveDevelopmentLaunchPaths,
  SCIENT_DEV_APP_ENV_FILE_ENV,
  SCIENT_DEV_APP_LAUNCH_GENERATION_ENV,
  SCIENT_DEV_APP_PID_FILE_ENV,
  SCIENT_DEV_BACKEND_PID_FILE_ENV,
  stopManagedDevelopmentLaunch,
  waitForOwnedDevelopmentBackendProcess,
  waitForOwnedDevelopmentChildProcess,
  waitForOwnedDevelopmentAppProcess,
  writeDevelopmentEnvironmentFile,
  writeDevelopmentLaunchHandoff,
  writeDevelopmentProcessPid,
} from "./dev-app-process.mjs";
import { waitForResources } from "./wait-for-resources.mjs";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
if (!devServerUrl) {
  throw new Error("VITE_DEV_SERVER_URL is required for desktop development.");
}

const devServer = new URL(devServerUrl);
const port = Number.parseInt(devServer.port, 10);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`VITE_DEV_SERVER_URL must include an explicit port: ${devServerUrl}`);
}

const requiredFiles = [
  "dist-electron/main.cjs",
  "dist-electron/electron/WindowsForegroundFocusWorker.cjs",
  "dist-electron/preload.cjs",
  "dist-electron/snapShot/GlobalShiftShortcutWorker.cjs",
  "dist-electron/snapShot/RegionSnapShotWorker.cjs",
  "dist-electron/snapShot/SnapShotAccessibilityWorker.cjs",
  "../server/dist/bin.mjs",
];
const watchedDirectories = [
  { directory: "dist-electron", files: new Set(["main.cjs", "preload.cjs"]) },
  {
    directory: "dist-electron/electron",
    files: new Set(["WindowsForegroundFocusWorker.cjs"]),
  },
  {
    directory: "dist-electron/snapShot",
    files: new Set([
      "GlobalShiftShortcutWorker.cjs",
      "RegionSnapShotWorker.cjs",
      "SnapShotAccessibilityWorker.cjs",
    ]),
  },
  { directory: "../server/dist", files: new Set(["bin.mjs"]) },
];
const forcedShutdownTimeoutMs = 10_000;
const restartDebounceMs = 120;
const remoteDebuggingPort = process.env.T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT?.trim();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone dev script has no Effect runtime.
const hostPlatform = NodeOS.platform();
const managedByLocalDevApp = process.env.SCIENT_LOCAL_DEV_APP_MANAGED === "1";

NodeChildProcess.execFileSync(
  process.execPath,
  [NodePath.join(desktopDir, "scripts/build-browser-secret.mjs")],
  { stdio: "inherit" },
);

await waitForResources({
  baseDir: desktopDir,
  files: requiredFiles,
  tcpHost: devServer.hostname,
  tcpPort: port,
});

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv[SCIENT_DEV_APP_ENV_FILE_ENV];
delete childEnv[SCIENT_DEV_APP_PID_FILE_ENV];
delete childEnv[SCIENT_DEV_APP_LAUNCH_GENERATION_ENV];
delete childEnv[SCIENT_DEV_BACKEND_PID_FILE_ENV];
childEnv.SCIENT_NEXT_SAFETY_ENVELOPE = "true";
childEnv.SCIENT_NEXT_DEV_RUNNER_ACTIVE = "1";
const devProtocolClient = resolveDevProtocolClient();
if (devProtocolClient) {
  childEnv.T3CODE_DESKTOP_APP_USER_MODEL_ID = devProtocolClient.appBundleId;
  childEnv.T3CODE_DESKTOP_PROTOCOL_REGISTRATION_MANAGED = "1";
}
if (managedByLocalDevApp && hostPlatform === "darwin" && !devProtocolClient) {
  throw new Error("The managed macOS development app requires a generated app bundle.");
}

const configuredAppPidFilePath =
  process.env.SCIENT_DEV_APP_PID_FILE?.trim() ||
  NodePath.join(
    childEnv.SCIENT_NEXT_HOME ?? NodePath.resolve(desktopDir, "..", "..", ".scient-next"),
    "local-dev-app-runtime",
    "electron.pid",
  );
const launchStateDir = NodePath.dirname(configuredAppPidFilePath);
const backendEntryPath = NodePath.resolve(desktopDir, "..", "server", "dist", "bin.mjs");

let shuttingDown = false;
let currentApp = null;
const expectedExits = new WeakSet();
const watchers = [];
let launchSequence = 0;

function cleanupLaunchFiles(app) {
  const { launchPaths } = app;
  removeDevelopmentLaunchFiles(launchPaths.environmentFilePath);
  const launcherActive = developmentLauncherIsActive(app.launcher);
  if (!launcherActive) {
    removeDevelopmentLaunchFiles(launchPaths.launcherPidPath);
  }
  const owned = app.electronBinaryPath
    ? readOwnedDevelopmentAppProcess({
        pidFilePath: launchPaths.appPidPath,
        electronBinaryPath: app.electronBinaryPath,
      })
    : null;
  if (!owned) removeDevelopmentLaunchFiles(launchPaths.appPidPath);
  const backendOwnership = app.backendCommandPrefix
    ? inspectDevelopmentBackendOwnership({
        record: launchPaths,
        pidFilePath: launchPaths.backendPidPath,
        commandPrefix: app.backendCommandPrefix,
      })
    : { backend: null, handoff: readDevelopmentLaunchHandoff(launchPaths) };
  const ownedBackend = backendOwnership.backend;
  const handoffPending = backendOwnership.handoff !== null;
  if (!ownedBackend && !handoffPending) {
    removeDevelopmentLaunchFiles(launchPaths.backendPidPath);
  }
  if (!launcherActive && !owned && !ownedBackend && !handoffPending) {
    removeDevelopmentLaunchRecord(launchPaths);
  }
  return { launcherActive, ownedApp: owned, ownedBackend, handoffPending };
}

function signalOwnedProcess(pidFilePath, commandPrefix, signal) {
  if (!commandPrefix) return;
  const owned = readOwnedDevelopmentAppProcess({
    pidFilePath,
    electronBinaryPath: commandPrefix,
  });
  if (!owned) return;
  try {
    process.kill(owned.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function signalCapturedBackend(app, signal) {
  const backend = app.ownedBackend;
  if (!backend || !app.backendCommandPrefix) return;
  const command = inspectProcessCommand(backend.pid);
  if (
    command === null ||
    (command !== app.backendCommandPrefix && !command.startsWith(`${app.backendCommandPrefix} `))
  ) {
    return;
  }
  try {
    process.kill(backend.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForManagedProcessesToExit(app, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ownedApp = readOwnedDevelopmentAppProcess({
      pidFilePath: app.launchPaths.appPidPath,
      electronBinaryPath: app.electronBinaryPath,
    });
    const ownedBackend = readOwnedDevelopmentAppProcess({
      pidFilePath: app.launchPaths.backendPidPath,
      electronBinaryPath: app.backendCommandPrefix,
    });
    if (!ownedApp && !ownedBackend && !developmentLauncherIsActive(app.launcher)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function startApp() {
  if (shuttingDown || currentApp !== null) {
    return;
  }

  const electronArgs = remoteDebuggingPort
    ? [`--remote-debugging-port=${remoteDebuggingPort}`]
    : [];
  const launchArgs = devProtocolClient
    ? electronArgs
    : [...electronArgs, `--t3code-dev-root=${desktopDir}`, "dist-electron/main.cjs"];
  launchSequence += 1;
  const launchPaths = resolveDevelopmentLaunchPaths(
    launchStateDir,
    createDevelopmentLaunchGeneration({ sequence: launchSequence }),
  );
  const managedMacLaunch = managedByLocalDevApp && hostPlatform === "darwin";
  let electronCommand;
  let pidPromise;
  let backendPidPromise = Promise.resolve(null);
  let electronBinaryPath;
  let backendCommandPrefix;
  if (managedMacLaunch && devProtocolClient) {
    removeDevelopmentLaunchRecord(launchPaths);
    writeDevelopmentLaunchHandoff(launchPaths);
    writeDevelopmentEnvironmentFile(launchPaths.environmentFilePath, {
      ...childEnv,
      [SCIENT_DEV_APP_LAUNCH_GENERATION_ENV]: launchPaths.generation,
      [SCIENT_DEV_BACKEND_PID_FILE_ENV]: launchPaths.backendPidPath,
    });
    electronBinaryPath = NodePath.join(
      devProtocolClient.appBundlePath,
      "Contents",
      "MacOS",
      "Electron",
    );
    electronCommand = makeMacDevelopmentAppLaunchCommand({
      appBundlePath: devProtocolClient.appBundlePath,
      args: electronArgs,
      environmentFilePath: launchPaths.environmentFilePath,
      pidFilePath: launchPaths.appPidPath,
    });
    pidPromise = waitForOwnedDevelopmentAppProcess({
      pidFilePath: launchPaths.appPidPath,
      electronBinaryPath,
    });
    backendCommandPrefix = `${electronBinaryPath} ${backendEntryPath}`;
    backendPidPromise = pidPromise.then((ownedApp) =>
      waitForOwnedDevelopmentBackendProcess({
        parentPid: ownedApp.pid,
        pidFilePath: launchPaths.backendPidPath,
        commandPrefix: backendCommandPrefix,
      }).then((ownedBackend) => {
        removeDevelopmentLaunchFiles(launchPaths.backendPidPendingPath);
        return ownedBackend;
      }),
    );
  } else {
    electronCommand = resolveElectronLaunchCommand(launchArgs);
    removeDevelopmentLaunchRecord(launchPaths);
    pidPromise = Promise.resolve(null);
  }
  const launcher = NodeChildProcess.spawn(
    electronCommand.command ?? electronCommand.electronPath,
    electronCommand.args,
    {
      cwd: desktopDir,
      env: managedMacLaunch ? process.env : childEnv,
      stdio: "inherit",
    },
  );
  if (managedMacLaunch && typeof launcher.pid === "number") {
    writeDevelopmentProcessPid(launchPaths.launcherPidPath, launcher.pid);
  }
  if (!managedMacLaunch && hostPlatform !== "win32" && typeof launcher.pid === "number") {
    backendCommandPrefix = `${electronCommand.electronPath} ${backendEntryPath}`;
    backendPidPromise = waitForOwnedDevelopmentChildProcess({
      parentPid: launcher.pid,
      commandPrefix: backendCommandPrefix,
    });
  }

  const app = {
    launcher,
    managedMacLaunch,
    launchPaths,
    electronBinaryPath,
    backendCommandPrefix,
    pidPromise,
    backendPidPromise,
    ownedBackend: null,
  };
  currentApp = app;

  if (managedMacLaunch) {
    void pidPromise
      .then((owned) => {
        if (owned) {
          console.log(
            `[desktop-launcher] appPid=${String(owned.pid)} bundle=${devProtocolClient?.appBundlePath ?? "unknown"}`,
          );
        }
      })
      .catch((error) => {
        if (currentApp === app && !shuttingDown) {
          console.error(error instanceof Error ? error.message : String(error));
        }
      });
    void backendPidPromise
      .then((owned) => {
        app.ownedBackend = owned;
        if (owned) console.log(`[desktop-launcher] backendPid=${String(owned.pid)}`);
      })
      .catch((error) => {
        if (currentApp === app && !shuttingDown) {
          console.error(error instanceof Error ? error.message : String(error));
        }
      });
  } else {
    void backendPidPromise
      .then((owned) => {
        app.ownedBackend = owned;
      })
      .catch(() => undefined);
  }

  launcher.once("error", () => {
    const ownership = cleanupLaunchFiles(app);
    if (
      currentApp === app &&
      !ownership.launcherActive &&
      !ownership.ownedApp &&
      !ownership.ownedBackend &&
      !ownership.handoffPending
    ) {
      currentApp = null;
    }

    if (!shuttingDown && !expectedExits.has(launcher)) {
      restartScheduler.request();
    }
  });

  launcher.once("exit", (code, signal) => {
    if (!app.managedMacLaunch) {
      signalCapturedBackend(app, "SIGTERM");
    }
    const ownership = cleanupLaunchFiles(app);
    const hasRetainedLaunch = Boolean(
      ownership.ownedApp || ownership.ownedBackend || ownership.handoffPending,
    );
    if (currentApp === app && !hasRetainedLaunch) {
      currentApp = null;
    }

    const exitedAbnormally = signal !== null || code !== 0 || hasRetainedLaunch;
    if (!shuttingDown && !expectedExits.has(launcher) && exitedAbnormally) {
      restartScheduler.request();
    }
  });
}

async function stopApp() {
  const app = currentApp;
  if (!app) {
    return;
  }

  expectedExits.add(app.launcher);

  if (app.managedMacLaunch && app.electronBinaryPath && app.backendCommandPrefix) {
    await stopManagedDevelopmentLaunch({
      appPidPromise: app.pidPromise,
      backendPidPromise: app.backendPidPromise,
      appPidFilePath: app.launchPaths.appPidPath,
      backendPidFilePath: app.launchPaths.backendPidPath,
      electronBinaryPath: app.electronBinaryPath,
      backendCommandPrefix: app.backendCommandPrefix,
      launcher: app.launcher,
      signalOwnedProcess,
      waitForExit: (timeoutMs) => waitForManagedProcessesToExit(app, timeoutMs),
      gracefulTimeoutMs: forcedShutdownTimeoutMs,
      forcedTimeoutMs: 2_000,
      generation: app.launchPaths.generation,
    });
    if (currentApp === app) currentApp = null;
    cleanupLaunchFiles(app);
    return;
  }

  currentApp = null;

  await new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    app.launcher.once("exit", finish);
    app.launcher.kill("SIGTERM");
    signalCapturedBackend(app, "SIGTERM");

    setTimeout(() => {
      if (settled) {
        return;
      }

      if (developmentLauncherIsActive(app.launcher)) app.launcher.kill("SIGKILL");
      signalCapturedBackend(app, "SIGKILL");
      finish();
    }, forcedShutdownTimeoutMs).unref();
  }).finally(() => cleanupLaunchFiles(app));
}

const restartScheduler = createCoalescedRestartScheduler({
  debounceMs: restartDebounceMs,
  restart: async () => {
    await stopApp();
    if (!shuttingDown) startApp();
  },
});

function startWatchers() {
  for (const { directory, files } of watchedDirectories) {
    const watcher = NodeFS.watch(
      NodePath.join(desktopDir, directory),
      { persistent: true },
      (_eventType, filename) => {
        if (typeof filename !== "string" || !files.has(filename)) {
          return;
        }

        restartScheduler.request();
      },
    );

    watchers.push(watcher);
  }
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const watcher of watchers) {
    watcher.close();
  }

  await restartScheduler.close();
  await stopApp();

  process.exit(exitCode);
}

startWatchers();
startApp();

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
process.once("SIGHUP", () => {
  void shutdown(129);
});
