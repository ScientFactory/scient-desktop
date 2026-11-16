// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { withinDeadline } from "./Deadline.ts";
import type { SaveExitJob } from "./Deadline.exit-child.ts";
import { filePublicationTestHelper, nativePublicationHost } from "./fileExchange.testkit.ts";

const canPublish = await nativePublicationHost();
const child = NodePath.join(import.meta.dirname, "Deadline.exit-child.ts");

describe("withinDeadline", () => {
  it("settles with the work when it finishes first, value or rejection", async () => {
    expect(await withinDeadline(Promise.resolve("done"), 30_000, false)).toBe("done");
    const failure = new Error("work failed");
    await expect(withinDeadline(Promise.reject(failure), 30_000, false)).rejects.toBe(failure);
  });

  it("settles with the expired value when the deadline comes first", async () => {
    let fail!: (cause: unknown) => void;
    const work = new Promise<string>((_, reject) => (fail = reject));
    expect(await withinDeadline(work, 0, [])).toEqual([]);
    // Work that fails after losing is already observed by the race, not left unhandled.
    fail(new Error("too late"));
    await expect(work).rejects.toThrow("too late");
  });
});

// The save waits on earlier unfinished work for up to 30 s; once that settles, its deadline must
// not keep the process alive. The ceiling sits far below 30 s and far above a normal exit.
describe.skipIf(!canPublish)("a plain save behind a qualified helper", () => {
  it.live("lets its process exit once the save is done", () =>
    Effect.promise(async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-deadline-"));
      try {
        const cwd = NodePath.join(root, "project");
        await NodeFSP.mkdir(cwd);
        const job: SaveExitJob = { root, cwd, helper: (await filePublicationTestHelper())! };
        const jobPath = NodePath.join(root, "job.json");
        await NodeFSP.writeFile(jobPath, JSON.stringify(job));
        const run = NodeChildProcess.spawnSync(process.execPath, [child, jobPath], {
          encoding: "utf8",
          timeout: 15_000,
        });
        expect({ status: run.status, signal: run.signal, stdout: run.stdout }, run.stderr).toEqual({
          status: 0,
          signal: null,
          stdout: "after\n",
        });
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }),
  );
});
