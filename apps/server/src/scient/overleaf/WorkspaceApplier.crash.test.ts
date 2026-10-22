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
  /** The last synchronized files, when they differ from what the folder held. */
  readonly base?: Record<string, string>;
  readonly captured: Record<string, string>;
  readonly target: Record<string, string>;
  readonly renames?: WorkspaceApplyPlan["renames"];
}
/** `a.tex` changes and `guard.tex` stays; both are one unit, applied together or not at all. */
const edit: Scenario = {
  captured: { "a.tex": "base", "guard.tex": "guard" },
  target: { "a.tex": "remote", "guard.tex": "guard" },
};

/** Every path the scenario names, in one conflict group: applied together or not at all. */
const groupOf = (scenario: Scenario) => [
  {
    paths: [
      ...new Set([
        ...Object.keys(scenario.base ?? {}),
        ...Object.keys(scenario.captured),
        ...Object.keys(scenario.target),
      ]),
    ],
    types: ["content"],
    origins: ["merge" as const],
  },
];
/** The scenario's plan, for an apply in this process. */
const planOf = (scenario: Scenario): WorkspaceApplyPlan => ({
  base: new Map(Object.entries(revisions(scenario.base ?? scenario.captured))),
  remote: new Map(Object.entries(revisions(scenario.target))),
  captured: new Map(Object.entries(revisions(scenario.captured))),
  target: new Map(
    Object.entries(scenario.target).map(([name, text]) => [name, { bytes: Buffer.from(text) }]),
  ),
  renames: scenario.renames ?? [],
  conflicts: groupOf(scenario),
  markerPaths: [],
});

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
      base: revisions(scenario.base ?? scenario.captured),
      remote: revisions(scenario.target),
      captured: revisions(scenario.captured),
      target: Object.fromEntries(
        Object.entries(scenario.target).map(([name, text]) => [
          name,
          Buffer.from(text).toString("base64"),
        ]),
      ),
      renames: scenario.renames ?? [],
      conflicts: groupOf(scenario),
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
  it.live.each(["empty folder", "folder with a file", "link", "named pipe"] as const)(
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
        } else if (occupant === "named pipe") NodeChildProcess.execFileSync("mkfifo", [peer]);
        else {
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

  it.live.each(["empty folder", "folder with a file", "link", "named pipe"] as const)(
    "publishes nothing when a peer that should be a file becomes a %s",
    (occupant) =>
      fixture(async (h) => {
        await crashAt(h, "prepared", {
          captured: { "a.tex": "base", "z.tex": "guard" },
          target: { "a.tex": "remote", "z.tex": "guard" },
        });
        const peer = NodePath.join(h.cwd, "z.tex");
        await NodeFSP.unlink(peer);
        if (occupant === "link") {
          await NodeFSP.writeFile(NodePath.join(h.root, "outside"), "guard");
          await NodeFSP.symlink(NodePath.join(h.root, "outside"), peer);
        } else if (occupant === "named pipe") NodeChildProcess.execFileSync("mkfifo", [peer]);
        else {
          await NodeFSP.mkdir(peer);
          if (occupant === "folder with a file") await put(peer, { foreign: "foreign" });
        }
        await h.restart();
        await editorReads(h);
        expect(await read(h.cwd, "a.tex")).toBe("base");
      }),
  );

  it.live("publishes nothing when a file blocks the folder of a path the group adds", () =>
    fixture(async (h) => {
      await crashAt(h, "prepared", {
        captured: { "a.tex": "base" },
        target: { "a.tex": "remote", "z/new.tex": "new" },
      });
      await put(h.cwd, { z: "foreign" });
      await h.restart();
      await editorReads(h);
      expect(await read(h.cwd, "a.tex")).toBe("base");
    }),
  );

  it.live("publishes nothing when a folder the group creates appears early with other files", () =>
    fixture(async (h) => {
      await crashAt(h, "prepared", {
        base: { "a.tex": "base", z: "old" },
        captured: { "a.tex": "base" },
        target: { "a.tex": "remote", "z/deep/new.tex": "new" },
      });
      await put(h.cwd, { "z/foreign.tex": "foreign" });
      await h.restart();
      await editorReads(h);
      expect(await read(h.cwd, "a.tex")).toBe("base");
    }),
  );

  it.live.each(["notes/old.tex", "notes/deep/old.tex"])(
    "removes nothing from a folder the group empties when another file appears in it (%s)",
    (old) =>
      fixture(async (h) => {
        await crashAt(h, "prepared", {
          captured: { [old]: "old", "a.tex": "base" },
          target: { notes: "remote", "a.tex": "remote" },
        });
        await put(h.cwd, { "notes/foreign.tex": "foreign" });
        await h.restart();
        await editorReads(h);
        expect(await read(h.cwd, old)).toBe("old");
        expect(await read(h.cwd, "notes/foreign.tex")).toBe("foreign");
      }),
  );

  // The bytes are what was reviewed; a hard link elsewhere does not change them.
  it.live("accepts a peer replaced by a hard link with the same bytes", () =>
    fixture(async (h) => {
      await crashAt(h, "prepared", {
        captured: { "a.tex": "base", "z.tex": "guard" },
        target: { "a.tex": "remote", "z.tex": "guard" },
      });
      await NodeFSP.writeFile(NodePath.join(h.root, "outside"), "guard");
      await NodeFSP.unlink(NodePath.join(h.cwd, "z.tex"));
      await NodeFSP.link(NodePath.join(h.root, "outside"), NodePath.join(h.cwd, "z.tex"));
      await h.restart();
      expect(await h.apply("crash")).toMatchObject({ outcome: "complete", matchesTarget: true });
      expect(await read(h.root, "outside")).toBe("guard");
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

  // Removing a folder's last file leaves the folder until the file replacing it is written;
  // that empty folder is the plan's own, not a change.
  const emptied = (old: string): Scenario => ({
    captured: { "a.tex": "base", [old]: "old" },
    target: { "a.tex": "remote", notes: "new" },
  });
  it.live.each(["notes/old.tex", "notes/deep/old.tex"])(
    "applies a group whose folder becomes a file (%s)",
    (old) =>
      fixture(async (h) => {
        await put(h.cwd, emptied(old).captured);
        expect(await h.apply("emptied", planOf(emptied(old)))).toMatchObject({
          outcome: "complete",
          matchesTarget: true,
          interrupted: [],
        });
        expect(await read(h.cwd, "notes")).toBe("new");
      }),
  );
  it.live.each(["notes/old.tex", "notes/deep/old.tex"])(
    "recovers a group whose folder becomes a file after a crash (%s)",
    (old) =>
      fixture(async (h) => {
        await crashAt(h, "prepared", emptied(old));
        await h.restart();
        await editorReads(h);
        expect(await h.apply("crash")).toMatchObject({
          outcome: "complete",
          matchesTarget: true,
          interrupted: [],
        });
        expect(await read(h.cwd, "notes")).toBe("new");
      }),
  );

  // With every file of the unit changing, nothing else reads the folder before the
  // apply resumes; the apply settles the pending step itself.
  it.live.each(
    (["prepared", "displaced"] as const).flatMap((point) =>
      [false, true].map((editorFirst) => ({ point, editorFirst })),
    ),
  )("finishes a unit whose every file changes after a crash at $point", ({ point, editorFirst }) =>
    fixture(async (h) => {
      const both: Scenario = {
        captured: { "a.tex": "base A", "b.tex": "base B" },
        target: { "a.tex": "remote A", "b.tex": "remote B" },
      };
      await crashAt(h, point, both);
      await h.restart();
      if (editorFirst) await editorReads(h);
      expect(await h.apply("crash")).toMatchObject({
        outcome: "complete",
        matchesTarget: true,
        interrupted: [],
      });
      expect(await read(h.cwd, "b.tex")).toBe("remote B");
    }),
  );

  // The last step turns the emptied folder into a file, capturing the folder first.
  it.live.each([3, 4])(
    "finishes removing a captured folder after a crash (displaced #%s)",
    (occurrence) =>
      fixture(async (h) => {
        const folded = emptied("notes/deep/old.tex");
        await crashAt(h, "displaced", folded, occurrence);
        await h.restart();
        await editorReads(h);
        expect(await h.apply("crash")).toMatchObject({
          outcome: "complete",
          matchesTarget: true,
          interrupted: [],
        });
        expect(await read(h.cwd, "notes")).toBe("new");
      }),
  );

  // Empty folders left by earlier deletions are no one's files.
  it.live.each(["notes/empty", "notes/deep/empty"])(
    "folds a folder that also holds an empty folder (%s)",
    (empty) =>
      fixture(async (h) => {
        const folded = emptied("notes/deep/old.tex");
        await put(h.cwd, folded.captured);
        await NodeFSP.mkdir(NodePath.join(h.cwd, empty), { recursive: true });
        expect(await h.apply("folded", planOf(folded))).toMatchObject({
          outcome: "complete",
          matchesTarget: true,
          interrupted: [],
        });
        expect(await read(h.cwd, "notes")).toBe("new");
      }),
  );

  it.live("folds a folder after an earlier sync deleted a file below it", () =>
    fixture(async (h) => {
      const first: Scenario = {
        captured: {
          "a.tex": "base",
          "notes/obsolete/deleted.tex": "obsolete",
          "notes/live/old.tex": "old",
        },
        target: { "a.tex": "base", "notes/live/old.tex": "old" },
      };
      const second: Scenario = {
        captured: { "a.tex": "base", "notes/live/old.tex": "old" },
        target: { "a.tex": "remote", notes: "new" },
      };
      await put(h.cwd, first.captured);
      expect(await h.apply("first", planOf(first))).toMatchObject({ outcome: "complete" });
      expect(await h.apply("second", planOf(second))).toMatchObject({
        outcome: "complete",
        matchesTarget: true,
        interrupted: [],
      });
      expect(await read(h.cwd, "notes")).toBe("new");
    }),
  );

  // Without a crash: a peer that changes while the step is staged stops it before publishing.
  it.live("publishes nothing when a peer changes while the step is staged", () => {
    let folder = "";
    return fixture(
      async (h) => {
        folder = h.cwd;
        await put(h.cwd, edit.captured);
        const result = await h.apply("late", planOf(edit));
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
