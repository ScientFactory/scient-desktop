import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";

export const PACKAGED_STARTUP_PROCESS_OWNERSHIP_FILE = "packaged-startup-processes.ndjson";

export interface PackagedStartupOwnedProcess {
  readonly schemaVersion: 2;
  readonly pid: number;
  readonly processGroup: boolean;
  readonly authenticator: string;
}

function processOwnershipAuthenticator(
  token: string,
  processDetails: Pick<PackagedStartupOwnedProcess, "pid" | "processGroup">,
): string {
  return createHmac("sha256", token)
    .update(`2\n${processDetails.pid}\n${processDetails.processGroup ? "1" : "0"}`)
    .digest("hex");
}

function authenticatorMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || !/^[0-9a-f]{64}$/i.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

export function resolvePackagedStartupProcessOwnershipPath(scientHome: string): string {
  return join(scientHome, "userdata", PACKAGED_STARTUP_PROCESS_OWNERSHIP_FILE);
}

export function recordPackagedStartupOwnedProcess(
  environment: NodeJS.ProcessEnv,
  processDetails: Pick<PackagedStartupOwnedProcess, "pid" | "processGroup">,
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
        authenticatorMatches(
          processOwnershipAuthenticator(expectedToken, {
            pid: value.pid!,
            processGroup: value.processGroup,
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
