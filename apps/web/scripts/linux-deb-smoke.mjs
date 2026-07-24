import { spawn, spawnSync } from "node:child_process";
import { constants as FS_CONSTANTS } from "node:fs";
import {
  access,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { sanitizePackagedDesktopInheritedEnvironment } from "../../../scripts/verify-packaged-desktop-startup.ts";

import {
  assertSandboxedPackagedArguments,
  fetchWithinDeadline,
  waitFor,
} from "./linux-packaged-smoke-support.mjs";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const RELEASE_DIR = resolve(REPO_ROOT, process.env.SCIENT_LINUX_ARTIFACT_DIR || "release");
const DIAGNOSTIC_DIR = resolve(
  REPO_ROOT,
  process.env.SCIENT_LINUX_SMOKE_ARTIFACT_DIR || "test-results/linux-deb",
);
const DEBIAN_PACKAGE_NAME = "scient";
const INSTALLED_APP_DIRECTORY = "/opt/Scient";
const INSTALLED_EXECUTABLE = join(INSTALLED_APP_DIRECTORY, "scient");
const INSTALLED_SANDBOX_HELPER = join(INSTALLED_APP_DIRECTORY, "chrome-sandbox");
const BUNDLED_APPARMOR_PROFILE = join(INSTALLED_APP_DIRECTORY, "resources", "apparmor-profile");
const INSTALLED_APPARMOR_PROFILE = "/etc/apparmor.d/scient";
const STARTUP_TIMEOUT_MS = 45_000;
const ACTION_TIMEOUT_MS = 20_000;
const RECOVERY_TIMEOUT_MS = 30_000;
const GRACEFUL_APP_SHUTDOWN_TIMEOUT_MS = 12_000;
const DIAGNOSTIC_CAPTURE_TIMEOUT_MS = 5_000;
const PRIVATE_DIRECTORY_MODE = 0o700;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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

function runCommand(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    if (allowFailure && result.error.code === "ENOENT") return result;
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  if (!allowFailure && result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}${detail ? `:\n${detail}` : "."}`,
    );
  }
  return result;
}

async function findDebianPackage() {
  const entries = (await readdir(RELEASE_DIR, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".deb"),
  );
  if (entries.length !== 1) {
    throw new Error(
      `Expected exactly one Debian package in ${RELEASE_DIR}, found ${entries.map((entry) => entry.name).join(", ") || "none"}.`,
    );
  }
  const packagePath = join(RELEASE_DIR, entries[0].name);
  await access(packagePath, FS_CONSTANTS.R_OK);
  return packagePath;
}

function readDebianPackageField(packagePath, field) {
  return runCommand("dpkg-deb", ["--field", packagePath, field]).stdout.trim();
}

function assertNoExistingScientInstallation() {
  const result = runCommand("dpkg-query", ["--show", DEBIAN_PACKAGE_NAME], {
    allowFailure: true,
  });
  if (result.status === 0) {
    throw new Error(
      "Refusing to replace an existing system Scient installation during packaged acceptance.",
    );
  }
}

async function assertInstalledDebianSandbox(packagePath) {
  const packageName = readDebianPackageField(packagePath, "Package");
  const architecture = readDebianPackageField(packagePath, "Architecture");
  if (packageName !== DEBIAN_PACKAGE_NAME) {
    throw new Error(`Expected Debian package ${DEBIAN_PACKAGE_NAME}, found ${packageName}.`);
  }
  if (architecture !== "amd64") {
    throw new Error(`Expected Debian architecture amd64, found ${architecture}.`);
  }

  const executableMetadata = await stat(INSTALLED_EXECUTABLE);
  if (
    !executableMetadata.isFile() ||
    executableMetadata.uid !== 0 ||
    (executableMetadata.mode & 0o7777) !== 0o755
  ) {
    throw new Error(
      `Expected ${INSTALLED_EXECUTABLE} to be a root-owned regular file with exact mode 0755.`,
    );
  }
  await access(INSTALLED_EXECUTABLE, FS_CONSTANTS.X_OK);

  const sandboxMetadata = await stat(INSTALLED_SANDBOX_HELPER);
  const sandboxMode = sandboxMetadata.mode & 0o7777;
  if (
    !sandboxMetadata.isFile() ||
    sandboxMetadata.uid !== 0 ||
    (sandboxMode !== 0o755 && sandboxMode !== 0o4755)
  ) {
    throw new Error(
      `Expected ${INSTALLED_SANDBOX_HELPER} to be root-owned, regular, and exact mode 0755 or 4755; found ${sandboxMode.toString(8).padStart(4, "0")}.`,
    );
  }

  const bundledProfile = await readFile(BUNDLED_APPARMOR_PROFILE, "utf8");
  if (
    !bundledProfile.includes(`"${INSTALLED_EXECUTABLE}"`) ||
    !bundledProfile.includes("userns,")
  ) {
    throw new Error(
      `Bundled AppArmor profile ${BUNDLED_APPARMOR_PROFILE} does not grant user namespaces to the exact Scient executable.`,
    );
  }

  const appArmorEnabled =
    runCommand("apparmor_status", ["--enabled"], {
      allowFailure: true,
    }).status === 0;
  if (appArmorEnabled) {
    const profile = await readFile(INSTALLED_APPARMOR_PROFILE, "utf8");
    if (!profile.includes(`"${INSTALLED_EXECUTABLE}"`) || !profile.includes("userns,")) {
      throw new Error(
        `Installed AppArmor profile ${INSTALLED_APPARMOR_PROFILE} does not grant user namespaces to the exact Scient executable.`,
      );
    }
  }
}

function installDebianPackage(packagePath) {
  runCommand("sudo", [
    "env",
    "DEBIAN_FRONTEND=noninteractive",
    "apt-get",
    "install",
    "--yes",
    packagePath,
  ]);
}

function uninstallDebianPackage() {
  const query = runCommand("dpkg-query", ["--show", DEBIAN_PACKAGE_NAME], {
    allowFailure: true,
  });
  if (query.status !== 0) return;
  runCommand("sudo", [
    "env",
    "DEBIAN_FRONTEND=noninteractive",
    "apt-get",
    "purge",
    "--yes",
    DEBIAN_PACKAGE_NAME,
  ]);
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
    ({ deadline }) =>
      fetchWithinDeadline(`${runtimeState.origin}/health`, {
        deadline,
        consume: async (response) => {
          if (!response.ok) return null;
          const health = await response.json();
          return health?.status === "ok" && health?.startupReady === true ? health : null;
        },
      }),
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
    ({ deadline }) =>
      fetchWithinDeadline(`${endpoint}/json/version`, {
        deadline,
        consume: (response) => response.ok,
      }),
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
  const addButton = folderDialog.getByRole("button", { name: /^Add\b/u });
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

function signalProcess(processId, signal) {
  try {
    process.kill(processId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function readLinuxProcessInfo(processId) {
  const [statContents, statusContents, commandLineContents, executablePath] = await Promise.all([
    readFile(`/proc/${processId}/stat`, "utf8"),
    readFile(`/proc/${processId}/status`, "utf8"),
    readFile(`/proc/${processId}/cmdline`),
    readlink(`/proc/${processId}/exe`),
  ]);
  const commandEnd = statContents.lastIndexOf(")");
  if (commandEnd < 0) throw new Error(`Invalid /proc stat data for PID ${processId}.`);
  const statFields = statContents
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u);
  const parentProcessId = Number(statFields[1]);
  const processGroupId = Number(statFields[2]);
  const startTimeTicks = statFields[19];
  if (!Number.isInteger(parentProcessId) || !Number.isInteger(processGroupId) || !startTimeTicks) {
    throw new Error(`Incomplete /proc stat identity for PID ${processId}.`);
  }
  const uid = Number(/^Uid:\s+(\d+)/mu.exec(statusContents)?.[1]);
  if (!Number.isInteger(uid))
    throw new Error(`Incomplete /proc user identity for PID ${processId}.`);
  return {
    processId,
    parentProcessId,
    processGroupId,
    startTimeTicks,
    uid,
    executablePath,
    commandLine: commandLineContents.toString("utf8").split("\0").filter(Boolean),
  };
}

async function processIdentityMatches(expectedProcess) {
  try {
    const currentProcess = await readLinuxProcessInfo(expectedProcess.processId);
    return (
      currentProcess.startTimeTicks === expectedProcess.startTimeTicks &&
      currentProcess.executablePath === expectedProcess.executablePath
    );
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return false;
    throw error;
  }
}

async function findPackagedElectronProcess(launcherProcessId, debuggingPort) {
  return waitFor("packaged Electron main process", async () => {
    const processEntries = (await readdir("/proc", { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && /^\d+$/u.test(entry.name),
    );
    const processes = new Map();
    await Promise.all(
      processEntries.map(async (entry) => {
        const processId = Number(entry.name);
        try {
          processes.set(processId, await readLinuxProcessInfo(processId));
        } catch {
          // Processes can exit while /proc is being inspected.
        }
      }),
    );

    const isDescendantOf = (processId, ancestorProcessId) => {
      const visited = new Set();
      let currentProcessId = processId;
      while (currentProcessId > 1 && !visited.has(currentProcessId)) {
        visited.add(currentProcessId);
        const parentProcessId = processes.get(currentProcessId)?.parentProcessId;
        if (parentProcessId === ancestorProcessId) return true;
        if (!parentProcessId) return false;
        currentProcessId = parentProcessId;
      }
      return false;
    };

    const debuggingArgument = `--remote-debugging-port=${debuggingPort}`;
    const candidates = [...processes.entries()].filter(
      ([processId, processInfo]) =>
        isDescendantOf(processId, launcherProcessId) &&
        basename(processInfo.executablePath) === "scient" &&
        processInfo.commandLine.includes(debuggingArgument) &&
        !processInfo.commandLine.some((argument) => argument.startsWith("--type=")),
    );
    const deepestCandidates = candidates.filter(([candidateProcessId]) =>
      candidates.every(
        ([otherProcessId]) =>
          otherProcessId === candidateProcessId ||
          !isDescendantOf(otherProcessId, candidateProcessId),
      ),
    );
    if (deepestCandidates.length > 1) {
      throw new Error(
        `Found multiple packaged Electron main-process candidates: ${candidates
          .map(([processId]) => processId)
          .join(", ")}.`,
      );
    }
    return deepestCandidates[0]?.[1] ?? null;
  });
}

async function captureProcessGroupMembers(processGroupIds) {
  const processGroupIdSet = new Set(processGroupIds);
  const membersByProcessGroup = new Map(
    processGroupIds.map((processGroupId) => [processGroupId, []]),
  );
  const processEntries = (await readdir("/proc", { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && /^\d+$/u.test(entry.name),
  );
  await Promise.all(
    processEntries.map(async (entry) => {
      try {
        const processInfo = await readLinuxProcessInfo(Number(entry.name));
        if (processGroupIdSet.has(processInfo.processGroupId)) {
          membersByProcessGroup.get(processInfo.processGroupId)?.push(processInfo);
        }
      } catch {
        // Processes can exit while /proc is being inspected.
      }
    }),
  );
  return membersByProcessGroup;
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { name: "NonError", message: String(error) };
}

function serializeProcessGroups(membersByProcessGroup) {
  return [...membersByProcessGroup].map(([processGroupId, members]) => ({
    processGroupId,
    members,
  }));
}

async function stopPackagedApp(child, electronProcess, backendProcessGroupId, cleanupDiagnostics) {
  if (!child.pid) return;
  cleanupDiagnostics.launcherProcessId = child.pid;
  cleanupDiagnostics.launcherProcess = await readLinuxProcessInfo(child.pid).catch((error) => {
    cleanupDiagnostics.identityReadErrors.push({
      processId: child.pid,
      error: serializeError(error),
    });
    return null;
  });
  cleanupDiagnostics.electronProcess = electronProcess ?? null;
  cleanupDiagnostics.backendProcessGroupId = backendProcessGroupId ?? null;
  const processGroupIds = [
    ...new Set([child.pid, electronProcess?.processGroupId, backendProcessGroupId].filter(Boolean)),
  ];
  cleanupDiagnostics.processGroupIds = processGroupIds;
  const trackedProcessGroups = await captureProcessGroupMembers(processGroupIds);
  cleanupDiagnostics.trackedProcessGroups = serializeProcessGroups(trackedProcessGroups);
  const captureLivingProcessGroups = async (phase) => {
    const livingGroups = [];
    for (const [processGroupId, originalMembers] of trackedProcessGroups) {
      const identityMatches = await Promise.all(originalMembers.map(processIdentityMatches));
      const livingMembers = originalMembers.filter((_, index) => identityMatches[index]);
      if (livingMembers.length > 0) {
        livingGroups.push({ processGroupId, members: livingMembers });
      }
    }
    cleanupDiagnostics.survivors[phase] = livingGroups;
    return livingGroups.map(({ processGroupId }) => processGroupId);
  };
  const waitForAllGroupsToExit = (timeoutMs) =>
    waitFor(
      "packaged Electron and backend process groups to exit",
      async () => (await captureLivingProcessGroups("latest-poll")).length === 0,
      timeoutMs,
    ).catch(() => false);

  if (electronProcess && (await processIdentityMatches(electronProcess))) {
    cleanupDiagnostics.signals.push({ target: electronProcess.processId, signal: "SIGTERM" });
    signalProcess(electronProcess.processId, "SIGTERM");
  }
  if (await waitForAllGroupsToExit(GRACEFUL_APP_SHUTDOWN_TIMEOUT_MS)) {
    cleanupDiagnostics.result = "graceful";
    await captureLivingProcessGroups("after-graceful-window");
    return;
  }

  const gracefulSurvivors = await captureLivingProcessGroups("after-graceful-window");
  for (const processGroupId of gracefulSurvivors) {
    cleanupDiagnostics.signals.push({ target: -processGroupId, signal: "SIGTERM" });
    signalProcessGroup(processGroupId, "SIGTERM");
  }
  if (!(await waitForAllGroupsToExit(5_000))) {
    const termSurvivors = await captureLivingProcessGroups("after-group-sigterm");
    for (const processGroupId of termSurvivors) {
      cleanupDiagnostics.signals.push({ target: -processGroupId, signal: "SIGKILL" });
      signalProcessGroup(processGroupId, "SIGKILL");
    }
    if (!(await waitForAllGroupsToExit(5_000))) {
      const killSurvivors = await captureLivingProcessGroups("after-group-sigkill");
      cleanupDiagnostics.result = "survived-sigkill";
      throw new Error(`Packaged process groups ${killSurvivors.join(", ")} survived SIGKILL.`);
    }
  }
  cleanupDiagnostics.result = "forced-cleanup";
  throw new Error(
    `Packaged application required forced cleanup after its ${GRACEFUL_APP_SHUTDOWN_TIMEOUT_MS}ms graceful shutdown window; surviving process groups: ${gracefulSurvivors.join(", ")}.`,
  );
}

async function preserveFailureDiagnostics({
  scenarioName,
  screenshot,
  output,
  desktopLogPath,
  serverLogPath,
  runtimeStatePath,
  cleanupDiagnostics,
}) {
  await mkdir(DIAGNOSTIC_DIR, { recursive: true });
  await writeFile(join(DIAGNOSTIC_DIR, `${scenarioName}-process.log`), `${output}\n`, "utf8");
  if (screenshot) {
    await writeFile(join(DIAGNOSTIC_DIR, `${scenarioName}.png`), screenshot);
  }
  await writeFile(
    join(DIAGNOSTIC_DIR, `${scenarioName}-cleanup.json`),
    `${JSON.stringify(cleanupDiagnostics, null, 2)}\n`,
    "utf8",
  );
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

async function runScenario(executablePath, scenario) {
  const scenarioRoot = await mkdtemp(join(tmpdir(), `scient-deb-${scenario.name}-`));
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
  let electronProcess;
  let backendProcessGroupId;
  let output = "";
  let scenarioError;
  let finalScreenshot;
  const cleanupErrors = [];
  const cleanupDiagnostics = {
    scenarioName: scenario.name,
    launcherProcessId: null,
    launcherProcess: null,
    electronProcess: null,
    backendProcessGroupId: null,
    processGroupIds: [],
    trackedProcessGroups: [],
    survivors: {},
    signals: [],
    identityReadErrors: [],
    screenshotError: null,
    scenarioError: null,
    errors: [],
    result: "not-started",
  };

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
    const packagedArguments = [
      `--remote-debugging-port=${debuggingPort}`,
      "--remote-debugging-address=127.0.0.1",
      "--disable-gpu",
    ];
    assertSandboxedPackagedArguments(packagedArguments);
    const previousUmask = process.umask(scenario.umask);
    try {
      child = spawn("xvfb-run", ["-a", executablePath, ...packagedArguments], {
        detached: true,
        cwd: dirname(executablePath),
        env: {
          ...sanitizePackagedDesktopInheritedEnvironment(process.env),
          HOME: homeDir,
          SCIENT_HOME: scientHome,
          SYNARA_DISABLE_AUTO_UPDATE: "1",
          XDG_CACHE_HOME: cacheHome,
          XDG_CONFIG_HOME: configHome,
          XDG_DATA_HOME: dataHome,
          XDG_RUNTIME_DIR: runtimeDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
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
    electronProcess = await findPackagedElectronProcess(child.pid, debuggingPort);
    if (electronProcess.executablePath !== executablePath) {
      throw new Error(
        `Expected packaged Electron to run ${executablePath}, found ${electronProcess.executablePath}.`,
      );
    }
    if (electronProcess.uid !== process.getuid?.()) {
      throw new Error(
        `Expected packaged Electron to run as uid ${process.getuid?.()}, found ${electronProcess.uid}.`,
      );
    }
    assertSandboxedPackagedArguments(electronProcess.commandLine);
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
    scenarioError = new Error(
      `${scenario.name} failed: ${error instanceof Error ? error.stack || error.message : String(error)}\nPackaged process output:\n${output}`,
      { cause: error },
    );
    cleanupDiagnostics.scenarioError = serializeError(scenarioError);
  } finally {
    finalScreenshot = await page
      ?.screenshot({ fullPage: true, timeout: DIAGNOSTIC_CAPTURE_TIMEOUT_MS })
      .catch((error) => {
        cleanupDiagnostics.screenshotError = serializeError(error);
        return undefined;
      });
    await browser?.close().catch((error) => cleanupErrors.push(error));
    if (child) {
      await stopPackagedApp(
        child,
        electronProcess,
        backendProcessGroupId,
        cleanupDiagnostics,
      ).catch((error) => cleanupErrors.push(error));
    }
    cleanupDiagnostics.errors = cleanupErrors.map(serializeError);
    let diagnosticsPreserved = false;
    if (scenarioError || cleanupErrors.length > 0) {
      await preserveFailureDiagnostics({
        scenarioName: scenario.name,
        screenshot: finalScreenshot,
        output,
        desktopLogPath,
        serverLogPath,
        runtimeStatePath,
        cleanupDiagnostics,
      }).catch(() => undefined);
      diagnosticsPreserved = true;
    }
    await rm(scenarioRoot, { recursive: true, force: true }).catch((error) =>
      cleanupErrors.push(error),
    );
    if (cleanupDiagnostics.errors.length !== cleanupErrors.length) {
      cleanupDiagnostics.errors = cleanupErrors.map(serializeError);
      if (diagnosticsPreserved) {
        await writeFile(
          join(DIAGNOSTIC_DIR, `${scenario.name}-cleanup.json`),
          `${JSON.stringify(cleanupDiagnostics, null, 2)}\n`,
          "utf8",
        ).catch(() => undefined);
      } else {
        await preserveFailureDiagnostics({
          scenarioName: scenario.name,
          screenshot: finalScreenshot,
          output,
          desktopLogPath,
          serverLogPath,
          runtimeStatePath,
          cleanupDiagnostics,
        }).catch(() => undefined);
      }
    }
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
    throw new Error("The installed Debian-package smoke test must run on Linux.");
  }
  const packagePath = await findDebianPackage();
  console.log(`Testing installed Debian package: ${basename(packagePath)}`);
  assertNoExistingScientInstallation();
  let installationAttempted = false;
  try {
    installationAttempted = true;
    installDebianPackage(packagePath);
    await assertInstalledDebianSandbox(packagePath);
    await runScenario(INSTALLED_EXECUTABLE, {
      name: "fresh-profile",
      umask: 0o022,
      precreatePermissiveState: false,
      crashBackend: false,
    });
    await runScenario(INSTALLED_EXECUTABLE, {
      name: "shared-group-umask",
      umask: 0o002,
      precreatePermissiveState: true,
      crashBackend: true,
    });
  } finally {
    if (installationAttempted) {
      uninstallDebianPackage();
      await access(INSTALLED_EXECUTABLE).then(
        () => {
          throw new Error(`Debian package removal left ${INSTALLED_EXECUTABLE} installed.`);
        },
        (error) => {
          if (error?.code !== "ENOENT") throw error;
        },
      );
      await access(INSTALLED_APPARMOR_PROFILE).then(
        () => {
          throw new Error(`Debian package removal left ${INSTALLED_APPARMOR_PROFILE} installed.`);
        },
        (error) => {
          if (error?.code !== "ENOENT") throw error;
        },
      );
    }
  }
}

await main();
