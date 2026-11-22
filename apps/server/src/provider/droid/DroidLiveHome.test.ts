// @effect-diagnostics nodeBuiltinImport:off -- starts detached writers, as Droid's exit courier is.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";

import {
  checkHome,
  processTable,
  scanHome,
  waitUntilHomeIdle,
  type ProcessState,
  type ProcessTable,
} from "./DroidLiveHome.testkit.ts";

const platform = HostProcess.Platform.defaultValue();
const HOME = "/tmp/scient-droid-home";
const never = new AbortController().signal;

/**
 * A table whose listings come from `scans`, one per scan (the last one repeating), each a map from
 * a Droid PID to what a read of it finds.
 */
function scripted(scans: ReadonlyArray<Readonly<Record<number, ProcessState>>>) {
  let index = -1;
  const current = () => scans[Math.min(index, scans.length - 1)] ?? {};
  const table: ProcessTable = {
    list: async () => {
      index += 1;
      return [
        ...Object.keys(current()).map((pid) => ({ pid: Number(pid), name: "droid" })),
        { pid: 99, name: "node" },
      ];
    },
    state: async (pid) => (pid === 99 ? "ours" : (current()[pid] ?? "gone")),
  };
  return { table, scans: () => index + 1 };
}

describe("a scan of the processes using a Droid live test's HOME", () => {
  it("finds Droid's processes with that HOME and nothing else", async () => {
    const { table } = scripted([{ 10: "ours", 11: "other", 12: "gone", 13: "zombie" }]);
    expect(await scanHome(table, HOME, "droid", never)).toEqual({ users: [10], uncertain: false });
  });

  it("can't rule out a Droid process whose environment couldn't be read yet", async () => {
    const { table } = scripted([{ 10: "starting" }]);
    expect(await scanHome(table, HOME, "droid", never)).toEqual({ users: [], uncertain: true });
  });

  it("calls HOME idle only after two clean scans in a row", async () => {
    const quiet = scripted([{}]);
    await waitUntilHomeIdle(HOME, never, { table: quiet.table });
    expect(quiet.scans()).toBe(2);
    // The first scan missed a courier its exiting parent started meanwhile; the second finds it.
    const handOff = scripted([{}, { 11: "ours" }, {}]);
    const waited: Array<ReadonlyArray<number>> = [];
    await waitUntilHomeIdle(HOME, never, {
      table: handOff.table,
      waitForExits: async (pids) => void waited.push(pids),
    });
    expect(waited).toEqual([[11]]);
    expect(handOff.scans()).toBe(4);
  });

  it("waits for each process found to exit, then looks again for what it left running", async () => {
    const { table } = scripted([{ 10: "ours" }, { 11: "ours" }, {}]);
    const waited: Array<ReadonlyArray<number>> = [];
    await waitUntilHomeIdle(HOME, never, {
      table,
      waitForExits: async (pids) => void waited.push(pids),
    });
    expect(waited).toEqual([[10], [11]]);
  });

  it("at the deadline kills what still runs and waits for it before failing", async () => {
    const deadline = new AbortController();
    deadline.abort();
    const killed: Array<number> = [];
    const waited: Array<ReadonlyArray<number>> = [];
    await expect(
      waitUntilHomeIdle(HOME, deadline.signal, {
        table: scripted([{ 10: "ours" }]).table,
        kill: (pid) => void killed.push(pid),
        waitForExits: async (pids) => void waited.push(pids),
        grace: () => never,
      }),
    ).rejects.toThrow(/were killed: 10$/);
    expect(killed).toEqual([10]);
    expect(waited).toEqual([[10]]);
  });

  it("refuses a HOME that a space-separated environment can't show exactly", () => {
    for (const home of ["/tmp/a b", "/tmp/a\tb", "/tmp/é"]) expect(() => checkHome(home)).toThrow();
    expect(() => checkHome(HOME)).not.toThrow();
  });
});

/** The writers stand in for Droid's processes; the real ones are found by Droid's name. */
const node = NodePath.basename(process.execPath);

/**
 * A detached writer, like the courier: a non-system executable (macOS hides system binaries'
 * environments) in its own process group. After `handOffMs` it starts a detached child that
 * writes the marker under HOME 1 s later, and exits.
 */
function startWriter(home: string, marker: string, handOffMs: number) {
  const late = `setTimeout(() => { require("node:fs").mkdirSync(${JSON.stringify(NodePath.dirname(marker))}); require("node:fs").writeFileSync(${JSON.stringify(marker)}, "done\\n"); }, 1000)`;
  const handOff = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(late)}], { detached: true, stdio: "ignore" }).unref()`;
  const writer = NodeChildProcess.spawn(
    process.execPath,
    ["-e", `setTimeout(() => { ${handOff} }, ${handOffMs})`],
    // Only HOME and PATH: the test runner's NODE_OPTIONS would load its hooks into the writers.
    { detached: true, stdio: "ignore", env: { HOME: home, PATH: process.env.PATH ?? "" } },
  );
  writer.unref();
  // As at a live test's end: the helper is already running when the wait starts.
  return new Promise((resolve) => writer.once("spawn", resolve));
}

describe.skipIf(platform === "win32")("a Droid live test's HOME on this computer", () => {
  it.each([
    { handOff: "at once", ms: 0 },
    { handOff: "only after a first wait has begun", ms: 1000 },
  ])(
    "is idle only once a detached writer handing off $handOff and its child have exited",
    async ({ ms }) => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-droid-home-"));
      try {
        const marker = NodePath.join(home, "exit-spool", "done");
        await startWriter(home, marker, ms);
        await waitUntilHomeIdle(home, AbortSignal.timeout(15_000), {
          table: processTable(platform),
          executable: node,
        });
        expect(NodeFS.readFileSync(marker, "utf8")).toBe("done\n");
        const after = await scanHome(processTable(platform), home, node, never);
        expect(after.users).toEqual([]);
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
