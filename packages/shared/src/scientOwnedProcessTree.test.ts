// @effect-diagnostics nodeBuiltinImport:off -- the live test starts real processes.
import * as NodeChildProcess from "node:child_process";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import * as HostProcess from "./HostProcess.ts";

import {
  descendantsOf,
  makeOwnedProcessTree,
  parseProcessTable,
  ProcessTableUnavailable,
  readProcessTable,
  type OwnedProcess,
} from "./scientOwnedProcessTree.ts";

const entry = (pid: number, ppid: number, pgid = pid, identity = `t${pid}`): OwnedProcess => ({
  pid,
  ppid,
  pgid,
  identity,
});

describe("parseProcessTable", () => {
  it("reads the start time and the command, which may hold spaces", () => {
    assert.deepStrictEqual(
      parseProcessTable(
        [
          "    1     0     1 Wed Nov 11 17:00:00 2026     /sbin/launchd",
          "  420     1   420 Sun Nov  1 07:42:16 2026     /Applications/Some App.app/Contents/MacOS/Some App",
          "",
        ].join("\n"),
      ),
      [
        { pid: 1, ppid: 0, pgid: 1, identity: "Wed Nov 11 17:00:00 2026\u0000/sbin/launchd" },
        {
          pid: 420,
          ppid: 1,
          pgid: 420,
          identity:
            "Sun Nov 1 07:42:16 2026\u0000/Applications/Some App.app/Contents/MacOS/Some App",
        },
      ],
    );
  });
});

describe("descendantsOf", () => {
  it("follows the parent chain across process groups and ignores the rest", () => {
    const table = [
      entry(10, 1),
      entry(11, 10, 10),
      entry(12, 11), // started its own group
      entry(13, 12, 12),
      entry(20, 1),
      entry(21, 20),
    ];
    assert.deepStrictEqual(
      descendantsOf(table, 10).map((process) => process.pid),
      [11, 12, 13],
    );
  });
});

describe("makeOwnedProcessTree", () => {
  it.live("stops recorded survivors and what they started since, one process at a time", () =>
    Effect.gen(function* () {
      let table: ReadonlyArray<OwnedProcess> = [
        entry(10, 1),
        entry(11, 10, 10), // in the root's group
        entry(12, 11, 12), // left it
        entry(30, 1),
      ];
      const signals: Array<[number, string]> = [];
      const tree = makeOwnedProcessTree(10, {
        readTable: Effect.sync(() => table),
        parentPid: 1,
        signal: (pid, name) => {
          signals.push([pid, name]);
          // 11 stops on SIGTERM; 12 and its later child 13 ignore it.
          if (name === "SIGTERM") table = table.filter((process) => process.pid !== 11);
        },
      });
      yield* tree.sample;
      // The root dies and its children are re-parented. 12 started 13 after the last sample;
      // 31 is an unrelated member of 12's group that 12 did not start.
      table = [
        entry(11, 1, 10),
        entry(12, 1, 12),
        entry(13, 12, 12),
        entry(31, 30, 12),
        entry(30, 1),
      ];
      const result = yield* tree.reap("10 millis");
      assert.deepStrictEqual(result, { terminated: 3, killed: 2, unverified: 0 });
      assert.deepStrictEqual(signals, [
        [11, "SIGTERM"],
        [12, "SIGTERM"],
        [13, "SIGTERM"],
        [13, "SIGKILL"],
        [12, "SIGKILL"],
      ]);
    }),
  );

  it.live("kills what a survivor starts during the grace, children first", () =>
    Effect.gen(function* () {
      let table: ReadonlyArray<OwnedProcess> = [entry(10, 1), entry(12, 10, 12)];
      const signals: Array<[number, string]> = [];
      const tree = makeOwnedProcessTree(10, {
        readTable: Effect.sync(() => table),
        parentPid: 1,
        signal: (pid, name) => {
          signals.push([pid, name]);
          // 12 ignores SIGTERM and starts 14 while the grace runs.
          if (name === "SIGTERM") table = [entry(12, 1, 12), entry(14, 12, 14)];
        },
      });
      yield* tree.sample;
      table = [entry(12, 1, 12)];
      assert.deepStrictEqual(yield* tree.reap("10 millis"), {
        terminated: 1,
        killed: 2,
        unverified: 0,
      });
      assert.deepStrictEqual(signals, [
        [12, "SIGTERM"],
        [14, "SIGKILL"],
        [12, "SIGKILL"],
      ]);
    }),
  );

  it.effect("never signals a process that only reused a recorded PID", () =>
    Effect.gen(function* () {
      let table: ReadonlyArray<OwnedProcess> = [entry(10, 1), entry(11, 10)];
      const signals: Array<number> = [];
      const tree = makeOwnedProcessTree(10, {
        readTable: Effect.sync(() => table),
        parentPid: 1,
        signal: (pid) => signals.push(pid),
      });
      yield* tree.sample;
      table = [entry(11, 1, 11, "a later start or another command")];
      assert.deepStrictEqual(yield* tree.reap("10 millis"), {
        terminated: 0,
        killed: 0,
        unverified: 0,
      });
      assert.deepStrictEqual(signals, []);
    }),
  );

  it.effect("forgets recorded processes once they exit", () =>
    Effect.gen(function* () {
      let table: ReadonlyArray<OwnedProcess> = [entry(10, 1), entry(11, 10)];
      const signals: Array<number> = [];
      const tree = makeOwnedProcessTree(10, {
        readTable: Effect.sync(() => table),
        parentPid: 1,
        signal: (pid) => signals.push(pid),
      });
      yield* tree.sample;
      table = [entry(10, 1)];
      yield* tree.sample;
      table = [entry(11, 1)];
      assert.deepStrictEqual(yield* tree.reap("10 millis"), {
        terminated: 0,
        killed: 0,
        unverified: 0,
      });
      assert.deepStrictEqual(signals, []);
    }),
  );
});

