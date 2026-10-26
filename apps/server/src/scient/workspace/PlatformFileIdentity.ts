// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

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
const run = (file: string, args: string[]) =>
  new Promise<string | null>((resolve) =>
    NodeChildProcess.execFile(
      file,
      args,
      { timeout: 10_000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } },
      (error, stdout) => resolve(error ? null : stdout),
    ),
  );
const volumeIdentity: VolumeIdentityResolver = async (path) => {
  if (HostProcess.Platform.defaultValue() === "win32") {
    const identity = await windowsFileIdentity(path);
    return identity ? `\\\\?\\Volume{${identity.dev}}\\` : null;
  }
  if (HostProcess.Platform.defaultValue() !== "darwin") return null;
  const df = await run("/bin/df", ["-P", path]);
  const device = df?.split("\n")[1]?.split(/\s+/u)[0];
  if (device === undefined || !device.startsWith("/dev/")) return null;
  const info = await run("/usr/sbin/diskutil", ["info", "-plist", device]);
  const uuid = info?.match(
    /<key>VolumeUUID<\/key>\s*<string>([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})<\/string>/u,
  )?.[1];
  return uuid === undefined ? null : uuid.toUpperCase();
};

async function persistentIdentity(
  path: string,
  directoryOnly: boolean,
  volume: VolumeIdentityResolver,
): Promise<PersistentFileIdentity | null> {
  if (HostProcess.Platform.defaultValue() === "win32") {
    const identity = await windowsFileIdentity(path);
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
  persistent(path: string, volume = volumeIdentity) {
    return persistentIdentity(path, false, volume);
  },
  directory(path: string, volume = volumeIdentity) {
    return persistentIdentity(path, true, volume);
  },
  equal(left: StoredFileIdentity, right: StoredFileIdentity): boolean {
    const platform = (value: typeof left) => value.platform ?? "darwin";
    const subvolume = (value: typeof left) => ("subvolumeId" in value ? value.subvolumeId : null);
    return (
      platform(left) === platform(right) &&
      left.volume === right.volume &&
      left.fileId === right.fileId &&
      subvolume(left) === subvolume(right)
    );
  },
};
