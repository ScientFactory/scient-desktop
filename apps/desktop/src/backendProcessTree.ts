import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import path from "node:path";

import { resolveWindowsSystemRoot } from "@synara/shared/windowsProcess";

export interface ForceTerminateBackendProcessTreeOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  readonly spawnProcess?: typeof spawn;
}

export function backendProcessContainmentOptions(
  captureLogs: boolean,
  platform: NodeJS.Platform = process.platform,
): Pick<SpawnOptions, "detached" | "stdio"> {
  return {
    detached: platform !== "win32",
    stdio: captureLogs
      ? ["ignore", "pipe", "pipe", "ipc"]
      : ["ignore", "inherit", "inherit", "ipc"],
  };
}

function ignoreMissingProcess(error: unknown): void {
  if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
}

async function forceTerminateWindowsTree(
  pid: number,
  options: ForceTerminateBackendProcessTreeOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  const taskkill = path.win32.join(resolveWindowsSystemRoot(env), "System32", "taskkill.exe");
  const child = (options.spawnProcess ?? spawn)(taskkill, ["/PID", String(pid), "/T", "/F"], {
    env,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`taskkill exited with status ${code ?? "null"}`));
    });
  });
}

/** Force-kills the backend and all descendants after graceful IPC shutdown timed out. */
export async function forceTerminateBackendProcessTree(
  child: Pick<ChildProcess, "pid">,
  options: ForceTerminateBackendProcessTreeOptions = {},
): Promise<void> {
  const pid = child.pid;
  if (!pid || pid <= 0) return;

  if ((options.platform ?? process.platform) === "win32") {
    await forceTerminateWindowsTree(pid, options);
    return;
  }

  try {
    (options.killProcessGroup ?? process.kill)(-pid, "SIGKILL");
  } catch (error) {
    ignoreMissingProcess(error);
  }
}
