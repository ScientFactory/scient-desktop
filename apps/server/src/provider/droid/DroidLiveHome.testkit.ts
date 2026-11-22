// @effect-diagnostics nodeBuiltinImport:off -- reads the process table and waits on processes it didn't start.
/**
 * Droid's `exit-courier` (cloud sync, reaping its children) runs detached in its own process group
 * and writes under HOME after its session exits. A live test removes its HOME only once no Droid
 * process with that HOME runs. macOS hides system binaries' environments, so only Droid's count.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { Effect } from "effect";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/**
 * Longer than any exit work against the local Factory stub; reached, the case fails. A case's own
 * timeout leaves this much room after its body: the wait runs when the case's scope closes.
 */
const IDLE_DEADLINE_MS = 20_000;
/** At the deadline: how long the last scan, and the processes it kills, get. */
const KILL_GRACE_MS = 5_000;

const OBSERVER = NodePath.join(import.meta.dirname, "DroidLiveHome.await-exit.py");

/** What a read of one process found: `starting` when its environment couldn't be read yet. */
export type ProcessState = "gone" | "zombie" | "starting" | "ours" | "other";

export interface ListedProcess {
  readonly pid: number;
  /** The kernel's short name for the process, kept while it is defunct. */
  readonly name: string;
}

export interface ProcessTable {
  readonly list: (signal: AbortSignal) => Promise<ReadonlyArray<ListedProcess>>;
  /** Whether the process's environment sets HOME to `home`, read after the listing. */
  readonly state: (pid: number, home: string, signal: AbortSignal) => Promise<ProcessState>;
}

export interface Scan {
  readonly users: ReadonlyArray<number>;
  /** A Droid process whose environment couldn't be read yet: it may be one of ours starting. */
  readonly uncertain: boolean;
}

const ps = (args: ReadonlyArray<string>, signal: AbortSignal) =>
  execFile("ps", args, {
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
    signal,
  });

/** macOS: `ucomm` is the kernel's name; `ps eww` appends a same-user process's environment. */
const darwinTable: ProcessTable = {
  list: async (signal) =>
    (await ps(["-A", "-o", "pid=,ucomm="], signal)).stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      return match === null ? [] : [{ pid: Number(match[1]), name: match[2]! }];
    }),
  // One process per read: an environment value with a newline would split a combined listing.
  state: async (pid, home, signal) => {
    const read = await ps(["eww", "-o", "stat=,command=", "-p", String(pid)], signal).then(
      ({ stdout }) => stdout.trim(),
      (cause: unknown) => {
        // An interrupted read proves nothing; `ps` failing otherwise means no such process.
        if (signal.aborted) throw cause;
        return "";
      },
    );
    const match = /^(\S+)\s+([\s\S]*)$/.exec(read);
    if (match === null) return "gone";
    if (match[1]!.includes("Z")) return "zombie";
    // `ps` shows "(name)" while a process's arguments can't be read: starting, or ending.
    if (/^\(.*\)$/.test(match[2]!.trim())) return "starting";
    // Entries are space-separated, and HOME has no whitespace (see `checkHome`): a whole entry.
    return ` ${match[2]!} `.includes(` HOME=${home} `) ? "ours" : "other";
  },
};

const errorCode = (cause: unknown) => (cause as NodeJS.ErrnoException).code;

/** Linux: the name and state in /proc/<pid>/stat (the name parenthesised, maybe with spaces). */
const readStat = async (pid: number) => {
  const stat = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
  return {
    name: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")),
    zombie: stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z"),
  };
};

/** Linux: environments NUL-separated in /proc. Another user's process, unreadable, isn't ours. */
const linuxTable: ProcessTable = {
  list: async (signal) => {
    signal.throwIfAborted();
    return (
      await Promise.all(
        (await NodeFSP.readdir("/proc"))
          .filter((entry) => /^\d+$/.test(entry))
          .map((entry) =>
            // Gone, or hidden from this user: the confirming scan covers what a gone one started.
            readStat(Number(entry)).then(
              ({ name }) => [{ pid: Number(entry), name }],
              () => [],
            ),
          ),
      )
    ).flat();
  },
  state: async (pid, home, signal) => {
    signal.throwIfAborted();
    try {
      if ((await readStat(pid)).zombie) return "zombie";
      const environment = await NodeFSP.readFile(`/proc/${pid}/environ`, "utf8");
      if (environment === "") return "starting";
      return environment.split("\0").includes(`HOME=${home}`) ? "ours" : "other";
    } catch (cause) {
      return errorCode(cause) === "EACCES" ? "other" : "gone";
    }
  },
};

export const processTable = (platform: NodeJS.Platform): ProcessTable =>
  platform === "darwin" ? darwinTable : linuxTable;

