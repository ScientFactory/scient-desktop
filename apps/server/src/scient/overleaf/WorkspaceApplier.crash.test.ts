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
import type { WorkspaceApplyPlan } from "./WorkspaceApplier.ts";
import { fixture } from "./WorkspaceApplier.testkit.ts";

const canPublish = await nativePublicationHost();
const child = NodePath.join(import.meta.dirname, "WorkspaceApplier.crash-child.ts");
const revisions = (files: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name, bytesRevision(Buffer.from(text))]),
  );
const read = (cwd: string, name: string) =>
  NodeFSP.readFile(NodePath.join(cwd, name), "utf8").catch(() => null);
async function put(cwd: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(cwd, name)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(cwd, name), text);
  }
}

interface Scenario {
  readonly captured: Record<string, string>;
  readonly target: Record<string, string>;
  readonly renames?: WorkspaceApplyPlan["renames"];
}
/** `a.tex` changes and `guard.tex` stays; both are one unit, applied together or not at all. */
const edit: Scenario = {
  captured: { "a.tex": "base", "guard.tex": "guard" },
  target: { "a.tex": "remote", "guard.tex": "guard" },
};

/**
 * Writes `scenario.captured` to the folder and runs its apply, every path in one
 * unit, in a child that dies the `occurrence`th time it reaches `killAt`.
 */
