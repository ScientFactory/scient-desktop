// @effect-diagnostics nodeBuiltinImport:off -- Volume identity and capability probes need the real filesystem.
/**
 * Where a manual Overleaf connection keeps displaced manuscript copies and the
 * applier's journals (owner decision 1, coordinator contract section 8).
 *
 * - The server's own state directory, when it is on the checkout's volume and
 *   outside the checkout.
 * - Otherwise a hidden `.scient-overleaf/<environment>/<connection>` folder
 *   beside the checkout, on the project's own disk.
 *
 * Locations are recorded by the volume's UUID plus the folder's file ID, never
 * the device number, so a disk mounted again under another path is still
 * recognized. Once a connection has a recorded location, nothing is created:
 * a missing or replaced folder is reported, never silently replaced.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { exchange, syncDirectory } from "../workspace/RetainedFileMutation.ts";

/** The hidden folder created beside a checkout on another disk. */
const OVERLEAF_VAULT_DIRECTORY = ".scient-overleaf";

export interface OverleafVolumeFileIdentity {
  readonly volume: string;
  readonly fileId: string;
}

export type OverleafRetentionRefusal =
  /** The checkout's disk is not mounted (unplugged, or its path is gone). */
  | "volume-unavailable"
  /** The disk reports no volume UUID (some network shares and formats). */
  | "no-volume-identity"
  /** The disk cannot exchange files atomically (exFAT, FAT), or link them in development fallback. */
  | "unsupported-filesystem"
  | "read-only-parent"
  /** The folder beside the checkout belongs to another user. */
  | "shared-parent"
  /** The checkout is the root of its disk, so a folder beside it would be on another disk. */
  | "disk-root-checkout"
  /** A symlink, wrong owner or permissions where the folder must be. */
  | "unsafe-directory"
  /** The recorded folder is gone. Recovery waits for it; a fresh one is never made. */
  | "vault-missing"
  /** A folder exists at the location but is not the recorded one. */
  | "vault-replaced";

export type OverleafVolumeIdentityResolver = (path: string) => Promise<string | null>;

const run = (file: string, args: ReadonlyArray<string>) =>
  new Promise<string | null>((resolve) =>
    NodeChildProcess.execFile(
      file,
      [...args],
      { timeout: 10_000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } },
      (error, stdout) => resolve(error ? null : stdout),
    ),
  );

/**
 * The volume UUID of the disk holding `path`, from `diskutil`, or null when
 * the disk reports none. macOS only; other platforms are not supported yet.
 */
export const macVolumeUuid: OverleafVolumeIdentityResolver = async (path) => {
  if (HostProcess.Platform.defaultValue() !== "darwin") return null;
  // `diskutil` needs a device or mount point, so ask `df` which device holds the path.
  const df = await run("/bin/df", ["-P", path]);
  const device = df?.split("\n")[1]?.split(/\s+/u)[0];
  if (device === undefined || !device.startsWith("/dev/")) return null;
  const info = await run("/usr/sbin/diskutil", ["info", "-plist", device]);
  const uuid = info?.match(
    /<key>VolumeUUID<\/key>\s*<string>([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})<\/string>/u,
  )?.[1];
  return uuid === undefined ? null : uuid.toUpperCase();
};

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const isReadOnly = (error: unknown) =>
  ["EACCES", "EPERM", "EROFS"].includes(errorCode(error) ?? "");

class Refused extends Error {
  readonly reason: OverleafRetentionRefusal;
  constructor(reason: OverleafRetentionRefusal) {
    super(reason);
    this.reason = reason;
  }
}

