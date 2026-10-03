// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Synchronous lock reclamation uses filesystem wall-clock mtime and atomic Node operations.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import type { OmpTarget } from "./OmpTarget.ts";

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
  readonly publishing: Set<string>;
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
  readonly identity: (file: string) => { readonly ino: number; readonly mtimeMs: number };
  readonly rename: (from: string, to: string) => void;
  /** Hard-link `from` to `to`, failing with EEXIST instead of replacing `to`. */
  readonly link: (from: string, to: string) => void;
  readonly remove: (file: string) => void;
}

export const nodeOmpLockFs: OmpLockFs = {
  writeExclusive: (file, contents) => NodeFS.writeFileSync(file, contents, { flag: "wx" }),
  read: (file) => NodeFS.readFileSync(file, "utf8"),
  identity: (file) => {
    const { ino, mtimeMs } = NodeFS.statSync(file);
    return { ino, mtimeMs };
  },
  rename: (from, to) => NodeFS.renameSync(from, to),
  link: (from, to) => NodeFS.linkSync(from, to),
  remove: (file) => NodeFS.rmSync(file, { force: true }),
};

export const makeOmpSessionLockRegistry = (): OmpSessionLockRegistry => ({
  owner: `${process.pid}:${NodeCrypto.randomUUID()}`,
  held: new Map(),
  publishing: new Set(),
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
  return registry.held.get(lockPath) === record || registry.publishing.has(record);
};

/** Publish a complete record atomically; readers never see an empty lock. */
const publishRecord = (
  file: string,
  token: string,
  registry: OmpSessionLockRegistry,
  fs: OmpLockFs,
) => {
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  registry.publishing.add(token);
  try {
    fs.writeExclusive(temporary, `${token}\n`);
    fs.link(temporary, file);
    registry.held.set(file, token);
  } finally {
    registry.publishing.delete(token);
    fs.remove(temporary);
  }
};

/**
 * Serialize reclamation of this exact record. A live claim is never expired
 * by age. If its owner crashed, reclaim its claim under another record-specific
 * claim before retrying. The recursion bound fails closed after repeated crashes.
 */
const removeStaleRecord = (
  lockPath: string,
  observed: string,
  registry: OmpSessionLockRegistry,
  fs: OmpLockFs,
  depth = 0,
  observedIdentity?: { readonly ino: number; readonly mtimeMs: number },
): void => {
  if (depth >= 8) return;
  const digest = NodeCrypto.createHash("sha256")
    .update(`${lockPath}\0${observed}${observedIdentity ? `\0${observedIdentity.ino}` : ""}`)
    .digest("hex");
  const claimPath = NodePath.join(NodePath.dirname(lockPath), `.omp-reclaim-${digest}`);
  const token = `${registry.owner}:${NodeCrypto.randomUUID()}`;
  try {
    publishRecord(claimPath, token, registry, fs);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    try {
      const claim = fs.read(claimPath).trim();
      if (!holderLive(claim, claimPath, registry)) {
        removeStaleRecord(claimPath, claim, registry, fs, depth + 1);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return;
  }
  try {
    // All reclaimers of `observed` hold this claim, so none can remove a
    // replacement published after it. A live replacement is never moved aside.
    const current = fs.read(lockPath).trim();
    const identity = observedIdentity ? fs.identity(lockPath) : undefined;
    const sameIdentity =
      !observedIdentity ||
      (identity?.ino === observedIdentity.ino &&
        identity.mtimeMs === observedIdentity.mtimeMs &&
        Date.now() - identity.mtimeMs >= 10_000);
    if (current === observed && sameIdentity && !holderLive(current, lockPath, registry))
      fs.remove(lockPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  } finally {
    fs.remove(claimPath);
    registry.held.delete(claimPath);
  }
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
      publishRecord(lockPath, token, registry, fs);
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
    // Unknown legacy records may still be being written by an older server.
    if (!/^\d+:[^:]+:[^:]+$/u.test(observed)) {
      // Older writers could briefly expose an empty lock. Give them time,
      // then reclaim only this exact abandoned inode under a claim.
      const identity = fs.identity(lockPath);
      if (Date.now() - identity.mtimeMs < 10_000) return "busy";
      removeStaleRecord(lockPath, observed, registry, fs, 0, identity);
    } else {
      removeStaleRecord(lockPath, observed, registry, fs);
    }
  }
  return "busy";
};

/** One live writer for a conversation directory. A dead holder's lock is reclaimed. */
export const acquireOmpSessionLock = (
  target: OmpTarget,
  lockPath: string,
  registry: OmpSessionLockRegistry,
  fs: OmpLockFs = nodeOmpLockFs,
): Effect.Effect<OmpSessionLockHandle, string> =>
  Effect.try({
    try: () => tryAcquireOmpSessionLockSync(lockPath, registry, fs),
    catch: () => `${target.name} could not lock this conversation.`,
  }).pipe(
    Effect.filterOrFail(
      (result): result is OmpSessionLockHandle => result !== "busy",
      () => `This ${target.name} conversation is already open.`,
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
