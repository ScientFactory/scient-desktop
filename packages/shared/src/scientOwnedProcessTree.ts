// @effect-diagnostics nodeBuiltinImport:off -- reads the operating system's process table and signals processes.
/**
 * An agent's descendants in process groups of their own escape a group kill and lose their link to
 * the agent when it exits, so its tree is sampled while it lives. Afterwards, recorded processes
 * that are still the same process, and what they started since, are stopped. macOS and Linux.
 */
import * as NodeChildProcess from "node:child_process";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

export interface OwnedProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** Start time (to the second) and command: with the PID, tells a process from a PID reuse. */
  readonly identity: string;
}

/** Parses `ps -A -o pid=,ppid=,pgid=,lstart=,comm=` output (C locale). */
export function parseProcessTable(text: string): ReadonlyArray<OwnedProcess> {
  const processes: Array<OwnedProcess> = [];
  for (const line of text.split("\n")) {
    // lstart is five fields in the C locale: "Wed Nov 11 17:42:16 2026".
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(\S.*?)\s*$/.exec(line);
    if (match === null) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      identity: `${match[4]!.replace(/\s+/g, " ")}\u0000${match[5]!}`,
    });
  }
  return processes;
}

/** `ps` failed or timed out. Never read as "nothing is running": that would forget what is owned. */
export class ProcessTableUnavailable extends Schema.TaggedError<ProcessTableUnavailable>()(
  "ProcessTableUnavailable",
  { cause: Schema.Defect() },
) {}

export const readProcessTable: Effect.Effect<
  ReadonlyArray<OwnedProcess>,
  ProcessTableUnavailable
> = Effect.callback((resume) => {
  NodeChildProcess.execFile(
    "ps",
    ["-A", "-o", "pid=,ppid=,pgid=,lstart=,comm="],
    {
      // A fixed locale and zone keep `lstart` identical between reads.
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    },
    (error, stdout) =>
      resume(
        error
          ? Effect.fail(new ProcessTableUnavailable({ cause: error }))
          : Effect.succeed(parseProcessTable(stdout)),
      ),
  );
});

/** Every process whose parent chain leads to `rootPid`, excluding the root itself. */
export function descendantsOf<Entry extends { readonly pid: number; readonly ppid: number }>(
  table: ReadonlyArray<Entry>,
  rootPid: number,
): ReadonlyArray<Entry> {
  const children = new Map<number, Array<Entry>>();
  for (const entry of table) {
    if (entry.pid === entry.ppid) continue;
    const siblings = children.get(entry.ppid);
    if (siblings === undefined) children.set(entry.ppid, [entry]);
    else siblings.push(entry);
  }
  const found: Array<Entry> = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

export interface OwnedProcessTreeOptions {
  readonly readTable?: Effect.Effect<ReadonlyArray<OwnedProcess>, ProcessTableUnavailable>;
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** The root must be this process's child; defaults to the current process. */
  readonly parentPid?: number;
  /** Wait between attempts when stopping finds the table unreadable; defaults to one second. */
  readonly readRetrySpacing?: Duration.Input;
  /** Wait before a sample's second read when the first fails; defaults to 250 ms. */
  readonly sampleRetrySpacing?: Duration.Input;
}

export interface ReapResult {
  /** Processes asked to stop: recorded ones still running, and what they started since. */
  readonly terminated: number;
  /** Of those, the ones that had to be killed after the grace period. */
  readonly killed: number;
  /** Processes not stopped, or not seen to stop, because the process table stayed unreadable. */
  readonly unverified: number;
}

export interface OwnedProcessTree {
  /**
   * Records the root's living descendants and forgets recorded ones that have exited. A failed read
   * is tried once more; a table still unreadable changes nothing.
   */
  readonly sample: Effect.Effect<void>;
  /** Stops recorded processes still running and their descendants: SIGTERM, then SIGKILL. */
  readonly reap: (grace: Duration.Input) => Effect.Effect<ReapResult>;
}

const defaultSignal = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone, or not ours to signal.
  }
};

