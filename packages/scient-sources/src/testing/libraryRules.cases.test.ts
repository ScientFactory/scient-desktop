// @effect-diagnostics nodeBuiltinImport:off -- Runs real Library steps in temporary folders.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { applyStep, EMPTY_MODEL, type Step } from "./libraryModel.ts";
import { checkLibraryRules } from "./libraryRules.ts";
import { createScenario, runStep } from "./librarySteps.ts";

/** Runs the steps in a fresh Library and returns the rule violations after the last one. */
async function violationsAfter(steps: ReadonlyArray<Step>): Promise<ReadonlyArray<string>> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-library-case-")),
  );
  try {
    const scenario = await createScenario(root);
    let model = EMPTY_MODEL;
    for (const step of steps) model = applyStep(model, step, await runStep(scenario, model, step));
    return (await checkLibraryRules(scenario, [model])).violations;
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
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
  // The saved copy still described the survivor, and resolution matched the key to it.
  it("a key does not start citing the paper its own was unmerged from", async () => {
    expect(await violationsAfter(mergedThenUndone)).toEqual([]);
  });

  it("the saved copy of a removed paper describes that paper again after a refresh", async () => {
    expect(
      await violationsAfter([...mergedThenUndone, { op: "resolveProject", project: 0 }]),
    ).toEqual([]);
  });

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
