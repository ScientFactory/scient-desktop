import { spawn } from "node:child_process";
import { constants as FS_CONSTANTS } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const RELEASE_DIR = resolve(REPO_ROOT, process.env.SCIENT_LINUX_ARTIFACT_DIR || "release");
const DIAGNOSTIC_DIR = resolve(
  REPO_ROOT,
  process.env.SCIENT_LINUX_SMOKE_ARTIFACT_DIR || "test-results/linux-appimage",
);
const STARTUP_TIMEOUT_MS = 45_000;
const ACTION_TIMEOUT_MS = 20_000;
const RECOVERY_TIMEOUT_MS = 30_000;
const GRACEFUL_APP_SHUTDOWN_TIMEOUT_MS = 12_000;
const PRIVATE_DIRECTORY_MODE = 0o700;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitFor(description, operation, timeoutMs = ACTION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== null && result !== false && result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${detail}`);
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback debugging port.");
  }
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

async function findAppImage() {
  const entries = (await readdir(RELEASE_DIR, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".AppImage"),
  );
  if (entries.length !== 1) {
    throw new Error(
      `Expected exactly one AppImage in ${RELEASE_DIR}, found ${entries.map((entry) => entry.name).join(", ") || "none"}.`,
    );
  }
  const appImagePath = join(RELEASE_DIR, entries[0].name);
  await chmod(appImagePath, 0o755);
  await access(appImagePath, FS_CONSTANTS.X_OK);
  return appImagePath;
}

async function readRuntimeState(runtimeStatePath) {
  const contents = await readFile(runtimeStatePath, "utf8");
  const state = JSON.parse(contents);
  if (!Number.isInteger(state.pid) || state.pid <= 0 || typeof state.origin !== "string") {
    throw new Error(`Invalid packaged server runtime state at ${runtimeStatePath}.`);
  }
  return state;
}

async function waitForRuntimeState(runtimeStatePath, predicate = () => true) {
  return waitFor(
    "packaged backend runtime state",
    async () => {
      const state = await readRuntimeState(runtimeStatePath);
      return predicate(state) ? state : null;
    },
    STARTUP_TIMEOUT_MS,
  );
}

async function waitForBackendReady(runtimeState, description, timeoutMs = STARTUP_TIMEOUT_MS) {
  return waitFor(
    description,
    async () => {
      const response = await fetch(`${runtimeState.origin}/health`);
      if (!response.ok) return null;
      const health = await response.json();
      return health?.status === "ok" && health?.startupReady === true ? health : null;
    },
    timeoutMs,
  );
}

async function assertPackagedBackendProcess(pid) {
  const commandLine = (await readFile(`/proc/${pid}/cmdline`))
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (!commandLine.some((argument) => argument.endsWith("apps/server/dist/index.mjs"))) {
    throw new Error(`Refusing to signal unvalidated packaged backend PID ${pid}.`);
  }
}

async function assertPrivateDirectory(directoryPath) {
  const metadata = await stat(directoryPath);
  if (!metadata.isDirectory()) throw new Error(`${directoryPath} is not a directory.`);
  const actualMode = metadata.mode & 0o777;
  if (actualMode !== PRIVATE_DIRECTORY_MODE) {
    throw new Error(
      `Expected private directory ${directoryPath} to use mode 0700, found ${actualMode.toString(8).padStart(4, "0")}.`,
    );
  }
}

async function assertDirectoryMode(directoryPath, expectedMode) {
  const actualMode = (await stat(directoryPath)).mode & 0o777;
  if (actualMode !== expectedMode) {
    throw new Error(
      `Expected ${directoryPath} to retain mode ${expectedMode.toString(8).padStart(4, "0")}, found ${actualMode.toString(8).padStart(4, "0")}.`,
    );
  }
}

async function assertPrivateScientDirectories(scientHome) {
  const stateDir = join(scientHome, "userdata");
  const directories = [
    scientHome,
    stateDir,
    join(stateDir, "secrets"),
    join(stateDir, "attachments"),
    join(stateDir, "logs"),
    join(stateDir, "logs", "provider"),
    join(stateDir, "logs", "terminals"),
    join(scientHome, "worktrees"),
  ];
  await Promise.all(directories.map(assertPrivateDirectory));
}

async function createDirtyScientDirectories(scientHome) {
  const stateDir = join(scientHome, "userdata");
  const directories = [
    scientHome,
    stateDir,
    join(stateDir, "secrets"),
    join(stateDir, "attachments"),
    join(stateDir, "logs"),
    join(stateDir, "logs", "provider"),
    join(stateDir, "logs", "terminals"),
    join(scientHome, "worktrees"),
  ];
  for (const directoryPath of directories) {
    await mkdir(directoryPath, { recursive: true, mode: 0o775 });
    await chmod(directoryPath, 0o775);
  }
}

async function connectToPackagedRenderer(debuggingPort, processOutput) {
  const endpoint = `http://127.0.0.1:${debuggingPort}`;
  await waitFor(
    "Electron remote-debugging endpoint",
    async () => {
      const response = await fetch(`${endpoint}/json/version`);
      return response.ok;
    },
    STARTUP_TIMEOUT_MS,
  ).catch((error) => {
    throw new Error(`${error.message}\nPackaged process output:\n${processOutput()}`);
  });

  const browser = await chromium.connectOverCDP(endpoint, { timeout: STARTUP_TIMEOUT_MS });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Packaged Electron exposed no browser context.");
  const page = await waitFor(
    "Scient packaged renderer",
    async () => {
      const candidate = context.pages().find((current) => current.url().startsWith("scient://"));
      return candidate ?? null;
    },
    STARTUP_TIMEOUT_MS,
  );
  await page.getByRole("button", { name: "Add project", exact: true }).first().waitFor({
    state: "visible",
    timeout: STARTUP_TIMEOUT_MS,
  });
  return { browser, page };
}

