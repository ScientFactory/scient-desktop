// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { nativeLinuxFileIdentity } from "./NativeFilePublication.ts";
import { windowsFileIdentity } from "./WindowsNativeFile.ts";

const DecimalFileId = Schema.String.check(Schema.isPattern(/^\d{1,40}$/u));
const MacFields = {
  volume: Schema.String.check(
    Schema.isPattern(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u),
  ),
  fileId: DecimalFileId,
};
const LegacyMacIdentity = Schema.Struct({
  ...MacFields,
  platform: Schema.optionalKey(Schema.Never),
  version: Schema.optionalKey(Schema.Never),
});
const PersistentIdentity = Schema.Union([
  Schema.Struct({ ...MacFields, version: Schema.Literal(1), platform: Schema.Literal("darwin") }),
  Schema.Struct({
    version: Schema.Literal(1),
    platform: Schema.Literal("linux"),
    volume: Schema.NonEmptyString,
    fileId: DecimalFileId,
    // Absent only in records written before it was read; those compare by inode alone.
    generation: Schema.optionalKey(DecimalFileId),
    subvolumeId: Schema.NullOr(DecimalFileId),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    platform: Schema.Literal("windows"),
    volume: Schema.NonEmptyString,
    fileId: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{32}$/u)),
  }),
]);
export type PersistentFileIdentity = typeof PersistentIdentity.Type;
/** Legacy macOS records decode without adding tags or changing their decimal file IDs. */
export const StoredFileIdentity = Schema.Union([PersistentIdentity, LegacyMacIdentity]);
export type StoredFileIdentity = typeof StoredFileIdentity.Type;
export type VolumeIdentityResolver = (path: string) => Promise<string | null>;
/** A volume's identity, or why there is none: for the log, never for the user. */
export type VolumeReading =
  | { readonly volume: string }
  | { readonly volume: null; readonly reason: string };
type Ran = { readonly stdout: string } | { readonly failure: string };
export type CommandRunner = (file: string, args: ReadonlyArray<string>) => Promise<Ran>;

const runCommand: CommandRunner = (file, args) => {
  const started = performance.now();
  return new Promise((resolve) =>
    NodeChildProcess.execFile(
      file,
      args,
      { timeout: 10_000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ stdout });
        const how =
          typeof error.code === "number"
            ? `exited ${error.code}`
            : error.signal
              ? `was killed (${error.signal})`
              : `failed (${error.code ?? error.message})`;
        const said = String(stderr).trim().split("\n")[0];
        const elapsed = Math.round(performance.now() - started);
        resolve({
          failure: `${NodePath.basename(file)} ${how} after ${elapsed} ms${said ? `: ${said}` : ""}`,
        });
      },
    ),
  );
};

/** Reads once; `final` marks an answer a second read would not change. */
async function readMacVolume(
  path: string,
  run: CommandRunner,
): Promise<VolumeReading & { readonly final?: true }> {
  const df = await run("/bin/df", ["-P", path]);
  if ("failure" in df) return { volume: null, reason: df.failure };
  const device = df.stdout.split("\n")[1]?.split(/\s+/u)[0];
  if (device === undefined || !device.startsWith("/dev/"))
    return { volume: null, reason: `df names ${device ?? "no device"}, not a disk`, final: true };
  const info = await run("/usr/sbin/diskutil", ["info", "-plist", device]);
  if ("failure" in info) return { volume: null, reason: `${info.failure} (${device})` };
  const uuid = info.stdout.match(
    /<key>VolumeUUID<\/key>\s*<string>([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})<\/string>/u,
  )?.[1];
  return uuid === undefined
    ? { volume: null, reason: `diskutil reported no VolumeUUID for ${device}` }
    : { volume: uuid.toUpperCase() };
}

