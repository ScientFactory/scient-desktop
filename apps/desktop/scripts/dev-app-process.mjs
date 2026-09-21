import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const SCIENT_DEV_APP_ENV_FILE_ENV = "SCIENT_DEV_APP_ENV_FILE";
export const SCIENT_DEV_APP_PID_FILE_ENV = "SCIENT_DEV_APP_PID_FILE";
export const SCIENT_DEV_APP_LAUNCH_GENERATION_ENV = "SCIENT_DEV_APP_LAUNCH_GENERATION";
export const SCIENT_DEV_BACKEND_PID_FILE_ENV = "SCIENT_DEV_BACKEND_PID_FILE";
export const DEVELOPMENT_LAUNCHES_DIRECTORY = "launches";
export const DEVELOPMENT_LAUNCH_HANDOFF_GRACE_MS = 5_000;

const DEVELOPMENT_LAUNCH_GENERATION_PATTERN = /^[a-f0-9]+(?:-[a-f0-9]+)*$/u;

export function resolveDevelopmentAppLabel(root) {
  const directoryName = NodePath.basename(root);
  const label = directoryName
    .replace(/^scient-desktop(?:-next)?-?/u, "")
    .replace(/-\d{8}$/u, "")
    .trim();
  return label.length > 0 && label !== directoryName ? label : undefined;
}

export function resolveDevelopmentAppDisplayName(environment, root) {
  if (environment.SCIENT_DEV_APP_ROLE === "stable") return "Scient (Dev) Stable";
  const label = environment.SCIENT_DEV_APP_LABEL?.trim() || resolveDevelopmentAppLabel(root);
  return label ? `Scient (Dev) · ${label}` : "Scient (Dev)";
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function writeDevelopmentEnvironmentFile(filePath, environment) {
  const lines = Object.entries(environment)
    .filter(
      ([name, value]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) &&
        name !== SCIENT_DEV_APP_ENV_FILE_ENV &&
        name !== SCIENT_DEV_APP_PID_FILE_ENV &&
        typeof value === "string" &&
        !value.includes("\0"),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `export ${name}=${shellSingleQuote(value)}`);

  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.writeFileSync(filePath, `${lines.join("\n")}\n`, { mode: 0o600 });
}

export function makeMacDevelopmentAppLaunchCommand({
  appBundlePath,
  args,
  environmentFilePath,
  pidFilePath,
}) {
  return {
    command: "/usr/bin/open",
    args: [
      "-n",
      "-W",
      "--env",
      `SCIENT_NEXT_DEV_RUNNER_ACTIVE=1`,
      "--env",
      `${SCIENT_DEV_APP_ENV_FILE_ENV}=${environmentFilePath}`,
      "--env",
      `${SCIENT_DEV_APP_PID_FILE_ENV}=${pidFilePath}`,
      appBundlePath,
      "--args",
      ...args,
    ],
  };
}

export function createDevelopmentLaunchGeneration({
  pid = process.pid,
  sequence = 0,
  randomUUID = NodeCrypto.randomUUID,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Cannot create a development launch generation for PID ${String(pid)}.`);
  }
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error(
      `Cannot create a development launch generation for sequence ${String(sequence)}.`,
    );
  }
  const nonce = randomUUID().replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]+$/u.test(nonce)) {
    throw new Error("Development launch generation UUIDs must contain only hexadecimal digits.");
  }
  return `${pid.toString(16)}-${sequence.toString(16)}-${nonce}`;
}

export function resolveDevelopmentLaunchPaths(runtimeDir, generation) {
  if (!DEVELOPMENT_LAUNCH_GENERATION_PATTERN.test(generation)) {
    throw new Error(`Invalid development launch generation: ${generation}`);
  }
  const launchDir = NodePath.join(runtimeDir, DEVELOPMENT_LAUNCHES_DIRECTORY, generation);
  return {
    generation,
    launchDir,
    launcherPidPath: NodePath.join(launchDir, "launcher.pid"),
    appPidPath: NodePath.join(launchDir, "electron.pid"),
    backendPidPath: NodePath.join(launchDir, "backend.pid"),
    backendPidPendingPath: NodePath.join(launchDir, "backend.pending"),
    environmentFilePath: NodePath.join(launchDir, "environment.sh"),
    legacy: false,
  };
}

export function listDevelopmentLaunchPaths(
  runtimeDir,
  { legacyAppPidPath, legacyBackendPidPath } = {},
) {
  const launchesDir = NodePath.join(runtimeDir, DEVELOPMENT_LAUNCHES_DIRECTORY);
  let entries = [];
  try {
    entries = NodeFS.readdirSync(launchesDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const records = entries
    .filter(
      (entry) => entry.isDirectory() && DEVELOPMENT_LAUNCH_GENERATION_PATTERN.test(entry.name),
    )
    .map((entry) => resolveDevelopmentLaunchPaths(runtimeDir, entry.name))
    .sort((left, right) => left.generation.localeCompare(right.generation));
  if (
    (legacyAppPidPath && NodeFS.existsSync(legacyAppPidPath)) ||
    (legacyBackendPidPath && NodeFS.existsSync(legacyBackendPidPath))
  ) {
    records.unshift({
      generation: "legacy",
      launchDir: null,
      launcherPidPath: null,
      appPidPath: legacyAppPidPath ?? null,
      backendPidPath: legacyBackendPidPath ?? null,
      backendPidPendingPath: null,
      environmentFilePath: null,
      legacy: true,
    });
  }
  return records;
}

export function removeDevelopmentLaunchRecord(record) {
  if (record.launchDir) {
    NodeFS.rmSync(record.launchDir, { recursive: true, force: true });
    return;
  }
  removeDevelopmentLaunchFiles(
    record.launcherPidPath,
    record.appPidPath,
    record.backendPidPath,
    record.environmentFilePath,
  );
}

function readPid(filePath) {
  try {
    const pid = Number.parseInt(NodeFS.readFileSync(filePath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function writeDevelopmentProcessPid(filePath, pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Cannot record invalid development process PID: ${String(pid)}`);
  }
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${String(process.pid)}`;
  NodeFS.writeFileSync(temporaryPath, `${String(pid)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporaryPath, filePath);
}

