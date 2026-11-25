// @effect-diagnostics nodeBuiltinImport:off -- Runs real Library steps in temporary folders.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { applyStep, EMPTY_MODEL, type Model, type Step } from "./libraryModel.ts";
import { checkLibraryRules } from "./libraryRules.ts";
import { createScenario, runStep } from "./librarySteps.ts";

/** Runs `body` against a fresh Library in its own temporary folder. */
async function inLibrary<A>(
  body: (scenario: Awaited<ReturnType<typeof createScenario>>, root: string) => Promise<A>,
): Promise<A> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-library-case-")),
  );
  try {
    return await body(await createScenario(root), root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

async function runSteps(
  scenario: Awaited<ReturnType<typeof createScenario>>,
  start: Model,
  steps: ReadonlyArray<Step>,
): Promise<Model> {
  let model = start;
  for (const step of steps) model = applyStep(model, step, await runStep(scenario, model, step));
  return model;
}

/** Runs the steps in a fresh Library and returns the rule violations after the last one. */
const violationsAfter = (steps: ReadonlyArray<Step>): Promise<ReadonlyArray<string>> =>
  inLibrary(async (scenario) => {
    const model = await runSteps(scenario, EMPTY_MODEL, steps);
    return (await checkLibraryRules(scenario, [model])).violations;
  });

async function folderBytes(root: string): Promise<ReadonlyArray<readonly [string, string]>> {
  const entries = await NodeFSP.readdir(root, { recursive: true, withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = NodePath.join(entry.parentPath, entry.name);
        return [NodePath.relative(root, path), await NodeFSP.readFile(path, "base64")] as const;
      }),
  );
  return files.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

const mergedThenUndone: ReadonlyArray<Step> = [
  { op: "add", label: "w1", pdf: false },
  { op: "add", label: "w3", pdf: false },
  { op: "pin", project: 0, work: "w1", note: null },
  { op: "merge", survivor: "w3", loser: "w1" },
  // The project's saved copy now describes the survivor.
  { op: "resolveProject", project: 0 },
  { op: "undoMerge", loser: "w1" },
  { op: "trash", work: "w1" },
];

describe("sequences the random driver found", () => {
  // The saved copy still described the survivor, and resolution matched the key to it; after a
  // refresh it must describe the removed paper again.
  it("a key does not start citing the paper its own was unmerged from, before or after a refresh", () =>
    inLibrary(async (scenario, root) => {
      const model = await runSteps(scenario, EMPTY_MODEL, mergedThenUndone);
      const before = await folderBytes(root);
      expect(
        (await checkLibraryRules(scenario, [model])).violations,
        "a key does not start citing the paper its own was unmerged from",
      ).toEqual([]);
      // The check only reads, so the refresh below continues the same Library.
      expect(await folderBytes(root)).toEqual(before);
      const refreshed = await runSteps(scenario, model, [{ op: "resolveProject", project: 0 }]);
      expect(
        (await checkLibraryRules(scenario, [refreshed])).violations,
        "the saved copy of a removed paper describes that paper again after a refresh",
      ).toEqual([]);
    }));

  // The copy then disagrees with the survivor too; that must not hide that its own paper is gone.
  it("the same holds when the other paper was retitled meanwhile", async () => {
    expect(
      await violationsAfter([
        ...mergedThenUndone.slice(0, -1),
        { op: "editTitle", work: "w3", title: "A later title of the other paper" },
        { op: "trash", work: "w1" },
        { op: "resolveProject", project: 0 },
      ]),
    ).toEqual([]);
  });

  it("the same holds once the paper is deleted for good", async () => {
    expect(
      await violationsAfter([
        ...mergedThenUndone,
        { op: "deleteForGood", work: "w1" },
        { op: "resolveProject", project: 0 },
      ]),
    ).toEqual([]);
  });
});
