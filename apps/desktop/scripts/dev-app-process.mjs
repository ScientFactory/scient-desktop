import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const SCIENT_DEV_APP_ENV_FILE_ENV = "SCIENT_DEV_APP_ENV_FILE";
export const SCIENT_DEV_APP_PID_FILE_ENV = "SCIENT_DEV_APP_PID_FILE";

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

export function inspectChildProcesses(parentPid, { spawnSync = NodeChildProcess.spawnSync } = {}) {
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

export function removeDevelopmentLaunchFiles(...filePaths) {
  for (const filePath of filePaths) {
    if (filePath) NodeFS.rmSync(filePath, { force: true });
  }
}
