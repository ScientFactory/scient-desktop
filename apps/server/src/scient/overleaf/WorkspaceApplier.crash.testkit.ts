// @effect-diagnostics nodeBuiltinImport:off
/**
 * Recovery after real process death. A child process runs the apply and kills
 * itself at a native publication hook; the test then resumes the same durable
 * apply. A thrown hook cannot stand in for this: it runs the file layer's
 * failure handler, which a crash never does.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  filePublicationTestHelper,
  filePublicationProbeHelper,
} from "../workspace/fileExchange.testkit.ts";
import { bytesRevision, type MutationPoint } from "../workspace/RetainedFileMutation.ts";
import type { CrashJob } from "./WorkspaceApplier.crash-child.ts";
import type { WorkspaceApplyPlan } from "./WorkspaceApplier.ts";
import { fixture } from "./WorkspaceApplier.testkit.ts";

const child = NodePath.join(import.meta.dirname, "WorkspaceApplier.crash-child.ts");
// Every case starts a child that loads the same modules; Node's compile cache, keyed by their
// content, spares each child after the first most of that load.
const compileCache = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-crash-compile-"));
afterAll(() => NodeFSP.rm(compileCache, { recursive: true, force: true }));
export const revisions = (files: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name, bytesRevision(Buffer.from(text))]),
  );
export const read = (cwd: string, name: string) =>
  NodeFSP.readFile(NodePath.join(cwd, name), "utf8").catch(() => null);
export async function put(cwd: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(cwd, name)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(cwd, name), text);
  }
}

export interface Scenario {
  /** The last synchronized files, when they differ from what the folder held. */
  readonly base?: Record<string, string>;
  readonly captured: Record<string, string>;
  readonly target: Record<string, string>;
  readonly renames?: WorkspaceApplyPlan["renames"];
}
/** `a.tex` changes and `guard.tex` stays; both are one unit, applied together or not at all. */
export const edit: Scenario = {
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
// Removing a folder's last file leaves the folder until the file replacing it is written;
// that empty folder is the plan's own, not a change.
export const emptied = (old: string): Scenario => ({
  captured: { "a.tex": "base", [old]: "old" },
  target: { "a.tex": "remote", notes: "new" },
});

export const planOf = (scenario: Scenario): WorkspaceApplyPlan => ({
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
export async function crashAt(
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
    ...(HostProcess.Platform.defaultValue() === "win32"
      ? { terminationHelper: (await filePublicationProbeHelper())! }
      : {}),
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
    env: { ...process.env, NODE_COMPILE_CACHE: compileCache },
  });
  if (HostProcess.Platform.defaultValue() === "win32") expect(run.status, run.stderr).toBe(73);
  else expect(run.signal, run.stderr).toBe("SIGKILL");
}
export type Harness = Parameters<Parameters<typeof fixture>[0]>[0];
/** A settled read of the whole folder, as an editor makes, which settles every pending record. */
export const editorReads = (h: Harness) =>
  h.run(h.files.withSettledWorkspaceRead({ cwd: h.cwd }, () => Effect.void));

// Crash probes must distinguish unpublished steps from confirmed publication. A create killed
// after its macOS clone call lacks durable ownership proof and stays for review. Windows' moved
// stage and Linux's staged create journal their public file ID, so ID plus bytes prove completion.
const stepShapes = [
  {
    name: "an edit",
    occurrence: 1,
    captured: { "a.tex": "base", "guard.tex": "guard" },
    target: { "a.tex": "remote", "guard.tex": "guard" },
  },
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
    // Its third step removes the emptied folder, then writes the file in its place.
    name: "a folder removed for a file",
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

/** Every step shape killed at one publication point, with and without a later guard edit. */
export const stepShapeCases = (point: "prepared" | "checked" | "called") =>
  stepShapes.flatMap((shape) => [false, true].map((changed) => ({ ...shape, point, changed })));

export const recoversStepShape = (shape: ReturnType<typeof stepShapeCases>[number]) =>
  fixture(async (h) => {
    await crashAt(h, shape.point, shape, shape.occurrence);
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
    if (shape.occurrence === 1 && shape.point !== "called") {
      expect(result.interrupted).toEqual([]);
      for (const [name, text] of Object.entries(shape.captured))
        if (name !== "guard.tex") expect(await read(h.cwd, name)).toBe(text);
    } else expect(result.interrupted).toHaveLength(1);
  });
