// @effect-diagnostics nodeBuiltinImport:off -- Effect FileSystem cannot create a file with O_EXCL or hard-link without replacing.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";

/**
 * Locks held by one adapter. The adapter owns this table for its lifetime, so
 * a record this adapter wrote but no longer tracks is provably a leftover,
 * while a record from another adapter in the same server process stays live.
 */
export interface OmpSessionLockRegistry {
  /** `pid:nonce` prefix of every token this adapter writes. */
  readonly owner: string;
  /** Lock path to the token of the live session that holds it. */
  readonly held: Map<string, string>;
}

export interface OmpSessionLockHandle {
  readonly path: string;
  readonly token: string;
}

/** Synchronous filesystem steps of the lock protocol. Tests interleave them. */
export interface OmpLockFs {
  /** Create `file` with `contents`, failing with EEXIST if it exists. */
  readonly writeExclusive: (file: string, contents: string) => void;
  readonly read: (file: string) => string;
  readonly rename: (from: string, to: string) => void;
  /** Hard-link `from` to `to`, failing with EEXIST instead of replacing `to`. */
  readonly link: (from: string, to: string) => void;
  readonly remove: (file: string) => void;
}

export const nodeOmpLockFs: OmpLockFs = {
  writeExclusive: (file, contents) => NodeFS.writeFileSync(file, contents, { flag: "wx" }),
  read: (file) => NodeFS.readFileSync(file, "utf8"),
  rename: (from, to) => NodeFS.renameSync(from, to),
  link: (from, to) => NodeFS.linkSync(from, to),
  remove: (file) => NodeFS.rmSync(file, { force: true }),
};

export const makeOmpSessionLockRegistry = (): OmpSessionLockRegistry => ({
  owner: `${process.pid}:${NodeCrypto.randomUUID()}`,
  held: new Map(),
});

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

/** Whether a process with this pid exists (possibly another user's). */
export const ompProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return errorCode(error) === "EPERM";
  }
};

const holderLive = (
  record: string,
  lockPath: string,
  registry: OmpSessionLockRegistry,
): boolean => {
  const [pidText, nonce] = record.split(":");
  const pid = Number(pidText);
  if (!ompProcessAlive(pid)) return false;
  if (pid !== process.pid) return true;
  // Another adapter in this process may own a live session on this path.
  if (`${pid}:${nonce}` !== registry.owner) return true;
  return registry.held.get(lockPath) === record;
};

/**
 * Move the stale record aside, then prove it is the record we judged stale.
 * If a contender replaced it in between, put its record back without
 * clobbering anything created since.
 */
const moveStaleAside = (lockPath: string, observed: string, fs: OmpLockFs): void => {
  const aside = `${lockPath}.${NodeCrypto.randomUUID()}.stale`;
  try {
    fs.rename(lockPath, aside);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  let moved: string | undefined;
  try {
    moved = fs.read(aside).trim();
  } catch {
    moved = undefined;
  }
  if (moved !== observed) {
    try {
      fs.link(aside, lockPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  fs.remove(aside);
};

/**
 * The synchronous acquisition step: a handle, or "busy" while a live holder
 * owns the conversation. Filesystem failures throw.
 */
export const tryAcquireOmpSessionLockSync = (
  lockPath: string,
  registry: OmpSessionLockRegistry,
  fs: OmpLockFs = nodeOmpLockFs,
): OmpSessionLockHandle | "busy" => {
  const token = `${registry.owner}:${NodeCrypto.randomUUID()}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.writeExclusive(lockPath, `${token}\n`);
      registry.held.set(lockPath, token);
      return { path: lockPath, token };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    let observed: string;
    try {
      observed = fs.read(lockPath).trim();
    } catch (error) {
      // The holder released the lock between our write attempt and the read.
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (holderLive(observed, lockPath, registry)) return "busy";
    moveStaleAside(lockPath, observed, fs);
  }
  return "busy";
};

/** One live writer for a conversation directory. A dead holder's lock is reclaimed. */
export const acquireOmpSessionLock = (
  lockPath: string,
  registry: OmpSessionLockRegistry,
  fs: OmpLockFs = nodeOmpLockFs,
): Effect.Effect<OmpSessionLockHandle, string> =>
  Effect.try({
    try: () => tryAcquireOmpSessionLockSync(lockPath, registry, fs),
    catch: () => "Oh My Pi could not lock this conversation.",
  }).pipe(
    Effect.filterOrFail(
      (result): result is OmpSessionLockHandle => result !== "busy",
      () => "This Oh My Pi conversation is already open.",
    ),
  );

/**
 * Delete the lock only while it still carries this handle's token. No other
 * holder can replace a live record, so the read-compare-delete is safe.
 */
export const releaseOmpSessionLock = (
  handle: OmpSessionLockHandle,
  registry: OmpSessionLockRegistry,
  fs: OmpLockFs = nodeOmpLockFs,
): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      if (fs.read(handle.path).trim() === handle.token) fs.remove(handle.path);
    } catch {
      // Already gone or unreadable: nothing of ours to delete.
    }
    if (registry.held.get(handle.path) === handle.token) registry.held.delete(handle.path);
  });
