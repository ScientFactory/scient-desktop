// @effect-diagnostics nodeBuiltinImport:off
/**
 * Recovery after real process death. A child process runs the apply and kills
 * itself at a native publication hook; this process then resumes the same
 * durable apply. A thrown hook cannot stand in for this: it runs the file
 * layer's failure handler, which a crash never does.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
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
  killIn?: CrashJob["killIn"],
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
    ...(killIn ? { killIn } : {}),
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
  if (HostProcess.Platform.defaultValue() === "win32") expect(run.status, run.stderr).not.toBe(0);
  else expect(run.signal, run.stderr).toBe("SIGKILL");
}
type Harness = Parameters<Parameters<typeof fixture>[0]>[0];
/** A settled read of the whole folder, as an editor makes, which settles every pending record. */
const editorReads = (h: Harness) =>
  h.run(h.files.withSettledWorkspaceRead({ cwd: h.cwd }, () => Effect.void));

describe.skipIf(!canPublish)("WorkspaceApplier after real process death", () => {
  it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "recovers an unpublished destination stage after real process death",
    () =>
      fixture(async (h) => {
        const added: Scenario = {
          captured: { "guard.tex": "guard" },
          target: { "a.tex": "new", "guard.tex": "guard" },
        };
        await crashAt(h, "create-staged", added);
        expect(await read(h.cwd, "a.tex")).toBeNull();
        await h.restart();
        expect(await h.apply("crash")).toMatchObject({ outcome: "complete", matchesTarget: true });
        expect(await read(h.cwd, "a.tex")).toBe("new");
        expect(
          (await NodeFSP.readdir(h.cwd)).filter((name) =>
            name.startsWith(".scient-overleaf-apply-"),
          ),
        ).toEqual([]);
      }),
  );

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
  it.live.each(
    HostProcess.Platform.defaultValue() === "win32"
      ? (["empty folder", "folder with a file", "link"] as const)
      : (["empty folder", "folder with a file", "link", "named pipe"] as const),
  )("publishes nothing when a peer that should be absent becomes a %s", (occupant) =>
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

  it.live.each(
    HostProcess.Platform.defaultValue() === "win32"
      ? (["empty folder", "folder with a file", "link"] as const)
      : (["empty folder", "folder with a file", "link", "named pipe"] as const),
  )("publishes nothing when a peer that should be a file becomes a %s", (occupant) =>
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

  // Settling a step killed before staging closes it without its bytes; the apply
  // tries it again from its plan. One killed just before or after its native call
  // goes on from what the call left.
  it.live.each(["intent", "prepared", "checked", "called", "displaced"] as const)(
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

  // Crash probes must distinguish unpublished steps from confirmed publication. A create killed
  // after its native call lacks durable ownership proof and stays for review because another writer
  // could own the visible file.
  const shapes = [
    {
      name: "an edit",
      occurrence: 1,
      captured: { "a.tex": "base", "guard.tex": "guard" },
      target: { "a.tex": "remote", "guard.tex": "guard" },
    },
    {
      name: "a rename's destination",
      create: true,
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
      create: true,
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
      create: true,
      occurrence: 4,
      captured: { "notes/a.tex": "base", "notes/b.tex": "B", "guard.tex": "guard" },
      target: { notes: "remote", "guard.tex": "guard" },
    },
    {
      name: "a folder's removal",
      occurrence: 3,
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
  it.live.each(
    (["prepared", "checked", "called"] as const).flatMap((point) =>
      shapes.flatMap((shape) => [false, true].map((changed) => ({ ...shape, point, changed }))),
    ),
  )("recovers $name killed at $point, guard changed: $changed", (shape) =>
    fixture(async (h) => {
      await crashAt(h, shape.point, shape, shape.occurrence);
      if (shape.changed) await NodeFSP.writeFile(NodePath.join(h.cwd, "guard.tex"), "later");
      await h.restart();
      await editorReads(h);
      const result = await h.apply("crash");
      if (
        shape.point === "called" &&
        "create" in shape &&
        HostProcess.Platform.defaultValue() !== "linux"
      ) {
        expect(result.outcome).toBe("attention");
        expect(result.interrupted).toHaveLength(1);
        return;
      }
      if (!shape.changed) {
        expect(result).toMatchObject({ outcome: "complete", matchesTarget: true });
        for (const [name, text] of Object.entries(shape.target))
          expect(await read(h.cwd, name)).toBe(text);
        return;
      }
      expect(await read(h.cwd, "guard.tex")).toBe("later");
      expect(Object.fromEntries(result.base)).toEqual(revisions(shape.captured));
      if (shape.occurrence === 1 && shape.point !== "called") {
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
  const both: Scenario = {
    captured: { "a.tex": "base A", "b.tex": "base B" },
    target: { "a.tex": "remote A", "b.tex": "remote B" },
  };
  it.live.each(
    (["intent", "prepared", "checked", "called", "displaced"] as const).flatMap((point) =>
      [1, 2].flatMap((occurrence) =>
        [false, true].map((editorFirst) => ({ point, occurrence, editorFirst })),
      ),
    ),
  )(
    "finishes a unit whose every file changes after a crash at $point #$occurrence, editor first: $editorFirst",
    ({ point, occurrence, editorFirst }) =>
      fixture(async (h) => {
        await crashAt(h, point, both, occurrence);
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

  // Between hooks, while a step's copy is being staged: nothing was published, so the
  // partial copy is discarded and the step is tried again.
  it.live.each([0, 1])("finishes a unit after a crash while staging step %s", (step) =>
    fixture(async (h) => {
      await crashAt(h, "done", both, 99, { operation: "open", suffix: `/step-${step}/slot` });
      await h.restart();
      expect(await h.apply("crash")).toMatchObject({
        outcome: "complete",
        matchesTarget: true,
        interrupted: [],
      });
      expect(await read(h.cwd, "a.tex")).toBe("remote A");
      expect(await read(h.cwd, "b.tex")).toBe("remote B");
    }),
  );

  // Between the file layer's intent index and a step's first journal, recovery cannot
  // prove what happened (the file's folders may already have been made), so the file
  // stays for explicit review, as the native layer decides. Nothing is lost.
  it.live.each([0, 1])("holds a file for review after a crash before step %s's journal", (step) =>
    fixture(async (h) => {
      await crashAt(h, "done", both, 99, {
        operation: "rename",
        suffix: `/step-${step}/record.json`,
      });
      await h.restart();
      const refused = await h.apply("crash").then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toMatchObject({
        _tag: "WorkspaceApplyError",
        cause: {
          _tag: "WorkspaceFileRecoveryRequiredError",
          relativePath: step === 0 ? "a.tex" : "b.tex",
          publicationOutcome: "retained-attention",
        },
      });
      expect(await read(h.cwd, "a.tex")).toBe(step === 0 ? "base A" : "remote A");
      expect(await read(h.cwd, "b.tex")).toBe("base B");
    }),
  );

  // The later step is tried again, and still refuses a file changed since the review.
  it.live("tries a later step again after a crash at intent, refusing a changed file", () =>
    fixture(async (h) => {
      await crashAt(h, "intent", both, 2);
      await NodeFSP.writeFile(NodePath.join(h.cwd, "b.tex"), "later");
      await h.restart();
      const result = await h.apply("crash");
      expect(result.interrupted).toHaveLength(1);
      expect(await read(h.cwd, "a.tex")).toBe("remote A");
      expect(await read(h.cwd, "b.tex")).toBe("later");
    }),
  );

  // An empty folder giving way to a file is removed under the group's checks too.
  const folded: Scenario = {
    captured: { "guard.tex": "guard" },
    target: { notes: "new", "guard.tex": "guard" },
  };
  it.live.each(["checked", "called"] as const)(
    "keeps a group whose file changed after a crash at the folder removal's %s",
    (point) =>
      fixture(async (h) => {
        await NodeFSP.mkdir(NodePath.join(h.cwd, "notes"));
        await crashAt(h, point, folded);
        await NodeFSP.writeFile(NodePath.join(h.cwd, "guard.tex"), "later");
        await h.restart();
        await editorReads(h);
        const result = await h.apply("crash");
        expect(await read(h.cwd, "guard.tex")).toBe("later");
        expect(await read(h.cwd, "notes")).toBeNull();
        if (point === "checked") {
          // Nothing was removed: the folder stays and the group is not reported.
          expect((await NodeFSP.lstat(NodePath.join(h.cwd, "notes"))).isDirectory()).toBe(true);
          expect(result.interrupted).toEqual([]);
        } else {
          // The folder was already removed: the group is reported.
          expect(result.interrupted).toHaveLength(1);
        }
      }),
  );

  // A create leaves no trace in its record, only in the folder it adds to; a folder
  // changed since leaves the call's fate unknown, and the step is kept for review.
  const added: Scenario = {
    captured: { "guard.tex": "guard" },
    target: { "a.tex": "new", "guard.tex": "guard" },
  };
  it.live("classifies an interrupted create from its platform ownership evidence", () =>
    fixture(async (h) => {
      await crashAt(h, "checked", added);
      await put(h.cwd, { "other.tex": "other" });
      await h.restart();
      const result = await h.apply("crash");
      if (HostProcess.Platform.defaultValue() === "linux") {
        expect(result).toMatchObject({ outcome: "complete", matchesTarget: true });
        expect(await read(h.cwd, "a.tex")).toBe("new");
      } else {
        expect(result.interrupted).toHaveLength(1);
        expect(await read(h.cwd, "a.tex")).toBeNull();
      }
    }),
  );
  it.live("does not add a file again once removed after a crash just after adding it", () =>
    fixture(async (h) => {
      await crashAt(h, "called", added);
      expect(await read(h.cwd, "a.tex")).toBe("new");
      await NodeFSP.unlink(NodePath.join(h.cwd, "a.tex"));
      await h.restart();
      const result = await h.apply("crash");
      expect(result.interrupted).toHaveLength(1);
      expect(await read(h.cwd, "a.tex")).toBeNull();
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