/** The kernel keeps 16 characters of a name on macOS, 15 on Linux. */
const namesExecutable = (name: string, executable: string) =>
  name.length >= 15 ? executable.startsWith(name) : name === executable;

/** The processes of `executable` whose environment sets HOME to `home`, read after one listing. */
export async function scanHome(
  table: ProcessTable,
  home: string,
  executable: string,
  signal: AbortSignal,
): Promise<Scan> {
  signal.throwIfAborted();
  const users: Array<number> = [];
  let uncertain = false;
  for (const { pid, name } of await table.list(signal)) {
    if (pid === process.pid || !namesExecutable(name, executable)) continue;
    const state = await table.state(pid, home, signal);
    if (state === "ours") users.push(pid);
    else if (state === "starting") uncertain = true;
  }
  return { users, uncertain };
}

/**
 * HOME is matched as one entry of `ps eww`'s space-separated environment, which shows only
 * printable ASCII as itself: a HOME with whitespace or anything else could match another's.
 */
export const checkHome = (home: string) => {
  if (!/^[\x21-\x7e]+$/.test(home))
    throw new Error(`A Droid live test's HOME must be printable ASCII without spaces: ${home}`);
};

/** Returns once the kernel reports that every given process has exited (kqueue, pidfd). */
const exitsOf = (pids: ReadonlyArray<number>, signal: AbortSignal) =>
  execFile("python3", ["-I", "-S", OBSERVER, ...pids.map(String)], { signal }).then(
    () => undefined,
  );

const killProcess = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
};

export interface IdleOptions {
  readonly table: ProcessTable;
  readonly executable?: string;
  readonly waitForExits?: (pids: ReadonlyArray<number>, signal: AbortSignal) => Promise<void>;
  readonly kill?: (pid: number) => void;
  /** The bound on everything after the deadline: confirming, killing, confirming again. */
  readonly grace?: () => AbortSignal;
}

const isClean = (scan: Scan) => scan.users.length === 0 && !scan.uncertain;

/**
 * Returns once no Droid process uses `home`, waiting for each one found to exit. Idle takes two
 * clean scans in a row: a helper started while one scan lists, by a process exiting meanwhile,
 * still runs at the next. A scan the deadline interrupts never counts. After the deadline, what
 * still runs is killed and the HOME confirmed idle the same way, then it throws.
 */
export async function waitUntilHomeIdle(
  home: string,
  deadline: AbortSignal,
  options: IdleOptions,
): Promise<void> {
  checkHome(home);
  const { table } = options;
  const executable = options.executable ?? "droid";
  const waitForExits = options.waitForExits ?? exitsOf;
  const kill = options.kill ?? killProcess;
  const grace = options.grace ?? (() => AbortSignal.timeout(KILL_GRACE_MS));
  let cleanScans = 0;
  try {
    while (cleanScans < 2) {
      const scan = await scanHome(table, home, executable, deadline);
      cleanScans = isClean(scan) ? cleanScans + 1 : 0;
      if (scan.users.length > 0) await waitForExits(scan.users, deadline);
    }
    return;
  } catch (cause) {
    if (!deadline.aborted) throw cause;
  }
  const after = grace();
  const killed = new Set<number>();
  cleanScans = 0;
  try {
    while (cleanScans < 2) {
      const scan = await scanHome(table, home, executable, after);
      cleanScans = isClean(scan) ? cleanScans + 1 : 0;
      for (const pid of scan.users) {
        // Read again just before the kill: the PID is still this HOME's Droid process.
        if ((await table.state(pid, home, after)) !== "ours") continue;
        kill(pid);
        killed.add(pid);
      }
      if (scan.users.length > 0) await waitForExits(scan.users, after);
    }
  } catch {
    throw new Error(
      `Droid processes still used the test's HOME after ${IDLE_DEADLINE_MS / 1000} s, and it couldn't be confirmed idle${
        killed.size > 0 ? ` after killing ${[...killed].join(", ")}` : ""
      }`,
    );
  }
  if (killed.size > 0)
    throw new Error(
      `Droid processes still used the test's HOME after ${IDLE_DEADLINE_MS / 1000} s and were killed: ${[...killed].join(", ")}`,
    );
}

/**
 * Registers, at this point of the case's scope, a wait for `home` to be idle when the scope
 * closes. Call it after the Factory stub listens and before Droid starts: finalizers run in
 * reverse, so Droid's own shutdown comes first, its helpers can still reach the stub, and the
 * temporary directory is removed only afterwards. Windows qualification doesn't run Droid live.
 */
export const awaitDroidHomeIdleOnClose = Effect.fn("DroidLiveHome.awaitIdleOnClose")(function* (
  home: string,
) {
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") return;
  checkHome(home);
  const table = processTable(platform);
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => waitUntilHomeIdle(home, AbortSignal.timeout(IDLE_DEADLINE_MS), { table })),
  );
});
