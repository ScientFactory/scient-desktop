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
  inspectProcessCommand,
  makeMacDevelopmentAppLaunchCommand,
  readOwnedDevelopmentAppProcess,
  removeDevelopmentLaunchFiles,
  waitForOwnedDevelopmentChildProcess,
  waitForOwnedDevelopmentAppProcess,
  writeDevelopmentEnvironmentFile,
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
  "dist-electron/preload.cjs",
  "../server/dist/bin.mjs",
];
const watchedDirectories = [
  { directory: "dist-electron", files: new Set(["main.cjs", "preload.cjs"]) },
  { directory: "../server/dist", files: new Set(["bin.mjs"]) },
];
const forcedShutdownTimeoutMs = 10_000;
const restartDebounceMs = 120;
const remoteDebuggingPort = process.env.T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT?.trim();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone dev script has no Effect runtime.
const hostPlatform = NodeOS.platform();
const managedByLocalDevApp = process.env.SCIENT_LOCAL_DEV_APP_MANAGED === "1";

await waitForResources({
  baseDir: desktopDir,
  files: requiredFiles,
  tcpHost: devServer.hostname,
  tcpPort: port,
});

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
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

const appPidFilePath =
  process.env.SCIENT_DEV_APP_PID_FILE?.trim() ||
  NodePath.join(
    childEnv.SCIENT_NEXT_HOME ?? NodePath.resolve(desktopDir, "..", "..", ".scient-next"),
    "local-dev-app-runtime",
    "electron.pid",
  );
const launchStateDir = NodePath.dirname(appPidFilePath);
const backendPidFilePath = NodePath.join(launchStateDir, "backend.pid");
const backendEntryPath = NodePath.resolve(desktopDir, "..", "server", "dist", "bin.mjs");

let shuttingDown = false;
let restartTimer = null;
let currentApp = null;
let restartQueue = Promise.resolve();
const expectedExits = new WeakSet();
const watchers = [];
let launchSequence = 0;

function cleanupLaunchFiles(app) {
  removeDevelopmentLaunchFiles(app.environmentFilePath);
  const owned = app.electronBinaryPath
    ? readOwnedDevelopmentAppProcess({
        pidFilePath: appPidFilePath,
        electronBinaryPath: app.electronBinaryPath,
      })
    : null;
  if (!owned) removeDevelopmentLaunchFiles(appPidFilePath);
  const ownedBackend = app.backendCommandPrefix
    ? readOwnedDevelopmentAppProcess({
        pidFilePath: backendPidFilePath,
        electronBinaryPath: app.backendCommandPrefix,
      })
    : null;
  if (!ownedBackend) removeDevelopmentLaunchFiles(backendPidFilePath);
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
      pidFilePath: appPidFilePath,
      electronBinaryPath: app.electronBinaryPath,
    });
    const ownedBackend = readOwnedDevelopmentAppProcess({
      pidFilePath: backendPidFilePath,
      electronBinaryPath: app.backendCommandPrefix,
    });
    if (!ownedApp && !ownedBackend && app.launcher.exitCode !== null) return true;
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
  const environmentFilePath = NodePath.join(
    launchStateDir,
    `electron-environment-${String(process.pid)}-${String(launchSequence)}.sh`,
  );
  const managedMacLaunch = managedByLocalDevApp && hostPlatform === "darwin";
  let electronCommand;
  let pidPromise;
  let backendPidPromise = Promise.resolve(null);
  let electronBinaryPath;
  let backendCommandPrefix;
  if (managedMacLaunch && devProtocolClient) {
    removeDevelopmentLaunchFiles(appPidFilePath, backendPidFilePath, environmentFilePath);
    writeDevelopmentEnvironmentFile(environmentFilePath, childEnv);
    electronBinaryPath = NodePath.join(
      devProtocolClient.appBundlePath,
      "Contents",
      "MacOS",
      "Electron",
    );
    electronCommand = makeMacDevelopmentAppLaunchCommand({
      appBundlePath: devProtocolClient.appBundlePath,
      args: electronArgs,
      environmentFilePath,
      pidFilePath: appPidFilePath,
    });
    pidPromise = waitForOwnedDevelopmentAppProcess({
      pidFilePath: appPidFilePath,
      electronBinaryPath,
    });
    backendCommandPrefix = `${electronBinaryPath} ${backendEntryPath}`;
    backendPidPromise = pidPromise.then((ownedApp) =>
      waitForOwnedDevelopmentChildProcess({
        parentPid: ownedApp.pid,
        commandPrefix: backendCommandPrefix,
      }).then((ownedBackend) => {
        writeDevelopmentProcessPid(backendPidFilePath, ownedBackend.pid);
        return ownedBackend;
      }),
    );
  } else {
    electronCommand = resolveElectronLaunchCommand(launchArgs);
    removeDevelopmentLaunchFiles(environmentFilePath);
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
    environmentFilePath,
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
    cleanupLaunchFiles(app);
    if (currentApp === app) {
      currentApp = null;
    }

    if (!shuttingDown) {
      scheduleRestart();
    }
  });

  launcher.once("exit", (code, signal) => {
    if (!app.managedMacLaunch) {
      signalCapturedBackend(app, "SIGTERM");
    }
    cleanupLaunchFiles(app);
    if (currentApp === app) {
      currentApp = null;
    }

    const exitedAbnormally = signal !== null || code !== 0;
    if (!shuttingDown && !expectedExits.has(launcher) && exitedAbnormally) {
      scheduleRestart();
    }
  });
}

async function stopApp() {
  const app = currentApp;
  if (!app) {
    return;
  }

  currentApp = null;
  expectedExits.add(app.launcher);

  if (app.managedMacLaunch && app.electronBinaryPath && app.backendCommandPrefix) {
    await app.pidPromise.catch(() => null);
    signalOwnedProcess(appPidFilePath, app.electronBinaryPath, "SIGTERM");
    signalOwnedProcess(backendPidFilePath, app.backendCommandPrefix, "SIGTERM");
    if (!(await waitForManagedProcessesToExit(app, forcedShutdownTimeoutMs))) {
      signalOwnedProcess(appPidFilePath, app.electronBinaryPath, "SIGKILL");
      signalOwnedProcess(backendPidFilePath, app.backendCommandPrefix, "SIGKILL");
      if (app.launcher.exitCode === null) app.launcher.kill("SIGKILL");
      await waitForManagedProcessesToExit(app, 2_000);
    }
    cleanupLaunchFiles(app);
    return;
  }

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

      if (app.launcher.exitCode === null) app.launcher.kill("SIGKILL");
      signalCapturedBackend(app, "SIGKILL");
      finish();
    }, forcedShutdownTimeoutMs).unref();
  }).finally(() => cleanupLaunchFiles(app));
}

function scheduleRestart() {
  if (shuttingDown) {
    return;
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartQueue = restartQueue
      .catch(() => undefined)
      .then(async () => {
        await stopApp();
        if (!shuttingDown) {
          startApp();
        }
      });
  }, restartDebounceMs);
}

function startWatchers() {
  for (const { directory, files } of watchedDirectories) {
    const watcher = NodeFS.watch(
      NodePath.join(desktopDir, directory),
      { persistent: true },
      (_eventType, filename) => {
        if (typeof filename !== "string" || !files.has(filename)) {
          return;
        }

        scheduleRestart();
      },
    );

    watchers.push(watcher);
  }
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  for (const watcher of watchers) {
    watcher.close();
  }

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