async function crashAt(
  h: { root: string; cwd: string; owner: string },
  killAt: MutationPoint,
  scenario: Scenario = edit,
  occurrence = 1,
) {
  await put(h.cwd, scenario.captured);
  const job: CrashJob = {
    root: h.root,
    cwd: h.cwd,
    owner: h.owner,
    helper: (await filePublicationTestHelper())!,
    id: "crash",
    killAt,
    occurrence,
    plan: {
      base: revisions(scenario.captured),
      remote: revisions(scenario.target),
      captured: revisions(scenario.captured),
      target: Object.fromEntries(
        Object.entries(scenario.target).map(([name, text]) => [
          name,
          Buffer.from(text).toString("base64"),
        ]),
      ),
      renames: scenario.renames ?? [],
      conflicts: [
        {
          paths: [...new Set([...Object.keys(scenario.captured), ...Object.keys(scenario.target)])],
          types: ["content"],
          origins: ["merge"],
        },
      ],
      markerPaths: [],
    },
  };
  const jobPath = NodePath.join(h.root, "crash.json");
  await NodeFSP.writeFile(jobPath, JSON.stringify(job));
  const run = NodeChildProcess.spawnSync(process.execPath, [child, jobPath], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(run.signal, run.stderr).toBe("SIGKILL");
}
type Harness = Parameters<Parameters<typeof fixture>[0]>[0];
/** A settled read of the whole folder, as an editor makes, which settles every pending record. */
const editorReads = (h: Harness) =>
  h.run(h.files.withSettledWorkspaceRead({ cwd: h.cwd }, () => Effect.void));

describe.skipIf(!canPublish)("WorkspaceApplier after real process death", () => {
  // Nothing was visible yet: the group's changed file must stop the staged write.
  it.live.each(["intent", "prepared"] as const)(
    "publishes nothing into a group changed after a crash at %s",
    (point) =>
      fixture(async (h) => {
        await crashAt(h, point);
        await NodeFSP.writeFile(NodePath.join(h.cwd, "guard.tex"), "later");
        await h.restart();
        const result = await h.apply("crash");
        expect(result.interrupted).toEqual([]);
        expect([...result.base]).toEqual(Object.entries(revisions(edit.captured)));
        expect(await read(h.cwd, "a.tex")).toBe("base");
        expect(await read(h.cwd, "guard.tex")).toBe("later");
      }),
  );

  it.live("publishes nothing into a changed group when an editor reads first", () =>
    fixture(async (h) => {
      await crashAt(h, "prepared");
      await NodeFSP.writeFile(NodePath.join(h.cwd, "guard.tex"), "later");
      await h.restart();
      await editorReads(h);
      expect(await read(h.cwd, "a.tex")).toBe("base");
      expect((await h.apply("crash")).interrupted).toEqual([]);
      expect(await read(h.cwd, "a.tex")).toBe("base");
    }),
  );

  // A peer is checked by what stands there, not only by its bytes.
  it.live.each(["empty folder", "folder with a file", "link"] as const)(
    "publishes nothing when a peer that should be absent becomes a %s",
    (occupant) =>
      fixture(async (h) => {
        await crashAt(h, "prepared", {
          captured: { "guard.tex": "guard" },
          target: { "a.tex": "remote", "b.tex": "B", "guard.tex": "guard" },
        });
        const peer = NodePath.join(h.cwd, "b.tex");
        if (occupant === "link") {
          await NodeFSP.writeFile(NodePath.join(h.root, "outside"), "B");
          await NodeFSP.symlink(NodePath.join(h.root, "outside"), peer);
        } else {
          await NodeFSP.mkdir(peer);
          if (occupant === "folder with a file") await put(peer, { "later.tex": "later" });
        }
        await h.restart();
        await editorReads(h);
        expect(await read(h.cwd, "a.tex")).toBeNull();
        await h.apply("crash").catch(() => undefined);
        expect(await read(h.cwd, "a.tex")).toBeNull();
      }),
  );

  it.live("publishes nothing when a peer's folder is replaced by a link to the same bytes", () =>
    fixture(async (h) => {
      await crashAt(h, "prepared", {
        captured: { "a.tex": "base", "sub/guard.tex": "guard" },
        target: { "a.tex": "remote", "sub/guard.tex": "guard" },
      });
      await NodeFSP.rename(NodePath.join(h.cwd, "sub"), NodePath.join(h.cwd, "sub-original"));
      await put(NodePath.join(h.root, "outside"), { "guard.tex": "guard" });
      await NodeFSP.symlink(NodePath.join(h.root, "outside"), NodePath.join(h.cwd, "sub"));
      await h.restart();
      await editorReads(h);
      expect(await read(h.cwd, "a.tex")).toBe("base");
    }),
  );

  // After a crash before staging, settling the record without its bytes closes it as
  // skipped; the apply ends with nothing published and the next review plans again.
  it.live("publishes nothing and stays recoverable after a crash at intent", () =>
    fixture(async (h) => {
      await crashAt(h, "intent");
      await h.restart();
      const result = await h.apply("crash");
      expect(result.interrupted).toEqual([]);
      expect([...result.base]).toEqual(Object.entries(revisions(edit.captured)));
      expect(await read(h.cwd, "a.tex")).toBe("base");
      expect((await h.apply("crash")).interrupted).toEqual([]);
    }),
  );

  it.live.each(["prepared", "displaced"] as const)(
    "finishes the unit after a crash at %s when nothing else changed",
    (point) =>
      fixture(async (h) => {
        await crashAt(h, point);
        await h.restart();
        expect(await h.apply("crash")).toMatchObject({ outcome: "complete", matchesTarget: true });
        expect(await read(h.cwd, "a.tex")).toBe("remote");
      }),
  );

  // Already visible: the group is reported, the base stays, and the later edit survives.
  it.live("reports a group changed after a crash once the new file was visible", () =>
    fixture(async (h) => {
      await crashAt(h, "displaced");
      await NodeFSP.writeFile(NodePath.join(h.cwd, "guard.tex"), "later");
      await h.restart();
      const result = await h.apply("crash");
      expect(result.interrupted).toEqual([["a.tex", "guard.tex"]]);
      expect([...result.base]).toEqual(Object.entries(revisions(edit.captured)));
      expect(await read(h.cwd, "guard.tex")).toBe("later");
    }),
  );

  // Every shape of unit, killed while a step is staged: unchanged, recovery finishes it;
  // with the guard changed, the first step publishes nothing and later ones are reported.
  const shapes = [
    {
      name: "a rename's destination",
      occurrence: 1,
      captured: { "old.tex": "base", "guard.tex": "guard" },
      target: { "new.tex": "remote", "guard.tex": "guard" },
      renames: [{ from: "old.tex", to: "new.tex" }],
    },
    {
      name: "a rename's removal",
      occurrence: 2,
      captured: { "old.tex": "base", "guard.tex": "guard" },
      target: { "new.tex": "remote", "guard.tex": "guard" },
      renames: [{ from: "old.tex", to: "new.tex" }],
    },
    {
      name: "a file giving way to a folder",
      occurrence: 1,
      captured: { notes: "base", "guard.tex": "guard" },
      target: { "notes/a.tex": "remote", "notes/b.tex": "B", "guard.tex": "guard" },
    },
    {
      name: "a file in a folder replacing a file",
      occurrence: 2,
      captured: { notes: "base", "guard.tex": "guard" },
      target: { "notes/a.tex": "remote", "notes/b.tex": "B", "guard.tex": "guard" },
    },
    {
      name: "a folder giving way to a file",
      occurrence: 1,
      captured: { "notes/a.tex": "base", "notes/b.tex": "B", "guard.tex": "guard" },
      target: { notes: "remote", "guard.tex": "guard" },
    },
    {
      name: "a file replacing a folder",
      occurrence: 4,
      captured: { "notes/a.tex": "base", "notes/b.tex": "B", "guard.tex": "guard" },
      target: { notes: "remote", "guard.tex": "guard" },
    },
    {
      name: "a deletion",
      occurrence: 1,
      captured: { "a.tex": "base", "guard.tex": "guard" },
      target: { "guard.tex": "guard" },
    },
  ];
  it.live.each(shapes.flatMap((shape) => [false, true].map((changed) => ({ ...shape, changed }))))(
    "recovers $name killed while staged, guard changed: $changed",
    (shape) =>
      fixture(async (h) => {
        await crashAt(h, "prepared", shape, shape.occurrence);
        if (shape.changed) await NodeFSP.writeFile(NodePath.join(h.cwd, "guard.tex"), "later");
        await h.restart();
        await editorReads(h);
        const result = await h.apply("crash");
        if (!shape.changed) {
          expect(result).toMatchObject({ outcome: "complete", matchesTarget: true });
          for (const [name, text] of Object.entries(shape.target))
            expect(await read(h.cwd, name)).toBe(text);
          return;
        }
        expect(await read(h.cwd, "guard.tex")).toBe("later");
        expect(Object.fromEntries(result.base)).toEqual(revisions(shape.captured));
        if (shape.occurrence === 1) {
          expect(result.interrupted).toEqual([]);
          for (const [name, text] of Object.entries(shape.captured))
            if (name !== "guard.tex") expect(await read(h.cwd, name)).toBe(text);
        } else expect(result.interrupted).toHaveLength(1);
      }),
  );

  // Without a crash: a peer that changes while the step is staged stops it before publishing.
  it.live("publishes nothing when a peer changes while the step is staged", () => {
    let folder = "";
    return fixture(
      async (h) => {
        folder = h.cwd;
        await put(h.cwd, edit.captured);
        const result = await h.apply("late", {
          base: new Map(Object.entries(revisions(edit.captured))),
          remote: new Map(Object.entries(revisions(edit.target))),
          captured: new Map(Object.entries(revisions(edit.captured))),
          target: new Map(
            Object.entries(edit.target).map(([name, text]) => [name, { bytes: Buffer.from(text) }]),
          ),
          renames: [],
          conflicts: [{ paths: ["a.tex", "guard.tex"], types: ["content"], origins: ["merge"] }],
          markerPaths: [],
        });
        expect(result.interrupted).toEqual([]);
        expect(await read(h.cwd, "a.tex")).toBe("base");
        expect(await read(h.cwd, "guard.tex")).toBe("later");
      },
      {},
      {
        at: async (point) => {
          if (point === "prepared")
            await NodeFSP.writeFile(NodePath.join(folder, "guard.tex"), "later");
        },
      },
    );
  });
});
