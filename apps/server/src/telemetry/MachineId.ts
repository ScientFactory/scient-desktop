import * as HostProcess from "@t3tools/shared/HostProcess";
import { hashTelemetryId } from "@t3tools/shared/telemetryId";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";
import type { TelemetryOwner } from "./Identify.ts";

const LINUX_MACHINE_ID_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"];

export function parseDarwinPlatformUuid(output: string): string | null {
  return output.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/u)?.[1] ?? null;
}

export function parseWindowsMachineGuid(output: string): string | null {
  return output.match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{36})/u)?.[1] ?? null;
}

const probe = Effect.fn("MachineId.probe")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const runner = yield* Effect.serviceOption(ProcessRunner.ProcessRunner);
  if (Option.isNone(runner)) return null;
  return yield* runner.value
    .run({ command, args, timeout: "5 seconds", timeoutBehavior: "timedOutResult" })
    .pipe(
      Effect.map((result) => (result.code === 0 ? result.stdout : null)),
      Effect.orElseSucceed(() => null),
    );
});

const readLinuxMachineId = Effect.fn("MachineId.readLinux")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const path of LINUX_MACHINE_ID_PATHS) {
    const value = yield* fileSystem.readFileString(path).pipe(
      Effect.map((contents) => contents.trim()),
      Effect.orElseSucceed(() => ""),
    );
    if (/^[0-9a-f]{32}$/u.test(value)) return value;
  }
  return null;
});

/** The operating system's own id for this computer; it survives reinstalling Scient. */
const readMachineId = Effect.fn("MachineId.read")(function* () {
  switch (yield* HostProcess.Platform) {
    case "darwin": {
      const output = yield* probe("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
      return output === null ? null : parseDarwinPlatformUuid(output);
    }
    case "win32": {
      const output = yield* probe("reg.exe", [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
      ]);
      return output === null ? null : parseWindowsMachineGuid(output);
    }
    case "linux":
      return yield* readLinuxMachineId();
    default:
      return null;
  }
});

/** The computer as an owner, hashed like every other owner id. */
export const getMachineOwners = readMachineId().pipe(
  Effect.map((machineId): ReadonlyArray<TelemetryOwner> =>
    machineId === null
      ? []
      : [{ source: "device", ownerId: hashTelemetryId(machineId.toLowerCase()) }],
  ),
  Effect.orElseSucceed((): ReadonlyArray<TelemetryOwner> => []),
);