describe("makeOwnedProcessTree when ps fails", () => {
  const unavailable = Effect.fail(new ProcessTableUnavailable({ cause: "ps timed out" }));

  it.live("a failed sample forgets nothing, and a failed reap read is retried", () =>
    Effect.gen(function* () {
      let failures = 0;
      let table: ReadonlyArray<OwnedProcess> = [entry(10, 1), entry(11, 10, 11)];
      const signals: Array<[number, string]> = [];
      const tree = makeOwnedProcessTree(10, {
        readTable: Effect.suspend(() =>
          failures > 0 ? (failures--, unavailable) : Effect.succeed(table),
        ),
        parentPid: 1,
        readRetrySpacing: "1 milli",
        sampleRetrySpacing: "1 milli",
        signal: (pid, name) => {
          signals.push([pid, name]);
          table = [];
        },
      });
      yield* tree.sample;
      // Both of the sample's reads fail.
      failures = 2;
      yield* tree.sample;
      table = [entry(11, 1, 11)];
      failures = 2;
      assert.deepStrictEqual(yield* tree.reap("10 millis"), {
        terminated: 1,
        killed: 0,
        unverified: 0,
      });
      assert.deepStrictEqual(signals, [[11, "SIGTERM"]]);
    }),
  );

  it.live("a sample reads again once when the first read fails", () =>
    Effect.gen(function* () {
      let failures = 1;
      const table = [entry(10, 1), entry(11, 10, 11)];
      const signals: Array<[number, string]> = [];
      const tree = makeOwnedProcessTree(10, {
        readTable: Effect.suspend(() =>
          failures > 0 ? (failures--, unavailable) : Effect.succeed(table),
        ),
        parentPid: 1,
        sampleRetrySpacing: "1 milli",
        signal: (pid, name) => signals.push([pid, name]),
      });
      yield* tree.sample;
      assert.strictEqual(failures, 0);
      assert.deepStrictEqual(yield* tree.reap("1 milli"), {
        terminated: 1,
        killed: 1,
        unverified: 0,
      });
      assert.deepStrictEqual(signals, [
        [11, "SIGTERM"],
        [11, "SIGKILL"],
      ]);
    }),
  );

  it.live("signals nothing it could not see", () =>
    Effect.gen(function* () {
      let readable = true;
      const table = [entry(10, 1), entry(11, 10, 11)];
      const signals: Array<[number, string]> = [];
      const tree = makeOwnedProcessTree(10, {
        readTable: Effect.suspend(() => (readable ? Effect.succeed(table) : unavailable)),
        parentPid: 1,
        readRetrySpacing: "1 milli",
        signal: (pid, name) => {
          signals.push([pid, name]);
          readable = false;
        },
      });
      yield* tree.sample;
      // The table fails after SIGTERM: 11 may have exited and its PID been reused, so no SIGKILL.
      assert.deepStrictEqual(yield* tree.reap("10 millis"), {
        terminated: 1,
        killed: 0,
        unverified: 1,
      });
      assert.deepStrictEqual(signals, [[11, "SIGTERM"]]);

      readable = true;
      const blind = makeOwnedProcessTree(10, {
        readTable: Effect.suspend(() => (readable ? Effect.succeed(table) : unavailable)),
        parentPid: 1,
        readRetrySpacing: "1 milli",
        signal: (pid, name) => signals.push([pid, name]),
      });
      yield* blind.sample;
      readable = false;
      assert.deepStrictEqual(yield* blind.reap("10 millis"), {
        terminated: 0,
        killed: 0,
        unverified: 1,
      });
      assert.lengthOf(signals, 1);
    }),
  );
});