/** Creates (or, with `create: false`, only checks) one owner-only, non-symlink directory. */
async function ensurePrivate(directory: string, userId: number | undefined, create: boolean) {
  if (create)
    try {
      await NodeFSP.mkdir(directory, { mode: 0o700 });
      await syncDirectory(NodePath.dirname(directory));
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        if (isReadOnly(error)) throw new Refused("read-only-parent");
        throw error;
      }
    }
  let stat;
  try {
    stat = await NodeFSP.lstat(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new Refused("vault-missing");
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Refused("unsafe-directory");
  if (userId !== undefined && stat.uid !== userId) throw new Refused("unsafe-directory");
  if ((stat.mode & 0o077) !== 0) await NodeFSP.chmod(directory, 0o700);
}

/**
 * Proves the folder's disk supports the replacement Scient will use: atomic
 * exchange through the host helper, or hard links for the declared
 * development fallback when no helper is configured.
 */
async function probeCapability(directory: string, exchangeHelper: string | null) {
  const stem = NodePath.join(directory, `.probe-${NodeCrypto.randomUUID()}`);
  const [left, right, link] = [`${stem}-a`, `${stem}-b`, `${stem}-link`];
  try {
    try {
      await NodeFSP.writeFile(left, "a", { flag: "wx", mode: 0o600 });
      await NodeFSP.writeFile(right, "b", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (isReadOnly(error)) throw new Refused("read-only-parent");
      throw error;
    }
    if (exchangeHelper === null) {
      try {
        await NodeFSP.link(left, link);
      } catch {
        throw new Refused("unsupported-filesystem");
      }
      return;
    }
    // A missing helper is a configuration fault, not a property of the disk.
    await NodeFSP.access(exchangeHelper, NodeFSP.constants.X_OK);
    try {
      await exchange(exchangeHelper, left, right);
    } catch {
      throw new Refused("unsupported-filesystem");
    }
    if ((await NodeFSP.readFile(left, "utf8")) !== "b") throw new Refused("unsupported-filesystem");
  } finally {
    await Promise.all([left, right, link].map((file) => NodeFSP.rm(file, { force: true })));
  }
}

/**
 * Chooses, creates (first time) or verifies (recorded) the connection's
 * retention folder. Returns its real path and identity, or why it cannot be used.
 */
export async function locateOverleafRetention(input: {
  /** `stateDir/overleaf/retained`; its parent already exists and is private. */
  readonly stateRetained: string;
  readonly environmentId: string;
  readonly connectionId: string;
  readonly checkoutRoot: string;
  readonly userId: number | undefined;
  readonly exchangeHelper: string | null;
  /** The identity recorded for this connection, or null for a new one. */
  readonly expected: OverleafVolumeFileIdentity | null;
  readonly volumeUuid: OverleafVolumeIdentityResolver;
}): Promise<
  | {
      readonly _tag: "ready";
      readonly directory: string;
      readonly identity: OverleafVolumeFileIdentity;
    }
  | { readonly _tag: "refused"; readonly reason: OverleafRetentionRefusal }
> {
  try {
    let checkout: string;
    try {
      checkout = await NodeFSP.realpath(input.checkoutRoot);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? ""))
        throw new Refused("volume-unavailable");
      throw error;
    }
    const checkoutStat = await NodeFSP.stat(checkout, { bigint: true });
    const volume = await input.volumeUuid(checkout);
    if (volume === null) throw new Refused("no-volume-identity");

    const create = input.expected === null;
    const stateRoot = await NodeFSP.realpath(NodePath.dirname(input.stateRetained));
    const stateUsable =
      (await NodeFSP.stat(stateRoot, { bigint: true })).dev === checkoutStat.dev &&
      stateRoot !== checkout &&
      !stateRoot.startsWith(`${checkout}${NodePath.sep}`);
    let levels: ReadonlyArray<string>;
    if (stateUsable) {
      // The state directory already belongs to one server environment.
      levels = [input.stateRetained, NodePath.join(input.stateRetained, input.connectionId)];
    } else {
      const parent = NodePath.dirname(checkout);
      if (parent === checkout) throw new Refused("disk-root-checkout");
      const parentStat = await NodeFSP.stat(parent, { bigint: true });
      if (parentStat.dev !== checkoutStat.dev) throw new Refused("disk-root-checkout");
      if (create && input.userId !== undefined && Number(parentStat.uid) !== input.userId)
        throw new Refused("shared-parent");
      const base = NodePath.join(parent, OVERLEAF_VAULT_DIRECTORY);
      levels = [
        base,
        NodePath.join(base, input.environmentId),
        NodePath.join(base, input.environmentId, input.connectionId),
      ];
    }
    for (const level of levels) await ensurePrivate(level, input.userId, create);

    const directory = await NodeFSP.realpath(levels.at(-1)!);
    const directoryStat = await NodeFSP.stat(directory, { bigint: true });
    if (
      directoryStat.dev !== checkoutStat.dev ||
      directory === checkout ||
      directory.startsWith(`${checkout}${NodePath.sep}`)
    )
      throw new Refused("unsafe-directory");
    const identity = { volume, fileId: String(directoryStat.ino) };
    if (
      input.expected !== null &&
      (input.expected.volume !== identity.volume || input.expected.fileId !== identity.fileId)
    )
      throw new Refused("vault-replaced");
    await probeCapability(directory, input.exchangeHelper);
    return { _tag: "ready", directory, identity };
  } catch (error) {
    if (error instanceof Refused) return { _tag: "refused", reason: error.reason };
    throw error;
  }
}
