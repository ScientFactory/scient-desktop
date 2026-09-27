// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off -- This package is the reviewed Node process and filesystem boundary for app-private provider runtimes.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * This process instance. A lock carrying this process's pid but another id
 * was left by an earlier process that happened to get the same pid, so it is
 * stale. Immutable: it identifies the process, it does not track any lock.
 */
const PROCESS_INSTANCE_ID = NodeCrypto.randomUUID();

/**
 * Tokens of the locks this process holds right now. This process never judges
 * its own locks by age: after a system sleep the monotonic heartbeat timer
 * lags the wall-clock mtime, so a lock it still holds can look overdue.
 */
const heldTokens = new Set<string>();

/** An undecodable lock younger than this may still be being written. */
const UNREADABLE_LOCK_GRACE_MS = 10_000;
const MAX_ACQUIRE_ATTEMPTS = 4;

/** How often an owner refreshes its lock file's mtime while it holds the lock. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
interface ManagedRuntimeMutationLockRecord {
  // Unchanged so older builds still decode (and honor) heartbeat locks.
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly processId: string;
  readonly token: string;
  /** Absent in locks written by builds that predate the heartbeat. */
  readonly heartbeatIntervalMs?: number;
}

export interface ManagedRuntimeMutationLock {
  /**
   * Aborted, with a `ManagedRuntimeMutationLockLostError`, once the heartbeat
   * finds that another owner has taken the lock over. The operation holding
   * the lock must stop: it no longer excludes anyone.
   */
  readonly signal: AbortSignal;
  /**
   * Stops the heartbeat, then removes the lock file only while it still
   * carries this owner's token. Never rejects, so it is safe in `finally`: a
   * lock it cannot remove is logged, and is reclaimed as stale later.
   */
  readonly release: () => Promise<void>;
}

/** Another owner took over a lock whose heartbeat looked overdue. */
export class ManagedRuntimeMutationLockLostError extends Error {
  constructor() {
    super("Another owner took over the managed runtime mutation lock.");
    this.name = "ManagedRuntimeMutationLockLostError";
  }
}

export interface ManagedRuntimeMutationLockOptions {
  /** Overrides the heartbeat interval; the stale bound scales with it. */
  readonly heartbeatIntervalMs?: number;
}

const errorCode = (cause: unknown) => (cause as NodeJS.ErrnoException | undefined)?.code;

function decodeLock(raw: string): ManagedRuntimeMutationLockRecord | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (
      value?.schemaVersion !== 1 ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.processId !== "string" ||
      typeof value.token !== "string" ||
      value.token.length === 0
    ) {
      return undefined;
    }
    const { heartbeatIntervalMs, ...record } = value;
    // An unusable interval is treated like a legacy lock rather than as
    // unreadable, which would expire after only the short unreadable grace.
    return (typeof heartbeatIntervalMs === "number" &&
    Number.isSafeInteger(heartbeatIntervalMs) &&
    heartbeatIntervalMs > 0
      ? { ...record, heartbeatIntervalMs }
      : record) as unknown as ManagedRuntimeMutationLockRecord;
  } catch {
    return undefined;
  }
}

/** `kill(pid, 0)` semantics: EPERM means the process exists under another user. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return errorCode(cause) === "EPERM";
  }
}

interface ObservedLock {
  readonly raw: string;
  readonly mtimeMs: number;
  /** Tells apart two locks with the same contents, such as two unreadable ones. */
  readonly ino: number;
}

const isSameLock = (left: ObservedLock | undefined, right: ObservedLock) =>
  left?.raw === right.raw && left.ino === right.ino;

/**
 * Read a file's contents and its last heartbeat (mtime) from the same
 * handle, so a file replaced mid-read never pairs one owner with another's age.
 */
async function readLock(lockPath: string): Promise<ObservedLock | undefined> {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(lockPath, "r");
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined;
    throw cause;
  }
  try {
    const [raw, stat] = await Promise.all([handle.readFile("utf8"), handle.stat()]);
    return { raw, mtimeMs: stat.mtimeMs, ino: stat.ino };
  } finally {
    await handle.close();
  }
}

/**
 * Bump the lock's mtime if it still carries `token`. The ownership check and
 * the touch go through one handle, so they apply to the same file: a lock
 * another owner has since published at the path is never touched, and an
 * absent lock is never re-created. Resolves false only once ownership is
 * definitively lost.
 */
