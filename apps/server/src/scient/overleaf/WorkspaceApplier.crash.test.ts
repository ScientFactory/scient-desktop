// @effect-diagnostics nodeBuiltinImport:off
/**
 * Recovery after real process death. A child process runs the apply and kills
 * itself at a native publication hook; this process then resumes the same
 * durable apply. A thrown hook cannot stand in for this: it runs the file
 * layer's failure handler, which a crash never does.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  filePublicationTestHelper,
  nativePublicationHost,
} from "../workspace/fileExchange.testkit.ts";
import { bytesRevision, type MutationPoint } from "../workspace/RetainedFileMutation.ts";
import type { CrashJob } from "./WorkspaceApplier.crash-child.ts";
import { fixture } from "./WorkspaceApplier.testkit.ts";

const canPublish = await nativePublicationHost();
const child = NodePath.join(import.meta.dirname, "WorkspaceApplier.crash-child.ts");
const revisions = (files: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name, bytesRevision(Buffer.from(text))]),
  );
const read = (cwd: string, name: string) =>
  NodeFSP.readFile(NodePath.join(cwd, name), "utf8").catch(() => null);

/** `a.tex` changes and `guard.tex` stays; both are one unit, applied together or not at all. */
const captured = { "a.tex": "base", "guard.tex": "guard" };
const target = { "a.tex": "remote", "guard.tex": "guard" };

/** Runs the apply in a child that dies at `killAt`, leaving its durable records behind. */
async function crashAt(
  h: { root: string; cwd: string; owner: string },
  id: string,
  killAt: MutationPoint,
) {
  const job: CrashJob = {
    root: h.root,
    cwd: h.cwd,
    owner: h.owner,
    helper: (await filePublicationTestHelper())!,
    id,
    killAt,
    plan: {
      base: revisions(captured),
      remote: revisions(target),
      captured: revisions(captured),
      target: Object.fromEntries(
        Object.entries(target).map(([name, text]) => [name, Buffer.from(text).toString("base64")]),
      ),
      renames: [],
      conflicts: [{ paths: ["a.tex", "guard.tex"], types: ["content"], origins: ["merge"] }],
      markerPaths: [],
    },
  };
  const jobPath = NodePath.join(h.root, `${id}.json`);
  await NodeFSP.writeFile(jobPath, JSON.stringify(job));
  const run = NodeChildProcess.spawnSync(process.execPath, [child, jobPath], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(run.signal, run.stderr).toBe("SIGKILL");
}

describe.skipIf(!canPublish)("WorkspaceApplier after real process death", () => {
  // Nothing was visible yet: the group's changed file must stop the staged write.
  it.live.each(["intent", "prepared"] as const)(
    "publishes nothing into a group changed after a crash at %s",
    (point) =>
      fixture(async (h) => {
        for (const [name, text] of Object.entries(captured))
          await NodeFSP.writeFile(NodePath.join(h.cwd, name), text);
        await crashAt(h, "crash", point);
        await NodeFSP.writeFile(NodePath.join(h.cwd, "guard.tex"), "later");
        await h.restart();
        const result = await h.apply("crash");
        expect(result.interrupted).toEqual([]);
        expect([...result.base]).toEqual(Object.entries(revisions(captured)));
        expect(await read(h.cwd, "a.tex")).toBe("base");
        expect(await read(h.cwd, "guard.tex")).toBe("later");
      }),
  );

  // After a crash before staging, settling the record without its bytes closes it as
  // skipped; the apply ends with nothing published and the next review plans again.
  it.live("publishes nothing and stays recoverable after a crash at intent", () =>
    fixture(async (h) => {
      for (const [name, text] of Object.entries(captured))
        await NodeFSP.writeFile(NodePath.join(h.cwd, name), text);
      await crashAt(h, "crash", "intent");
      await h.restart();
      const result = await h.apply("crash");
      expect(result.interrupted).toEqual([]);
      expect([...result.base]).toEqual(Object.entries(revisions(captured)));
      expect(await read(h.cwd, "a.tex")).toBe("base");
      expect((await h.apply("crash")).interrupted).toEqual([]);
    }),
  );

  it.live.each(["prepared", "displaced"] as const)(
    "finishes the unit after a crash at %s when nothing else changed",
    (point) =>
      fixture(async (h) => {
        for (const [name, text] of Object.entries(captured))
          await NodeFSP.writeFile(NodePath.join(h.cwd, name), text);
        await crashAt(h, "crash", point);
        await h.restart();
        expect(await h.apply("crash")).toMatchObject({ outcome: "complete", matchesTarget: true });
        expect(await read(h.cwd, "a.tex")).toBe("remote");
      }),
  );

  // Already visible: the group is reported, the base stays, and the later edit survives.
  it.live("reports a group changed after a crash once the new file was visible", () =>
    fixture(async (h) => {
      for (const [name, text] of Object.entries(captured))
        await NodeFSP.writeFile(NodePath.join(h.cwd, name), text);
      await crashAt(h, "crash", "displaced");
      await NodeFSP.writeFile(NodePath.join(h.cwd, "guard.tex"), "later");
      await h.restart();
      const result = await h.apply("crash");
      expect(result.interrupted).toEqual([["a.tex", "guard.tex"]]);
      expect([...result.base]).toEqual(Object.entries(revisions(captured)));
      expect(await read(h.cwd, "guard.tex")).toBe("later");
    }),
  );

  // Another reader settling first must not publish into a changed group either.
  it.live("publishes nothing into a changed group when an editor reads first", () =>
    fixture(async (h) => {
      for (const [name, text] of Object.entries(captured))
        await NodeFSP.writeFile(NodePath.join(h.cwd, name), text);
      await crashAt(h, "crash", "prepared");
      await NodeFSP.writeFile(NodePath.join(h.cwd, "guard.tex"), "later");
      await h.restart();
      await h.run(h.files.withSettledWorkspaceRead({ cwd: h.cwd }, () => Effect.void));
      expect(await read(h.cwd, "a.tex")).toBe("base");
      expect((await h.apply("crash")).interrupted).toEqual([]);
      expect(await read(h.cwd, "a.tex")).toBe("base");
    }),
  );
});