async function addProjectByTypedPath(page, workspacePath) {
  await page.keyboard.press("Control+Shift+O");
  const folderDialog = page.getByRole("dialog");
  const pathInput = folderDialog.getByPlaceholder("Enter project path (e.g. ~/projects/my-app)");
  await pathInput.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
  await pathInput.fill(workspacePath);
  await folderDialog
    .getByText(basename(workspacePath), { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
  const addButton = folderDialog.getByRole("button", { name: "Add", exact: true });
  await addButton.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
  if (
    await folderDialog
      .getByText(/SocketOpenError/)
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    throw new Error("Folder browsing failed with SocketOpenError.");
  }
  await addButton.click({ timeout: ACTION_TIMEOUT_MS });
  const emptyProjectChoice = page.getByRole("button", {
    name: /Open an empty project/,
  });
  await emptyProjectChoice.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
  await emptyProjectChoice.click({ timeout: ACTION_TIMEOUT_MS });
}

async function waitForPersistedProject(databasePath, workspacePath) {
  const { DatabaseSync } = await import("node:sqlite");
  return waitFor("project persistence", async () => {
    let database;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      const row = database
        .prepare("SELECT workspace_root FROM projection_projects WHERE workspace_root = ? LIMIT 1")
        .get(workspacePath);
      return row?.workspace_root === workspacePath;
    } finally {
      database?.close();
    }
  });
}

function processGroupIsAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function stopPackagedApp(child, backendProcessGroupId) {
  if (!child.pid) return;
  const processGroupIds = [...new Set([child.pid, backendProcessGroupId].filter(Boolean))];
  const livingProcessGroups = () =>
    processGroupIds.filter((processGroupId) => processGroupIsAlive(processGroupId));
  const waitForAllGroupsToExit = (timeoutMs) =>
    waitFor(
      "packaged Electron and backend process groups to exit",
      () => livingProcessGroups().length === 0,
      timeoutMs,
    ).catch(() => false);

  if (await waitForAllGroupsToExit(GRACEFUL_APP_SHUTDOWN_TIMEOUT_MS)) return;

  const gracefulSurvivors = livingProcessGroups();
  for (const processGroupId of gracefulSurvivors) {
    signalProcessGroup(processGroupId, "SIGTERM");
  }
  if (!(await waitForAllGroupsToExit(5_000))) {
    for (const processGroupId of livingProcessGroups()) {
      signalProcessGroup(processGroupId, "SIGKILL");
    }
    if (!(await waitForAllGroupsToExit(5_000))) {
      throw new Error(
        `Packaged process groups ${livingProcessGroups().join(", ")} survived SIGKILL.`,
      );
    }
  }
  throw new Error(
    `Packaged application required forced cleanup after its ${GRACEFUL_APP_SHUTDOWN_TIMEOUT_MS}ms graceful shutdown window; surviving process groups: ${gracefulSurvivors.join(", ")}.`,
  );
}

async function preserveFailureDiagnostics({
  scenarioName,
  page,
  output,
  desktopLogPath,
  serverLogPath,
  runtimeStatePath,
}) {
  await mkdir(DIAGNOSTIC_DIR, { recursive: true });
  await writeFile(join(DIAGNOSTIC_DIR, `${scenarioName}-process.log`), `${output}\n`, "utf8");
  await page
    ?.screenshot({ path: join(DIAGNOSTIC_DIR, `${scenarioName}.png`), fullPage: true })
    .catch(() => undefined);
  await copyFile(desktopLogPath, join(DIAGNOSTIC_DIR, `${scenarioName}-desktop-main.log`)).catch(
    () => undefined,
  );
  await copyFile(serverLogPath, join(DIAGNOSTIC_DIR, `${scenarioName}-server-child.log`)).catch(
    () => undefined,
  );
  await copyFile(
    runtimeStatePath,
    join(DIAGNOSTIC_DIR, `${scenarioName}-server-runtime.json`),
  ).catch(() => undefined);
}

async function runScenario(appImagePath, scenario) {
  const scenarioRoot = await mkdtemp(join(tmpdir(), `scient-appimage-${scenario.name}-`));
  const homeDir = join(scenarioRoot, "home");
  const configHome = join(scenarioRoot, "config");
  const cacheHome = join(scenarioRoot, "cache");
  const dataHome = join(scenarioRoot, "data");
  const runtimeDir = join(scenarioRoot, "runtime");
  const scientHome = join(scenarioRoot, "scient-home");
  const firstWorkspace = join(homeDir, `${scenario.name}-first-project`);
  const secondWorkspace = join(homeDir, `${scenario.name}-after-recovery`);
  const runtimeStatePath = join(scientHome, "userdata", "server-runtime.json");
  const databasePath = join(scientHome, "userdata", "state.sqlite");
  const desktopLogPath = join(scientHome, "userdata", "logs", "desktop-main.log");
  const serverLogPath = join(scientHome, "userdata", "logs", "server-child.log");
  let browser;
  let child;
  let page;
  let backendProcessGroupId;
  let output = "";
  let scenarioError;
  const cleanupErrors = [];

  try {
    await mkdir(homeDir, { recursive: true });
    await mkdir(configHome, { recursive: true });
    await mkdir(cacheHome, { recursive: true });
    await mkdir(dataHome, { recursive: true });
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    await chmod(runtimeDir, 0o700);
    await mkdir(firstWorkspace, { mode: 0o775 });
    await chmod(firstWorkspace, 0o775);
    if (scenario.crashBackend) {
      await mkdir(secondWorkspace, { mode: 0o775 });
      await chmod(secondWorkspace, 0o775);
    }
    if (scenario.precreatePermissiveState) await createDirtyScientDirectories(scientHome);

    const debuggingPort = await reservePort();
    const previousUmask = process.umask(scenario.umask);
    try {
      child = spawn(
        "xvfb-run",
        [
          "-a",
          appImagePath,
          `--remote-debugging-port=${debuggingPort}`,
          "--remote-debugging-address=127.0.0.1",
          "--disable-gpu",
        ],
        {
          detached: true,
          env: {
            ...process.env,
            HOME: homeDir,
            SCIENT_HOME: scientHome,
            SYNARA_DISABLE_AUTO_UPDATE: "1",
            XDG_CACHE_HOME: cacheHome,
            XDG_CONFIG_HOME: configHome,
            XDG_DATA_HOME: dataHome,
            XDG_RUNTIME_DIR: runtimeDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } finally {
      process.umask(previousUmask);
    }

    const recordOutput = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-200_000);
    };
    child.stdout?.on("data", recordOutput);
    child.stderr?.on("data", recordOutput);
    child.once("exit", (code, signal) => {
      if (code !== null && code !== 0) recordOutput(`\n[xvfb-run exited code=${code}]`);
      if (signal) recordOutput(`\n[xvfb-run exited signal=${signal}]`);
    });

    const renderer = await connectToPackagedRenderer(debuggingPort, () => output);
    browser = renderer.browser;
    page = renderer.page;
    page.on("console", (message) => {
      recordOutput(`\n[renderer:${message.type()}] ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      recordOutput(`\n[renderer:pageerror] ${error.stack || error.message}`);
    });
    const initialRuntime = await waitForRuntimeState(runtimeStatePath);
    backendProcessGroupId = initialRuntime.pid;
    await waitForBackendReady(
      initialRuntime,
      "first packaged backend generation readiness",
      STARTUP_TIMEOUT_MS,
    );

    await addProjectByTypedPath(page, firstWorkspace);
    await waitForPersistedProject(databasePath, firstWorkspace);
    await assertPrivateScientDirectories(scientHome);
    await assertDirectoryMode(firstWorkspace, 0o775);

    if (scenario.crashBackend) {
      await assertPackagedBackendProcess(initialRuntime.pid);
      process.kill(initialRuntime.pid, "SIGKILL");
      const recoveredRuntime = await waitForRuntimeState(
        runtimeStatePath,
        (state) => state.pid !== initialRuntime.pid,
      );
      backendProcessGroupId = recoveredRuntime.pid;
      await waitForBackendReady(
        recoveredRuntime,
        "second packaged backend generation readiness",
        RECOVERY_TIMEOUT_MS,
      );

      await addProjectByTypedPath(page, secondWorkspace);
      await waitForPersistedProject(databasePath, secondWorkspace);
      await assertDirectoryMode(secondWorkspace, 0o775);
      await assertPackagedBackendProcess(recoveredRuntime.pid);
      process.kill(recoveredRuntime.pid, 0);
      await delay(1_500);
      const finalRuntime = await readRuntimeState(runtimeStatePath);
      if (finalRuntime.pid !== recoveredRuntime.pid) {
        throw new Error("Packaged backend restarted more than once after the controlled crash.");
      }
      const desktopLog = await readFile(desktopLogPath, "utf8");
      const restartCount = desktopLog.match(/backend exited unexpectedly/g)?.length ?? 0;
      if (restartCount !== 1) {
        throw new Error(`Expected one controlled backend restart, observed ${restartCount}.`);
      }
    }

    console.log(`Packaged Linux scenario passed: ${scenario.name}`);
  } catch (error) {
    await preserveFailureDiagnostics({
      scenarioName: scenario.name,
      page,
      output,
      desktopLogPath,
      serverLogPath,
      runtimeStatePath,
    }).catch(() => undefined);
    scenarioError = new Error(
      `${scenario.name} failed: ${error instanceof Error ? error.stack || error.message : String(error)}\nPackaged process output:\n${output}`,
      { cause: error },
    );
  } finally {
    await browser?.close().catch((error) => cleanupErrors.push(error));
    if (child) {
      await stopPackagedApp(child, backendProcessGroupId).catch((error) =>
        cleanupErrors.push(error),
      );
    }
    if (cleanupErrors.length > 0) {
      await preserveFailureDiagnostics({
        scenarioName: scenario.name,
        page,
        output,
        desktopLogPath,
        serverLogPath,
        runtimeStatePath,
      }).catch(() => undefined);
    }
    await rm(scenarioRoot, { recursive: true, force: true }).catch((error) =>
      cleanupErrors.push(error),
    );
  }
  if (scenarioError || cleanupErrors.length > 0) {
    const errors = [scenarioError, ...cleanupErrors].filter(Boolean);
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(errors, `${scenario.name} failed and cleanup was incomplete.`);
  }
}

async function main() {
  if (process.platform !== "linux") {
    throw new Error("The packaged AppImage smoke test must run on Linux.");
  }
  const appImagePath = await findAppImage();
  console.log(`Testing packaged AppImage: ${basename(appImagePath)}`);
  await runScenario(appImagePath, {
    name: "fresh-profile",
    umask: 0o022,
    precreatePermissiveState: false,
    crashBackend: false,
  });
  await runScenario(appImagePath, {
    name: "shared-group-umask",
    umask: 0o002,
    precreatePermissiveState: true,
    crashBackend: true,
  });
}

await main();