describe("makeOwnedProcessTree safety", () => {
  it.effect("records nothing under a root that is not this process's child", () =>
    Effect.gen(function* () {
      const table = [entry(10, 999), entry(11, 10, 11)];
      const signals: Array<number> = [];
      const tree = makeOwnedProcessTree(10, {
        readTable: Effect.succeed(table),
        signal: (pid) => signals.push(pid),
        parentPid: 1,
      });
      yield* tree.sample;
      assert.deepStrictEqual(yield* tree.reap("10 millis"), {
        terminated: 0,
        killed: 0,
        unverified: 0,
      });
      assert.deepStrictEqual(signals, []);
    }),
  );

  it.effect("never follows PID 1", () =>
    Effect.gen(function* () {
      const table = [entry(1, 0), entry(11, 1, 11)];
      const tree = makeOwnedProcessTree(1, { readTable: Effect.succeed(table), parentPid: 0 });
      yield* tree.sample;
      assert.deepStrictEqual(yield* tree.reap("10 millis"), {
        terminated: 0,
        killed: 0,
        unverified: 0,
      });
    }),
  );

  it.effect("stops following a root PID that a later process reused", () =>
    Effect.gen(function* () {
      let table: ReadonlyArray<OwnedProcess> = [entry(10, 1)];
      const tree = makeOwnedProcessTree(10, {
        readTable: Effect.sync(() => table),
        signal: () => {},
        parentPid: 1,
      });
      yield* tree.sample;
      table = [entry(10, 1, 10, "a later start"), entry(11, 10, 11)];
      yield* tree.sample;
      assert.deepStrictEqual(yield* tree.reap("10 millis"), {
        terminated: 0,
        killed: 0,
        unverified: 0,
      });
    }),
  );
});

// A grandchild in its own session outlives a killed root; the tree finds and stops it.
describe.skipIf(Context.get(Context.empty(), HostProcess.Platform) === "win32")(
  "on this system",
  () => {
    it.live("stops a descendant that left the root's process group", () =>
      Effect.gen(function* () {
        const script = `
        const child = require("node:child_process").spawn(process.execPath,
          ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
        console.log(child.pid);
        setInterval(() => {}, 1000);`;
        const root = NodeChildProcess.spawn(process.execPath, ["-e", script], {
          detached: true,
          stdio: ["ignore", "pipe", "ignore"],
        });
        const grandchild = yield* Effect.callback<number>((resume) => {
          root.stdout!.once("data", (chunk) =>
            resume(Effect.succeed(Number(String(chunk).trim()))),
          );
        });
        const alive = (pid: number) =>
          readProcessTable.pipe(
            Effect.map((table) => table.some((process) => process.pid === pid)),
          );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              process.kill(grandchild, "SIGKILL");
            } catch {}
          }),
        );
        // Every table the tree reads, so a failure says what sampling and stopping actually saw.
        const reads: Array<ReadonlyArray<OwnedProcess> | "ps failed"> = [];
        const tree = makeOwnedProcessTree(root.pid!, {
          readTable: readProcessTable.pipe(
            Effect.tap((table) => Effect.sync(() => reads.push(table))),
            Effect.tapError(() => Effect.sync(() => reads.push("ps failed"))),
          ),
        });
        const rowsOf = (read: (typeof reads)[number] | undefined) =>
          read === undefined || read === "ps failed"
            ? String(read)
            : JSON.stringify(read.filter((row) => row.pid === root.pid || row.pid === grandchild));
        yield* tree.sample;
        const sampled = reads.findLast((read) => read !== "ps failed");
        const seen = `sample reads: ${reads.map(rowsOf).join(" | ")}`;
        assert.isDefined(sampled, seen);
        const sampledRoot = sampled.find((row) => row.pid === root.pid);
        const sampledGrandchild = sampled.find((row) => row.pid === grandchild);
        assert.isDefined(sampledRoot, seen);
        assert.isDefined(sampledGrandchild, seen);
        assert.strictEqual(sampledRoot.ppid, process.pid, seen);
        assert.strictEqual(sampledGrandchild.ppid, root.pid, seen);
        assert.notStrictEqual(sampledGrandchild.pgid, sampledRoot.pgid, seen);
        const sampleReads = reads.length;
        process.kill(-root.pid!, "SIGKILL");
        yield* Effect.callback<void>((resume) => {
          root.once("exit", () => resume(Effect.void));
        });
        assert.isTrue(yield* alive(grandchild), "the grandchild survived its parent's group kill");
        const result = yield* tree.reap("2 seconds");
        assert.deepStrictEqual(
          result,
          { terminated: 1, killed: 0, unverified: 0 },
          `${seen}; stop reads: ${reads.slice(sampleReads).map(rowsOf).join(" | ")}`,
        );
        yield* Effect.promise(() =>
          expect
            .poll(
              () => {
                try {
                  process.kill(grandchild, 0);
                  return true;
                } catch {
                  return false;
                }
              },
              { timeout: 3_000 },
            )
            .toBe(false),
        );
      }),
    );
  },
);
