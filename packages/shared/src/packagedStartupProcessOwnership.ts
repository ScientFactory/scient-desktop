import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { dirname, join, win32 } from "node:path";

import { resolveWindowsSystemRoot } from "./windowsProcess";

export const PACKAGED_STARTUP_PROCESS_OWNERSHIP_FILE = "packaged-startup-processes.ndjson";

export interface PackagedStartupOwnedProcess {
  readonly schemaVersion: 2;
  readonly pid: number;
  readonly processGroup: boolean;
  readonly instanceId: string;
  readonly authenticator: string;
}

function processOwnershipAuthenticator(
  token: string,
  processDetails: Pick<PackagedStartupOwnedProcess, "pid" | "processGroup" | "instanceId">,
): string {
  return createHmac("sha256", token)
    .update(
      `2\n${processDetails.pid}\n${processDetails.processGroup ? "1" : "0"}\n${processDetails.instanceId}`,
    )
    .digest("hex");
}

function authenticatorMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || !/^[0-9a-f]{64}$/i.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

export function resolvePackagedStartupProcessOwnershipPath(scientHome: string): string {
  return join(scientHome, "userdata", PACKAGED_STARTUP_PROCESS_OWNERSHIP_FILE);
}

export function readWindowsProcessInstanceId(
  pid: number,
  environment: NodeJS.ProcessEnv = process.env,
  runProcess: typeof spawnSync = spawnSync,
): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const powershell = win32.join(
    resolveWindowsSystemRoot(environment),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script =
    `$ErrorActionPreference = 'Stop'; ` +
    `((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks).ToString([Globalization.CultureInfo]::InvariantCulture)`;
  const result = runProcess(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      shell: false,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
  const instanceId = result.stdout.trim();
  return /^\d{10,32}$/.test(instanceId) ? instanceId : null;
}

export function recordPackagedStartupOwnedProcess(
  environment: NodeJS.ProcessEnv,
  processDetails: Pick<PackagedStartupOwnedProcess, "pid" | "processGroup" | "instanceId">,
): void {
  if (environment.SCIENT_PACKAGED_STARTUP_SMOKE !== "1") return;
  const scientHome = environment.SCIENT_HOME?.trim();
  const token = environment.SCIENT_PACKAGED_STARTUP_CLEANUP_TOKEN?.trim();
  if (!scientHome || !token || token.length < 32) {
    throw new Error("Packaged startup process ownership requires isolated home and cleanup token.");
  }
  if (!Number.isSafeInteger(processDetails.pid) || processDetails.pid <= 0) {
    throw new Error("Packaged startup process ownership requires a positive PID.");
  }
  if (!/^\d{10,32}$/.test(processDetails.instanceId)) {
    throw new Error("Packaged startup process ownership requires a process instance id.");
  }
  const path = resolvePackagedStartupProcessOwnershipPath(scientHome);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record: PackagedStartupOwnedProcess = {
    schemaVersion: 2,
    ...processDetails,
    authenticator: processOwnershipAuthenticator(token, processDetails),
  };
  appendFileSync(path, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function readPackagedStartupOwnedProcesses(
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<PackagedStartupOwnedProcess> {
  const scientHome = environment.SCIENT_HOME?.trim();
  const expectedToken = environment.SCIENT_PACKAGED_STARTUP_CLEANUP_TOKEN?.trim();
  if (!scientHome || !expectedToken) return [];
  let contents: string;
  try {
    contents = readFileSync(resolvePackagedStartupProcessOwnershipPath(scientHome), "utf8");
  } catch {
    return [];
  }
  const records: PackagedStartupOwnedProcess[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<PackagedStartupOwnedProcess>;
      if (
        value.schemaVersion === 2 &&
        Number.isSafeInteger(value.pid) &&
        (value.pid ?? 0) > 0 &&
        typeof value.processGroup === "boolean" &&
        typeof value.instanceId === "string" &&
        /^\d{10,32}$/.test(value.instanceId) &&
        authenticatorMatches(
          processOwnershipAuthenticator(expectedToken, {
            pid: value.pid!,
            processGroup: value.processGroup,
            instanceId: value.instanceId,
          }),
          value.authenticator,
        )
      ) {
        records.push(value as PackagedStartupOwnedProcess);
      }
    } catch {
      // A crash can truncate the final append. Earlier complete capability
      // records remain authoritative and malformed lines grant no authority.
    }
  }
  return records.filter(
    (record, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.pid === record.pid && candidate.processGroup === record.processGroup,
      ) === index,
  );
}
