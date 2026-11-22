// @effect-diagnostics nodeBuiltinImport:off -- starts detached writers, as Droid's exit courier is.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";

import {
  processTable,
  scanHome,
  waitUntilHomeIdle,
  type ListedProcess,
  type ProcessState,
  type ProcessTable,
} from "./DroidLiveHome.testkit.ts";

const platform = HostProcess.Platform.defaultValue();
const HOME = "/tmp/scient droid home";

/** A table that lists `listed` and answers each read from `states`. */
const table = (
  listed: ReadonlyArray<ListedProcess>,
  states: Readonly<Record<number, ProcessState>> = {},
): ProcessTable => ({
  list: async () => listed,
  state: async (pid) => states[pid] ?? "other",
});
const droid = (pid: number, zombie = false): ListedProcess => ({
  pid,
  zombie,
  name: "/opt/droid/droid",
});

describe("a scan of the processes using a Droid live test's HOME", () => {
  it("finds Droid's processes with that HOME and nothing else", async () => {
    const scan = await scanHome(
      table([droid(10), droid(11), { pid: 12, zombie: false, name: "/usr/bin/node" }], {
        10: "ours",
        11: "other",
        12: "ours",
      }),
      HOME,
      "droid",
      new Set(),
    );
    expect(scan).toEqual({ users: [10], changed: false, zombies: new Set() });
  });

  it("is taken again when a listed Droid process ended or couldn't be read in the meantime", async () => {
    for (const state of ["gone", "zombie", "starting"] as const) {
      const scan = await scanHome(table([droid(10)], { 10: state }), HOME, "droid", new Set());
      expect(scan.changed).toBe(true);
    }
    // Listed while its arguments couldn't be read, or gone before it could be named.
    for (const listed of [
      { pid: 10, zombie: false, name: "(droid)" },
      { pid: 10, zombie: false, name: undefined },
    ]) {
      expect((await scanHome(table([listed]), HOME, "droid", new Set())).changed).toBe(true);
    }
  });

  it("counts a defunct Droid process once: a later scan knows it died before", async () => {
    const first = await scanHome(table([droid(10, true)]), HOME, "droid", new Set());
    expect(first).toEqual({ users: [], changed: true, zombies: new Set([10]) });
    const second = await scanHome(table([droid(10, true)]), HOME, "droid", first.zombies);
    expect(second.changed).toBe(false);
  });

  it("waits for each process found to exit, then looks again for what it left running", async () => {
    // The courier appears only once the session that started it has exited.
    const rounds = [table([droid(10)], { 10: "ours" }), table([droid(11)], { 11: "ours" })];
    const waited: Array<ReadonlyArray<number>> = [];
    let round = 0;
    const current = () => rounds[round] ?? table([]);
    await waitUntilHomeIdle(HOME, new AbortController().signal, {
      table: { list: () => current().list(), state: (pid, home) => current().state(pid, home) },
      waitForExits: async (pids) => {
        waited.push(pids);
        round += 1;
      },
    });
    expect(waited).toEqual([[10], [11]]);
  });

  it("fails at the deadline, naming what still runs", async () => {
    const deadline = new AbortController();
    deadline.abort();
    await expect(
      waitUntilHomeIdle(HOME, deadline.signal, {
        table: table([droid(10)], { 10: "ours" }),
        waitForExits: async () => undefined,
      }),
    ).rejects.toThrow(/still use the test's HOME .*: 10$/);
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
        const after = await scanHome(processTable(platform), home, node, new Set());
        expect(after.users).toEqual([]);
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