export function makeOwnedProcessTree(
  rootPid: number,
  options: OwnedProcessTreeOptions = {},
): OwnedProcessTree {
  const readTable = options.readTable ?? readProcessTable;
  const signal = options.signal ?? defaultSignal;
  const parentPid = options.parentPid ?? process.pid;
  const recorded = new Map<number, OwnedProcess>();
  // The root as first seen: a later process that reuses its PID is not the same root.
  let rootIdentity: string | undefined;
  const isSame = (byPid: ReadonlyMap<number, OwnedProcess>, entry: OwnedProcess) =>
    byPid.get(entry.pid)?.identity === entry.identity;
  const indexByPid = (table: ReadonlyArray<OwnedProcess>) =>
    new Map(table.map((entry) => [entry.pid, entry] as const));
  // Never init, this process, or a member of this process's own group.
  const signallable = (entry: OwnedProcess) =>
    entry.pid > 1 && entry.pid !== process.pid && entry.pgid !== process.pid;

  // `ps` can fail once while processes come and go; a quick second read keeps one failure from
  // leaving a whole sampling interval unseen.
  const readForSample = readTable.pipe(
    Effect.retry({
      times: 1,
      schedule: Schedule.spaced(options.sampleRetrySpacing ?? "250 millis"),
    }),
    Effect.option,
  );

  const sample = Effect.gen(function* () {
    const read = yield* readForSample;
    if (Option.isNone(read)) return;
    const table = read.value;
    const byPid = indexByPid(table);
    for (const entry of recorded.values()) {
      if (!isSame(byPid, entry)) recorded.delete(entry.pid);
    }
    // Only a live child of ours is a root to follow; anything else (a PID that is not ours, or
    // one reused after the root exited) records nothing.
    const root = byPid.get(rootPid);
    if (rootPid <= 1 || root === undefined || root.ppid !== parentPid) return;
    rootIdentity ??= root.identity;
    if (root.identity !== rootIdentity) return;
    for (const entry of descendantsOf(table, rootPid)) {
      if (signallable(entry)) recorded.set(entry.pid, entry);
    }
  });

  // Signals single processes only, never a group: a group's other members were never checked.
  const signalAll = (targets: ReadonlyArray<OwnedProcess>, name: NodeJS.Signals) => {
    for (const entry of targets) signal(entry.pid, name);
  };

  // Stopping reads the table twice; each read gets two more attempts before it gives up.
  const readForReap = readTable.pipe(
    Effect.retry({ times: 2, schedule: Schedule.spaced(options.readRetrySpacing ?? "1 second") }),
    Effect.option,
  );

  const reap = Effect.fn("scient.ownedProcessTree.reap")(function* (grace: Duration.Input) {
    if (recorded.size === 0) return { terminated: 0, killed: 0, unverified: 0 };
    const read = yield* readForReap;
    // Only a process seen as itself during this reap is signalled; without a table, none is.
    if (Option.isNone(read)) {
      const unverified = recorded.size;
      recorded.clear();
      return { terminated: 0, killed: 0, unverified };
    }
    const table = read.value;
    const byPid = indexByPid(table);
    // Recorded processes that are still themselves, plus whatever they started since the last
    // sample, as seen now.
    const targets = new Map<number, OwnedProcess>();
    for (const entry of recorded.values()) {
      if (!isSame(byPid, entry)) continue;
      targets.set(entry.pid, byPid.get(entry.pid)!);
      for (const child of descendantsOf(table, entry.pid)) {
        if (signallable(child)) targets.set(child.pid, child);
      }
    }
    recorded.clear();
    if (targets.size === 0) return { terminated: 0, killed: 0, unverified: 0 };
    const terminated = [...targets.values()];
    signalAll(terminated, "SIGTERM");
    yield* Effect.sleep(grace);
    // Look again: a survivor may have started more processes during the grace. Children are
    // killed before their parents, so none is re-parented out of reach first. Without a table, a
    // target that exited may have handed its PID on, so none is killed.
    const afterRead = yield* readForReap;
    if (Option.isNone(afterRead)) {
      return { terminated: terminated.length, killed: 0, unverified: terminated.length };
    }
    const afterTable = afterRead.value;
    const after = indexByPid(afterTable);
    const stubborn = terminated.filter((entry) => isSame(after, entry));
    const known = new Set(stubborn.map((entry) => entry.pid));
    const late = stubborn.flatMap((entry) =>
      descendantsOf(afterTable, entry.pid).filter(
        (child) => signallable(child) && !known.has(child.pid) && known.add(child.pid),
      ),
    );
    signalAll([...late.reverse(), ...stubborn.reverse()], "SIGKILL");
    return { terminated: terminated.length, killed: stubborn.length + late.length, unverified: 0 };
  });

  return { sample, reap };
}
