// @effect-diagnostics nodeBuiltinImport:off -- The library lock is an OS file lock held through node:sqlite.
// @effect-diagnostics globalTimers:off globalDate:off -- Waiting for another process uses plain timers.
import { AsyncLocalStorage } from "node:async_hooks";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

export const SCIENT_LIBRARY_LOCK_FILE = "library.lock";

const DEFAULT_TIMEOUT_MS = 30_000;
const FIRST_RETRY_MS = 10;
const LONGEST_RETRY_MS = 250;

/** Canonical lock paths the current async context holds, so a holder's own writes re-enter. */
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();
/** One holder per lock path in this process; other processes are kept out by the file lock. */
const processQueues = new Map<string, Promise<void>>();

// @effect-diagnostics-next-line extendsNativeError:off - The source stores are Promise-based; callers catch native errors.
export class ScientLibraryBusyError extends Error {
  constructor() {
    super("The library is busy in another Scient process. Try again in a moment.");
    this.name = "ScientLibraryBusyError";
  }
}

export interface ScientLibraryLockOptions {
  /** How long to wait for another holder. 0 tries once, for passes that can come back later. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

const isSqliteBusy = (cause: unknown) =>
  cause instanceof Error &&
  (("errcode" in cause && cause.errcode === 5) ||
    ("code" in cause && cause.code === "SQLITE_BUSY"));

function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function sameFile(left: NodeFS.BigIntStats | undefined, right: NodeFS.BigIntStats | undefined) {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

/**
 * One attempt at the file lock: an exclusive transaction on an empty SQLite file. The OS drops it
 * when the process exits, even on SIGKILL, so a dead holder never leaves a stale lock behind.
 */
function tryLockFile(lockPath: string): NodeSqlite.DatabaseSync | null {
  const before = NodeFS.statSync(lockPath, { bigint: true, throwIfNoEntry: false });
  const db = new NodeSqlite.DatabaseSync(lockPath);
  try {
    // An in-memory journal keeps the library folder free of a `-journal` file while held.
    db.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE;");
  } catch (cause) {
    db.close();
    if (isSqliteBusy(cause)) return null;
    throw cause;
  }
  // A lock file replaced between the stat and the lock would hold nothing anyone else checks.
  const after = NodeFS.statSync(lockPath, { bigint: true, throwIfNoEntry: false });
  if (before !== undefined && !sameFile(before, after)) {
    db.close();
    return null;
  }
  return db;
}

async function lockFile(
  lockPath: string,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<NodeSqlite.DatabaseSync> {
  let wait = FIRST_RETRY_MS;
  while (true) {
    signal?.throwIfAborted();
    const db = tryLockFile(lockPath);
    if (db) return db;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ScientLibraryBusyError();
    await delay(Math.min(wait, remaining), signal);
    wait = Math.min(wait * 2, LONGEST_RETRY_MS);
  }
}

/** Waits for this process's earlier holder; a waiter that gives up still passes the turn on. */
async function takeProcessTurn(
  lockPath: string,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<() => void> {
  const previous = processQueues.get(lockPath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  processQueues.set(lockPath, tail);
  const done = () => {
    release();
    if (processQueues.get(lockPath) === tail) processQueues.delete(lockPath);
  };
  const remaining = deadline - Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ScientLibraryBusyError()), Math.max(remaining, 0));
        onAbort = () => reject(signal?.reason);
        if (signal?.aborted) onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    return done;
  } catch (cause) {
    void previous.then(done);
    throw cause;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Runs `run` while holding the library's write lock, across processes. Every library writer takes
 * it: the server's stores, the move of project data, background passes and the sync worker.
 * Nested calls from inside `run` re-enter without waiting.
 *
 * Nothing else may open `library.lock`: closing any other descriptor of that file in the holding
 * process releases the OS lock (POSIX record-lock semantics). Never delete it while Scient runs.
 */
export async function withScientLibraryLock<A>(
  libraryRoot: string,
  run: () => Promise<A>,
  options: ScientLibraryLockOptions = {},
): Promise<A> {
  const root = await NodeFSP.realpath(libraryRoot);
  const lockPath = NodePath.join(root, SCIENT_LIBRARY_LOCK_FILE);
  const held = heldLocks.getStore();
  if (held?.has(lockPath)) return run();

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const finishTurn = await takeProcessTurn(lockPath, deadline, options.signal);
  let db: NodeSqlite.DatabaseSync | null = null;
  try {
    db = await lockFile(lockPath, deadline, options.signal);
    return await heldLocks.run(new Set([...(held ?? []), lockPath]), run);
  } finally {
    db?.close();
    finishTurn();
  }
}