/** One query can fail on a busy Mac (seen on CI runners), so a failed read is retried once. */
export async function macVolumeReading(
  path: string,
  run: CommandRunner = runCommand,
): Promise<VolumeReading> {
  const first = await readMacVolume(path, run);
  if (first.volume !== null) return { volume: first.volume };
  if (first.final) return { volume: null, reason: first.reason };
  const second = await readMacVolume(path, run);
  return second.volume !== null
    ? { volume: second.volume }
    : { volume: null, reason: `${second.reason}; first try: ${first.reason}` };
}

const readVolume = async (path: string, helperPath?: string): Promise<VolumeReading> => {
  const platform = HostProcess.Platform.defaultValue();
  if (platform === "darwin") return macVolumeReading(path);
  let volume: string | null = null;
  if (platform === "linux")
    volume = (await nativeLinuxFileIdentity(path, false, helperPath))?.identity?.volume ?? null;
  else if (platform === "win32") {
    const identity = await windowsFileIdentity(path, helperPath);
    volume = identity ? `\\\\?\\Volume{${identity.dev}}\\` : null;
  }
  return volume === null
    ? { volume: null, reason: `no volume identity on ${platform}` }
    : { volume };
};
const volumeIdentity = async (path: string, helperPath?: string): Promise<string | null> =>
  (await readVolume(path, helperPath)).volume;

async function persistentIdentity(
  path: string,
  directoryOnly: boolean,
  volume: VolumeIdentityResolver,
  helperPath?: string,
): Promise<PersistentFileIdentity | null> {
  if (HostProcess.Platform.defaultValue() === "linux")
    return (await nativeLinuxFileIdentity(path, directoryOnly, helperPath))?.identity ?? null;
  if (HostProcess.Platform.defaultValue() === "win32") {
    const identity = await windowsFileIdentity(path, helperPath);
    if (!identity || (directoryOnly && identity.type !== "directory")) return null;
    return {
      version: 1,
      platform: "windows",
      volume: `\\\\?\\Volume{${identity.dev}}\\`,
      fileId: identity.ino,
    };
  }
  if (HostProcess.Platform.defaultValue() !== "darwin") return null;
  const stat = await NodeFSP.lstat(path, { bigint: true }).catch(() => null);
  if (
    stat === null ||
    (directoryOnly ? !stat.isDirectory() : !stat.isDirectory() && !stat.isFile())
  )
    return null;
  const uuid = await volume(path);
  return uuid === null
    ? null
    : { version: 1, platform: "darwin", volume: uuid, fileId: String(stat.ino) };
}

export const platformFileIdentity = {
  volume: volumeIdentity,
  /** `volume`, with why there is none. */
  readVolume,
  /** Process-local only: device numbers may change across remounts. */
  async key(path: string): Promise<string> {
    if (HostProcess.Platform.defaultValue() === "win32") {
      const identity = await windowsFileIdentity(path);
      if (!identity) throw new Error("File identity is unavailable.");
      return `${identity.dev}:${identity.ino}`;
    }
    const stat = await NodeFSP.stat(path, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  },
  persistent(path: string, volume: VolumeIdentityResolver = volumeIdentity, helperPath?: string) {
    return persistentIdentity(path, false, volume, helperPath);
  },
  directory(path: string, volume: VolumeIdentityResolver = volumeIdentity, helperPath?: string) {
    return persistentIdentity(path, true, volume, helperPath);
  },
  equal(left: StoredFileIdentity, right: StoredFileIdentity): boolean {
    const platform = (value: typeof left) => value.platform ?? "darwin";
    const subvolume = (value: typeof left) => ("subvolumeId" in value ? value.subvolumeId : null);
    const generation = (value: typeof left) => ("generation" in value ? value.generation : null);
    return (
      platform(left) === platform(right) &&
      left.volume === right.volume &&
      left.fileId === right.fileId &&
      subvolume(left) === subvolume(right) &&
      (generation(left) === null ||
        generation(right) === null ||
        generation(left) === generation(right))
    );
  },
  /** A Linux record written before the generation was read: it matches by inode alone. */
  lacksGeneration(stored: StoredFileIdentity): boolean {
    return stored.platform === "linux" && !("generation" in stored);
  },
};