async function refreshLock(lockPath: string, token: string): Promise<boolean> {
  // Absent (a removal renamed the root away) or unopenable: retry next beat.
  const handle = await NodeFSP.open(lockPath, "r+").catch(() => undefined);
  if (handle === undefined) return true;
  try {
    if (decodeLock(await handle.readFile("utf8"))?.token !== token) return false;
    const now = new Date();
    await handle.utimes(now, now);
    return true;
  } catch {
    return true;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Refresh the owner's lock every `intervalMs` until stopped or until the lock
 * is found to belong to someone else, which calls `onLost`. Beats never
 * overlap, and `stop` resolves only after any in-flight beat has settled, so
 * no refresh touches the path after release begins.
 */
function startHeartbeat(lockPath: string, token: string, intervalMs: number, onLost: () => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const schedule = () => {
    timer = setTimeout(() => {
      inFlight = refreshLock(lockPath, token).then((owned) => {
        if (!owned && !stopped) {
          stopped = true;
          onLost();
        }
        if (!stopped) schedule();
      });
    }, intervalMs);
    // The heartbeat must never keep the process alive on its own.
    timer.unref();
  };
  schedule();
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
}

/**
 * Publish the complete record under `lockPath`, failing with EEXIST when it
 * is taken. A hard link is atomic and exclusive, so no reader can observe a
 * half-written lock. Filesystems without hard links fall back to an
 * exclusive create, whose brief empty window readers tolerate by age.
 */
async function publishLock(
  lockPath: string,
  record: ManagedRuntimeMutationLockRecord,
): Promise<ObservedLock> {
  const raw = `${JSON.stringify(record)}\n`;
  const temporary = `${lockPath}.${record.token}.tmp`;
  await NodeFSP.writeFile(temporary, raw, { mode: 0o600, flag: "wx" });
  try {
    await NodeFSP.link(temporary, lockPath);
    // A hard link shares the temporary file's inode.
    return { raw, mtimeMs: Date.now(), ino: (await NodeFSP.stat(temporary)).ino };
  } catch (cause) {
    const code = errorCode(cause);
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EXDEV") {
      throw cause;
    }
    await NodeFSP.writeFile(lockPath, raw, { mode: 0o600, flag: "wx" });
    return { raw, mtimeMs: Date.now(), ino: (await NodeFSP.stat(lockPath)).ino };
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

interface TakeoverClaimRecord {
  readonly pid: number;
  readonly processId: string;
}

/** A claim is reclaimable only after its contender exits. */
function isStaleTakeoverClaim({ raw }: ObservedLock): boolean {
  let claimant: TakeoverClaimRecord | undefined;
  try {
    claimant = JSON.parse(raw) as TakeoverClaimRecord;
  } catch {
    // Written with its contents in one call; empty only while being written.
    return false;
  }
  if (claimant.pid === process.pid) return claimant.processId !== PROCESS_INSTANCE_ID;
  return !isProcessAlive(claimant.pid);
}

/**
 * Run `remove` as the only contender acting on one observed lock file, or
 * return false while another contender holds that claim. Every removal of a
 * lock, whether a stale takeover or a release, goes through the claim for the
 * exact file it removes, and re-reads the path inside it. A lock is only
 * ever published onto an empty path, so while the path still holds the
 * observed file only the claim holder can change it: no contender can remove
 * a lock that replaced the one it observed.
 */
async function withTakeoverClaim(
  lockPath: string,
  target: ObservedLock,
  remove: () => Promise<void>,
  depth = 0,
): Promise<boolean> {
  if (depth >= 8) return false;
  const digest = NodeCrypto.createHash("sha256")
    .update(`${lockPath}\0${target.raw}\0${target.ino}`)
    .digest("hex");
  const claimPath = NodePath.join(NodePath.dirname(lockPath), `.mutation-claim-${digest}`);
  const claimant: ManagedRuntimeMutationLockRecord = {
    schemaVersion: 1,
    pid: process.pid,
    processId: PROCESS_INSTANCE_ID,
    token: NodeCrypto.randomUUID(),
  };
  try {
    await publishLock(claimPath, claimant);
  } catch (cause) {
    if (errorCode(cause) !== "EEXIST") throw cause;
    const claim = await readLock(claimPath);
    // A contender that died inside its claim; the next attempt claims afresh.
    if (claim && isStaleTakeoverClaim(claim)) {
      await withTakeoverClaim(
        claimPath,
        claim,
        async () => {
          const current = await readLock(claimPath);
          if (current && isSameLock(current, claim) && isStaleTakeoverClaim(current)) {
            await removeLockFile(claimPath);
          }
        },
        depth + 1,
      );
    }
    return false;
  }
  try {
    await remove();
    return true;
  } finally {
    await NodeFSP.rm(claimPath, { force: true });
  }
}

async function removeLockFile(lockPath: string) {
  await NodeFSP.unlink(lockPath).catch((cause: unknown) => {
    if (errorCode(cause) !== "ENOENT") throw cause;
  });
}

/** Remove the observed lock if it is still at the path and still stale. */
async function removeStaleLock(lockPath: string, observed: ObservedLock) {
  await withTakeoverClaim(lockPath, observed, async () => {
    const current = await readLock(lockPath);
    if (current && isSameLock(current, observed) && !isHeldByLiveOwner(current)) {
      await removeLockFile(lockPath);
    }
  });
}

/**
 * A lock of this process is held exactly while its token is still held. A
 * lock of another process is held while that process is live. An overdue
 * heartbeat cannot distinguish a suspended owner from a reused pid. Favor
 * exclusive ownership over automatic recovery when that identity is unknown.
 */
function isHeldByLiveOwner({ raw, mtimeMs }: ObservedLock): boolean {
  const age = Date.now() - mtimeMs;
  const owner = decodeLock(raw);
  if (!owner) return age < UNREADABLE_LOCK_GRACE_MS;
  if (owner.processId === PROCESS_INSTANCE_ID) return heldTokens.has(owner.token);
  // An earlier process that happened to get this process's pid.
  if (owner.pid === process.pid) return false;
  return isProcessAlive(owner.pid);
}

/**
 * Take exclusive ownership of a managed runtime root for one mutation
 * (install, reconciliation, removal), or return undefined while a live owner
 * holds it. The lock is a file, so every runtime object for the root, in
 * this process or another, observes the same owner. The owner refreshes the
 * lock's mtime every heartbeat interval while it holds it. A lock whose
 * process has exited is reclaimed. A live pid with unknown process identity
 * is conservatively honored, including when its heartbeat is overdue.
 */
export async function tryAcquireManagedRuntimeMutationLock(
  lockPath: string,
  options: ManagedRuntimeMutationLockOptions = {},
): Promise<ManagedRuntimeMutationLock | undefined> {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const token = NodeCrypto.randomUUID();
    let published: ObservedLock;
    try {
      // Registered first, so a contender never sees the new lock as stale.
      heldTokens.add(token);
      published = await publishLock(lockPath, {
        schemaVersion: 1,
        pid: process.pid,
        processId: PROCESS_INSTANCE_ID,
        token,
        heartbeatIntervalMs,
      });
    } catch (cause) {
      heldTokens.delete(token);
      if (errorCode(cause) !== "EEXIST") throw cause;
      const observed = await readLock(lockPath);
      if (observed === undefined) continue;
      if (isHeldByLiveOwner(observed)) return undefined;
      await removeStaleLock(lockPath, observed);
      continue;
    }
    const lost = new AbortController();
    const heartbeat = startHeartbeat(lockPath, token, heartbeatIntervalMs, () =>
      lost.abort(new ManagedRuntimeMutationLockLostError()),
    );
    return {
      signal: lost.signal,
      release: async () => {
        try {
          await heartbeat.stop();
          await releaseManagedRuntimeMutationLock(lockPath, published);
        } catch (cause) {
          console.warn(`Scient could not release the managed runtime lock ${lockPath}.`, cause);
        } finally {
          heldTokens.delete(token);
        }
      },
    };
  }
  // Still contended after taking over stale locks: another owner is active.
  return undefined;
}

/**
 * Remove the owner's own lock file while it is still at the path. A removal
 * renames the whole root away with the lock inside it; a claim already held
 * on it means a contender judged it stale and is removing it.
 */
async function releaseManagedRuntimeMutationLock(lockPath: string, published: ObservedLock) {
  if (!isSameLock(await readLock(lockPath), published)) return;
  await withTakeoverClaim(lockPath, published, async () => {
    if (isSameLock(await readLock(lockPath), published)) await removeLockFile(lockPath);
  });
}
