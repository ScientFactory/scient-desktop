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

const OBSERVER = NodePath.join(import.meta.dirname, "DroidLiveHome.await-exit.py");

/** What a read of one process found: `starting` when its arguments couldn't be read yet. */
export type ProcessState = "gone" | "zombie" | "starting" | "ours" | "other";

export interface ListedProcess {
  readonly pid: number;
  readonly zombie: boolean;
  /** The executable as listed; undefined when the process was gone before it could be named. */
  readonly name: string | undefined;
}

export interface ProcessTable {
  readonly list: () => Promise<ReadonlyArray<ListedProcess>>;
  /** Whether the process's environment sets HOME to `home`, read after the listing. */
  readonly state: (pid: number, home: string) => Promise<ProcessState>;
}

export interface Scan {
  readonly users: ReadonlyArray<number>;
  /**
   * A listed process ended, or couldn't be read, during the scan. It may have started a helper
   * after the listing, so the scan proves nothing and is taken again.
   */
  readonly changed: boolean;
  /** Defunct processes seen, so a later scan can tell one that died meanwhile from an old one. */
  readonly zombies: ReadonlySet<number>;
}

const ps = (args: ReadonlyArray<string>) =>
  execFile("ps", args, { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });

/** macOS: `ps eww` appends a same-user process's environment to its command line. */
const darwinTable: ProcessTable = {
  list: async () =>
    (await ps(["-A", "-o", "pid=,stat=,comm="])).stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      return match === null
        ? []
        : [{ pid: Number(match[1]), zombie: match[2]!.includes("Z"), name: match[3]! }];
    }),
  // One process per read: an environment value with a newline would split a combined listing.
  state: async (pid, home) => {
    const read = await ps(["eww", "-o", "stat=,command=", "-p", String(pid)]).then(
      ({ stdout }) => stdout.trim(),
      () => "",
    );
    const match = /^(\S+)\s+([\s\S]*)$/.exec(read);
    if (match === null) return "gone";
    if (match[1]!.includes("Z")) return "zombie";
    // `ps` shows "(name)" while a process's arguments can't be read: starting, or ending.
    if (/^\(.*\)$/.test(match[2]!.trim())) return "starting";
    // A whole entry: a HOME with a space in it, or another spelling of it, is not this one.
    return ` ${match[2]!} `.includes(` HOME=${home} `) ? "ours" : "other";
  },
};

const errorCode = (cause: unknown) => (cause as NodeJS.ErrnoException).code;

/** The state letter and name in /proc/<pid>/stat; the name is parenthesised and may hold spaces. */
const parseStat = (stat: string) => ({
  name: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")),
  zombie: stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z"),
});

/** Linux: names and states from /proc/<pid>/stat, environments NUL-separated in /proc. */
const linuxTable: ProcessTable = {
  list: async () =>
    Promise.all(
      (await NodeFSP.readdir("/proc"))
        .filter((entry) => /^\d+$/.test(entry))
        .map(async (entry) => {
          const pid = Number(entry);
          try {
            return { pid, ...parseStat(await NodeFSP.readFile(`/proc/${entry}/stat`, "utf8")) };
          } catch {
            return { pid, zombie: false, name: undefined };
          }
        }),
    ),
  state: async (pid, home) => {
    try {
      if (parseStat(await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8")).zombie) return "zombie";
      const environment = await NodeFSP.readFile(`/proc/${pid}/environ`, "utf8");
      if (environment === "") return "starting";
      return environment.split("\0").includes(`HOME=${home}`) ? "ours" : "other";
    } catch (cause) {
      // Another user's process isn't ours.
      return errorCode(cause) === "EACCES" ? "other" : "gone";
    }
  },
};

export const processTable = (platform: NodeJS.Platform): ProcessTable =>
  platform === "darwin" ? darwinTable : linuxTable;

/**
 * The processes of `executable` whose environment sets HOME to `home`. A listed process that died,
 * vanished or couldn't be read before it was looked at makes the scan `changed`; a defunct one
 * already seen as defunct by the previous scan does not, since its children were listed then.
 */
export async function scanHome(
  table: ProcessTable,
  home: string,
  executable: string,
  previousZombies: ReadonlySet<number>,
): Promise<Scan> {
  // Linux keeps 15 characters of a name; macOS lists the executable's path.
  const isExecutable = (name: string) =>
    NodePath.basename(name) === executable ||
    name === executable.slice(0, 15) ||
    name === `(${executable})`;
  const users: Array<number> = [];
  const zombies = new Set<number>();
  let changed = false;
  for (const { pid, zombie, name } of await table.list()) {
    if (pid === process.pid) continue;
    if (name === undefined) {
      changed = true;
      continue;
    }
    if (!isExecutable(name)) continue;
    if (zombie) {
      zombies.add(pid);
      if (!previousZombies.has(pid)) changed = true;
      continue;
    }
    if (name === `(${executable})`) {
      changed = true;
      continue;
    }
    const state = await table.state(pid, home);
    if (state === "ours") users.push(pid);
    else if (state !== "other") {
      changed = true;
      if (state === "zombie") zombies.add(pid);
    }
  }
  return { users, changed, zombies };
}

/** Returns once the kernel reports that every given process has exited (kqueue, pidfd). */
const exitsOf = (pids: ReadonlyArray<number>, deadline: AbortSignal) =>
  execFile("python3", ["-I", "-S", OBSERVER, ...pids.map(String)], { signal: deadline }).then(
    () => undefined,
  );

/**
 * Returns once no process of `executable` uses `home`: each round waits for every process found
 * to exit, then scans again for ones they started meanwhile; a scan that changed under it is
 * simply taken again. At the deadline it throws, naming what still runs.
 */
export async function waitUntilHomeIdle(
  home: string,
  deadline: AbortSignal,
  options: {
    readonly table: ProcessTable;
    readonly executable?: string;
    readonly waitForExits?: (pids: ReadonlyArray<number>, deadline: AbortSignal) => Promise<void>;
  },
): Promise<void> {
  const executable = options.executable ?? "droid";
  const waitForExits = options.waitForExits ?? exitsOf;
  let zombies: ReadonlySet<number> = new Set();
  for (;;) {
    const scan = await scanHome(options.table, home, executable, zombies);
    zombies = scan.zombies;
    if (scan.users.length === 0 && !scan.changed) return;
    if (deadline.aborted)
      throw new Error(
        `Droid processes still use the test's HOME after ${IDLE_DEADLINE_MS / 1000} s: ${
          scan.users.join(", ") || "the process list kept changing"
        }`,
      );
    if (scan.users.length === 0) continue;
    await waitForExits(scan.users, deadline).catch((cause: unknown) => {
      // A deadline ends the wait; the next round reports what is still running.
      if (!deadline.aborted) throw cause;
    });
  }
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
  const table = processTable(platform);
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => waitUntilHomeIdle(home, AbortSignal.timeout(IDLE_DEADLINE_MS), { table })),
  );
});