export function writeDevelopmentLaunchHandoff(record) {
  if (record.legacy || !record.launchDir || !record.backendPidPendingPath) {
    throw new Error("Cannot prepare a backend PID handoff for a legacy development launch.");
  }
  if (!DEVELOPMENT_LAUNCH_GENERATION_PATTERN.test(record.generation)) {
    throw new Error(`Invalid development launch generation: ${record.generation}`);
  }
  NodeFS.mkdirSync(record.launchDir, { recursive: true });
  const temporaryPath = `${record.backendPidPendingPath}.tmp-${String(process.pid)}`;
  try {
    NodeFS.writeFileSync(temporaryPath, `${record.generation}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    NodeFS.renameSync(temporaryPath, record.backendPidPendingPath);
  } finally {
    NodeFS.rmSync(temporaryPath, { force: true });
  }
}

export function readDevelopmentLaunchHandoff(record, { now = Date.now } = {}) {
  if (record.legacy || !record.backendPidPendingPath) return null;
  try {
    const generation = NodeFS.readFileSync(record.backendPidPendingPath, "utf8").trim();
    if (generation !== record.generation) return null;
    const modifiedAt = NodeFS.statSync(record.backendPidPendingPath).mtimeMs;
    return {
      generation,
      ageMs: Math.max(0, now() - modifiedAt),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function developmentLauncherIsActive(launcher) {
  return (
    typeof launcher.pid === "number" &&
    launcher.exitCode === null &&
    (launcher.signalCode === null || launcher.signalCode === undefined)
  );
}

export function inspectProcessCommand(pid, { spawnSync = NodeChildProcess.spawnSync } = {}) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const command = result.stdout.trim();
  return command.length > 0 ? command : null;
}

export function readOwnedDevelopmentAppProcess({
  pidFilePath,
  electronBinaryPath,
  inspectCommand = inspectProcessCommand,
}) {
  if (!pidFilePath) return null;
  const pid = readPid(pidFilePath);
  if (pid === null) return null;
  const command = inspectCommand(pid);
  if (
    command === null ||
    (command !== electronBinaryPath && !command.startsWith(`${electronBinaryPath} `))
  ) {
    return null;
  }
  return { pid, command };
}

/**
 * Resolves backend ownership across the handoff boundary without trusting one
 * stale observation. A publisher writes backend.pid before a consumer removes
 * backend.pending, so a missing marker requires one final validated PID read.
 */
export function inspectDevelopmentBackendOwnership({
  record,
  pidFilePath,
  commandPrefix,
  inspectCommand,
  now,
}) {
  const readBackend = () =>
    readOwnedDevelopmentAppProcess({
      pidFilePath,
      electronBinaryPath: commandPrefix,
      ...(inspectCommand ? { inspectCommand } : {}),
    });
  let backend = readBackend();
  const handoff = readDevelopmentLaunchHandoff(record, now ? { now } : undefined);
  if (!backend && handoff === null) backend = readBackend();
  return { backend, handoff };
}

export function readOwnedDevelopmentLauncherProcess({
  pidFilePath,
  appBundlePath,
  appPidFilePath,
  inspectCommand = inspectProcessCommand,
}) {
  if (!pidFilePath) return null;
  const pid = readPid(pidFilePath);
  if (pid === null) return null;
  const command = inspectCommand(pid);
  if (
    command === null ||
    !command.startsWith("/usr/bin/open ") ||
    !command.includes(appBundlePath) ||
    !command.includes(`${SCIENT_DEV_APP_PID_FILE_ENV}=${appPidFilePath}`)
  ) {
    return null;
  }
  return { pid, command };
}

function inspectChildProcesses(parentPid, { spawnSync = NodeChildProcess.spawnSync } = {}) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match || Number.parseInt(match[2], 10) !== parentPid) return [];
    return [{ pid: Number.parseInt(match[1], 10), command: match[3] }];
  });
}

export function findOwnedDevelopmentChildProcess({
  parentPid,
  commandPrefix,
  inspectChildren = inspectChildProcesses,
}) {
  return (
    inspectChildren(parentPid).find(
      ({ command }) => command === commandPrefix || command.startsWith(`${commandPrefix} `),
    ) ?? null
  );
}

export function waitForOwnedDevelopmentChildProcess(
  input,
  { timeoutMs = 30_000, intervalMs = 25, setTimer = setTimeout } = {},
) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const child = findOwnedDevelopmentChildProcess(input);
      if (child) {
        resolve(child);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(
          new Error(
            `The macOS development app did not publish its owned backend within ${String(timeoutMs)}ms.`,
          ),
        );
        return;
      }
      setTimer(check, intervalMs)?.unref?.();
    };
    check();
  });
}

export function waitForOwnedDevelopmentAppProcess(
  input,
  { timeoutMs = 10_000, intervalMs = 25, setTimer = setTimeout } = {},
) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const process = readOwnedDevelopmentAppProcess(input);
      if (process) {
        resolve(process);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(
          new Error(
            `The macOS development app did not publish an owned process within ${String(timeoutMs)}ms.`,
          ),
        );
        return;
      }
      setTimer(check, intervalMs)?.unref?.();
    };
    check();
  });
}

export function waitForOwnedDevelopmentBackendProcess(
  input,
  {
    timeoutMs = 30_000,
    intervalMs = 25,
    setTimer = setTimeout,
    publishFallbackPid = writeDevelopmentProcessPid,
  } = {},
) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const published = readOwnedDevelopmentAppProcess({
        pidFilePath: input.pidFilePath,
        electronBinaryPath: input.commandPrefix,
        ...(input.inspectCommand ? { inspectCommand: input.inspectCommand } : {}),
      });
      if (published) {
        resolve(published);
        return;
      }
      const fallback = findOwnedDevelopmentChildProcess({
        parentPid: input.parentPid,
        commandPrefix: input.commandPrefix,
        ...(input.inspectChildren ? { inspectChildren: input.inspectChildren } : {}),
      });
      if (fallback) {
        publishFallbackPid(input.pidFilePath, fallback.pid);
        resolve(fallback);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(
          new Error(
            `The macOS development app did not publish its owned backend within ${String(timeoutMs)}ms.`,
          ),
        );
        return;
      }
      setTimer(check, intervalMs)?.unref?.();
    };
    check();
  });
}

export function removeDevelopmentLaunchFiles(...filePaths) {
  for (const filePath of filePaths) {
    if (filePath) NodeFS.rmSync(filePath, { force: true });
  }
}

export async function stopManagedDevelopmentLaunch({
  appPidPromise,
  backendPidPromise,
  appPidFilePath,
  backendPidFilePath,
  electronBinaryPath,
  backendCommandPrefix,
  launcher,
  signalOwnedProcess,
  waitForExit,
  gracefulTimeoutMs,
  forcedTimeoutMs,
  generation = "unknown",
}) {
  await appPidPromise.catch(() => null);
  await backendPidPromise.catch(() => null);

  signalOwnedProcess(backendPidFilePath, backendCommandPrefix, "SIGTERM");
  signalOwnedProcess(appPidFilePath, electronBinaryPath, "SIGTERM");
  if (await waitForExit(gracefulTimeoutMs)) return;

  signalOwnedProcess(backendPidFilePath, backendCommandPrefix, "SIGKILL");
  signalOwnedProcess(appPidFilePath, electronBinaryPath, "SIGKILL");
  if (developmentLauncherIsActive(launcher)) launcher.kill("SIGKILL");
  if (await waitForExit(forcedTimeoutMs)) return;

  throw new Error(`Could not stop managed development launch ${generation}.`);
}

export function createCoalescedRestartScheduler({
  restart,
  debounceMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = (error) => console.error(error instanceof Error ? error.message : String(error)),
}) {
  if (typeof restart !== "function") {
    throw new TypeError("A restart function is required.");
  }
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new TypeError("Restart debounce must be a non-negative finite number.");
  }

  let closed = false;
  let requested = false;
  let timer = null;
  let activeRestart = null;

  const arm = () => {
    if (closed || activeRestart || !requested) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      if (closed || activeRestart || !requested) return;
      requested = false;
      const running = Promise.resolve()
        .then(restart)
        .catch(onError)
        .finally(() => {
          if (activeRestart === running) activeRestart = null;
          if (!closed && requested) arm();
        });
      activeRestart = running;
    }, debounceMs);
    timer?.unref?.();
  };

  return {
    request() {
      if (closed) return;
      requested = true;
      if (activeRestart) return;
      arm();
    },
    async close() {
      closed = true;
      requested = false;
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      await activeRestart;
    },
  };
}
