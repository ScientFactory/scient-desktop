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

type Stat = Awaited<ReturnType<typeof statOrRefuse>>;

/** stat that turns disappearance and denial into refusals instead of I/O errors. */
async function statOrRefuse(path: string, missing: OverleafRetentionRefusal) {
  try {
    return await NodeFSP.stat(path, { bigint: true });
  } catch (error) {
    const code = errorCode(error) ?? "";
    if (["ENOENT", "ENOTDIR"].includes(code)) throw new Refused(missing);
    if (["EACCES", "EPERM"].includes(code)) throw new Refused("unsafe-directory");
    throw error;
  }
}

/**
 * Whether `path` is physically inside (or is) the checkout. Compares device and
 * inode of each ancestor, so macOS firmlink aliases (`/Users` and
 * `/System/Volumes/Data/Users`), whose real paths differ, are still caught.
 */
async function physicallyInside(path: string, checkout: Stat): Promise<boolean> {
  for (let current = path; ; current = NodePath.dirname(current)) {
    const stat = await NodeFSP.stat(current, { bigint: true });
    if (stat.dev === checkout.dev && stat.ino === checkout.ino) return true;
    if (NodePath.dirname(current) === current) return false;
  }
}

/** The folder beside the checkout, after checking it can be on the same disk and is ours. */
async function siblingLevels(
  checkout: string,
  checkoutStat: Stat,
  userId: number | undefined,
  environmentId: string,
  connectionId: string,
) {
  const parent = NodePath.dirname(checkout);
  if (parent === checkout) throw new Refused("disk-root-checkout");
  const parentStat = await statOrRefuse(parent, "volume-unavailable");
  if (parentStat.dev !== checkoutStat.dev) throw new Refused("disk-root-checkout");
  // Checked on every use, not only the first: whoever owns the parent can replace its entries.
  if (userId !== undefined && Number(parentStat.uid) !== userId) throw new Refused("shared-parent");
  const base = NodePath.join(parent, OVERLEAF_VAULT_DIRECTORY);
  return [
    base,
    NodePath.join(base, environmentId),
    NodePath.join(base, environmentId, connectionId),
  ];
}

/** Real path and identity of a verified candidate folder. */
async function verifiedFolder(
  levels: ReadonlyArray<string>,
  checkoutStat: Stat,
  userId: number | undefined,
  volume: string,
  create: boolean,
) {
  let directory: string;
  try {
    for (const level of levels) await ensurePrivate(level, userId, create);
    directory = await NodeFSP.realpath(levels.at(-1)!);
  } catch (error) {
    // Denial or disappearance of one candidate must not stop the search for another.
    const code = errorCode(error) ?? "";
    if (["ENOENT", "ENOTDIR"].includes(code)) throw new Refused("vault-missing");
    if (["EACCES", "EPERM"].includes(code)) throw new Refused("unsafe-directory");
    throw error;
  }
  const stat = await statOrRefuse(directory, "vault-missing");
  if (stat.dev !== checkoutStat.dev || (await physicallyInside(directory, checkoutStat)))
    throw new Refused("unsafe-directory");
  return { directory, identity: { volume, fileId: String(stat.ino) } };
}

/**
 * Chooses, creates (first time) or finds (recorded) the connection's retention
 * folder. Returns its real path and identity, or why it cannot be used.
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
      const code = errorCode(error) ?? "";
      if (["ENOENT", "ENOTDIR"].includes(code)) throw new Refused("volume-unavailable");
      if (["EACCES", "EPERM"].includes(code)) throw new Refused("unsafe-directory");
      throw error;
    }
    const checkoutStat = await statOrRefuse(checkout, "volume-unavailable");
    const volume = await input.volumeUuid(checkout);
    if (volume === null) throw new Refused("no-volume-identity");

    const stateLevels = [
      input.stateRetained,
      NodePath.join(input.stateRetained, input.connectionId),
    ];
    const stateRoot = await NodeFSP.realpath(NodePath.dirname(input.stateRetained));
    const stateUsable =
      (await statOrRefuse(stateRoot, "unsafe-directory")).dev === checkoutStat.dev &&
      !(await physicallyInside(stateRoot, checkoutStat));

    let found: { directory: string; identity: OverleafVolumeFileIdentity };
    if (input.expected === null) {
      const levels = stateUsable
        ? stateLevels
        : await siblingLevels(
            checkout,
            checkoutStat,
            input.userId,
            input.environmentId,
            input.connectionId,
          );
      found = await verifiedFolder(levels, checkoutStat, input.userId, volume, true);
    } else {
      // Find the recorded folder wherever it was placed; never create one.
      // Where it is placed can change (state moved, checkout remounted), its identity cannot.
      const expected = input.expected;
      const candidates: Array<() => Promise<ReadonlyArray<string>>> = [
        async () => stateLevels,
        () =>
          siblingLevels(
            checkout,
            checkoutStat,
            input.userId,
            input.environmentId,
            input.connectionId,
          ),
      ];
      let replaced = false;
      let refusal: Refused | null = null;
      let match: typeof found | null = null;
      for (const candidate of candidates) {
        try {
          const folder = await verifiedFolder(
            await candidate(),
            checkoutStat,
            input.userId,
            volume,
            false,
          );
          if (
            folder.identity.volume === expected.volume &&
            folder.identity.fileId === expected.fileId
          ) {
            match = folder;
            break;
          }
          replaced = true;
        } catch (error) {
          if (!(error instanceof Refused)) throw error;
          // A location that cannot exist for this checkout is simply not a candidate.
          if (error.reason !== "vault-missing" && error.reason !== "disk-root-checkout")
            refusal ??= error;
        }
      }
      if (match === null) {
        if (replaced) throw new Refused("vault-replaced");
        throw refusal ?? new Refused("vault-missing");
      }
      found = match;
    }
    await probeCapability(found.directory, input.exchangeHelper);
    // Another process may have swapped the folder while it was probed. This closes
    // the window up to here; the coordinator (step 3) must re-verify the identity
    // before each later use, because nothing below this module does.
    const after = await verifiedFolder(
      [found.directory],
      checkoutStat,
      input.userId,
      volume,
      false,
    );
    if (after.identity.fileId !== found.identity.fileId) throw new Refused("vault-replaced");
    return { _tag: "ready", ...found };
  } catch (error) {
    if (error instanceof Refused) return { _tag: "refused", reason: error.reason };
    throw error;
  }
}
