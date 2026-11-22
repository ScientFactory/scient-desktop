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

/** Longer than any exit work against the local Factory stub; reached, the case fails. */
const IDLE_DEADLINE_MS = 20_000;

const OBSERVER = NodePath.join(import.meta.dirname, "DroidLiveHome.await-exit.py");

interface HomeUser {
  readonly pid: number;
  /** The executable, for the failure message; environments stay out of logs. */
  readonly executable: string;
}

/** True when a process's `ps eww` line, or its NUL-separated environment, sets HOME to `home`. */
const setsHome = (text: string, home: string) => text.split(/[\s\0]/).includes(`HOME=${home}`);

interface Scan {
  readonly users: ReadonlyArray<HomeUser>;
  /**
   * A listed process ended before its environment was read. It may have started a helper after
   * the listing, so the scan says nothing about the processes it left behind.
   */
  readonly changed: boolean;
}

/**
 * macOS: the executable's living processes, then each one's environment, which `ps eww` appends
 * to its command line. One process per read: a value with a newline would split a combined list.
 */
async function darwinScan(home: string, executable: string): Promise<Scan> {
  const options = { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } };
  const { stdout } = await execFile("ps", ["-A", "-o", "pid=,stat=,comm="], options);
  const users: Array<HomeUser> = [];
  let changed = false;
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    // A process already defunct when listed started nothing since.
    if (match === null || match[2]!.includes("Z")) continue;
    // `ps` shows "(name)" while a starting process's arguments can't be read yet.
    if (match[3] === `(${executable})`) {
      changed = true;
      continue;
    }
    if (NodePath.basename(match[3]!) !== executable) continue;
    const read = await execFile("ps", ["eww", "-o", "stat=,command=", "-p", match[1]!], options)
      .then(({ stdout }) => stdout.trim())
      .catch(() => "");
    if (read === "" || read.split(/\s/)[0]!.includes("Z")) changed = true;
    else if (setsHome(read, home)) users.push({ pid: Number(match[1]), executable: match[3]! });
  }
  return { users, changed };
}

/** Linux: the executable's living processes by /proc's name, then their environments. */
async function linuxScan(home: string, executable: string): Promise<Scan> {
  const users: Array<HomeUser> = [];
  let changed = false;
  for (const entry of await NodeFSP.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let name: string;
    try {
      // The state follows the parenthesised name; a defunct process started nothing since.
      const stat = await NodeFSP.readFile(`/proc/${entry}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) continue;
      name = (await NodeFSP.readFile(`/proc/${entry}/comm`, "utf8")).trim();
    } catch {
      // Gone before it could be named: not one listed with a name, so nothing to follow.
      continue;
    }
    // The kernel keeps 15 characters of a name.
    if (name !== executable.slice(0, 15)) continue;
    try {
      if (setsHome(await NodeFSP.readFile(`/proc/${entry}/environ`, "utf8"), home))
        users.push({ pid: Number(entry), executable: name });
    } catch (cause) {
      // Another user's process can't be ours; one that ended meanwhile may have left a helper.
      if ((cause as NodeJS.ErrnoException).code !== "EACCES") changed = true;
    }
  }
  return { users, changed };
}

/** Processes of `executable`, other than this one, whose environment sets HOME to `home`. */
export async function processesUsingHome(
  home: string,
  platform: NodeJS.Platform,
  executable = "droid",
): Promise<Scan> {
  const scan =
    platform === "darwin" ? await darwinScan(home, executable) : await linuxScan(home, executable);
  return { ...scan, users: scan.users.filter(({ pid }) => pid !== process.pid) };
}

/**
 * Returns once no process uses `home`: each round waits for the kernel to report that every
 * process found has exited, then looks again for ones they started meanwhile.
 */
export async function waitUntilHomeIdle(
  home: string,
  platform: NodeJS.Platform,
  deadline: AbortSignal,
  executable = "droid",
): Promise<void> {
  for (;;) {
    const { users, changed } = await processesUsingHome(home, platform, executable);
    if (users.length === 0 && !changed) return;
    if (deadline.aborted)
      throw new Error(
        `Droid processes still use the test's HOME after ${IDLE_DEADLINE_MS / 1000} s: ${
          users
            .map(({ pid, executable }) => `${pid} ${NodePath.basename(executable)}`)
            .join(", ") || "the process list kept changing"
        }`,
      );
    // A scan that changed under it is simply taken again.
    if (users.length === 0) continue;
    await execFile("python3", ["-I", "-S", OBSERVER, ...users.map(({ pid }) => String(pid))], {
      signal: deadline,
    }).catch((cause: unknown) => {
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
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => waitUntilHomeIdle(home, platform, AbortSignal.timeout(IDLE_DEADLINE_MS))),
  );
});
