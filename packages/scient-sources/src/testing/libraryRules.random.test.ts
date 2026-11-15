// @effect-diagnostics nodeBuiltinImport:off -- Runs real Library steps in temporary folders.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { describe, expect, it } from "@effect/vitest";

import { applyStep, EMPTY_MODEL, stepAllowed, type Model, type Step } from "./libraryModel.ts";
import { checkLibraryRules } from "./libraryRules.ts";
import { createScenario, PROJECT_COUNT, runStep } from "./librarySteps.ts";

/** A small seeded generator, so a failing run is repeated from its seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_WORKS = 7;

/** Every step a person could take next, grouped by kind so rare kinds come up as often as common ones. */
function possibleSteps(model: Model, counter: number): ReadonlyArray<ReadonlyArray<Step>> {
  const labels = model.works.map((work) => work.label);
  const projects = Array.from({ length: PROJECT_COUNT }, (_, index) => index);
  const note = (text: string) => [`${text} ${counter}`, null];
  const groups: Step[][] = [
    model.works.length < MAX_WORKS
      ? [true, false].map((pdf) => ({ op: "add", label: `w${model.works.length + 1}`, pdf }))
      : [],
    labels.map((work) => ({ op: "editTitle", work, title: `Edited ${work} ${counter}` })),
    labels.flatMap((work) =>
      note(`Personal note on ${work}`).map((text) => ({ op: "setNote", work, note: text })),
    ),
    labels.map((work) => ({ op: "trash", work })),
    labels.map((work) => ({ op: "restore", work })),
    labels.map((work) => ({ op: "deleteForGood", work })),
    projects.flatMap((project) =>
      labels.flatMap((work) =>
        note(`Why project ${project + 1} cites ${work}`).map((text) => ({
          op: "pin",
          project,
          work,
          note: text,
        })),
      ),
    ),
    projects.flatMap((project) => labels.map((work) => ({ op: "unpin", project, work }))),
    projects.flatMap((project) =>
      labels.flatMap((work) =>
        note(`Changed note of project ${project + 1} on ${work}`).map((text) => ({
          op: "setProjectNote",
          project,
          work,
          note: text,
        })),
      ),
    ),
    projects.map((project) => ({ op: "resolveProject", project })),
    labels.flatMap((survivor) => labels.map((loser) => ({ op: "merge", survivor, loser }))),
    labels.map((loser) => ({ op: "undoMerge", loser })),
  ];
  return groups
    .map((group) => group.filter((step) => stepAllowed(model, step)))
    .filter((group) => group.length > 0);
}

const pick = <A>(items: ReadonlyArray<A>, random: () => number): A =>
  items[Math.floor(random() * items.length)]!;

async function runSeed(seed: number, stepCount: number): Promise<void> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-library-rules-")),
  );
  try {
    await runSteps(root, seed, stepCount);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

async function runSteps(root: string, seed: number, stepCount: number): Promise<void> {
  const scenario = await createScenario(root);
  const random = mulberry32(seed);
  let model = EMPTY_MODEL;
  const history: Step[] = [];
  for (let index = 0; index < stepCount; index += 1) {
    const step = pick(pick(possibleSteps(model, index), random), random);
    history.push(step);
    const told = () =>
      `seed ${seed}, after ${history.length} steps:\n${history.map((entry) => JSON.stringify(entry)).join("\n")}`;
    let facts;
    try {
      facts = await runStep(scenario, model, step);
    } catch (error) {
      throw new Error(`${String(error)}\n${told()}`, { cause: error });
    }
    model = applyStep(model, step, facts);
    const report = await checkLibraryRules(scenario, [model], { noUnreferencedPdfs: true });
    if (report.violations.length > 0) {
      throw new Error(`${report.violations.join("\n")}\n${told()}`);
    }
    expect(report.leftoverTemporaryFiles).toBe(0);
  }
}

// A longer hunt: LIBRARY_RULES_SEEDS=300 LIBRARY_RULES_STEPS=150 vp test run <this file>
// The default is sized for CI, where a step costs about eight times what it does on a Mac.
const seedCount = Number(NodeProcess.env["LIBRARY_RULES_SEEDS"] ?? 6);
const stepCount = Number(NodeProcess.env["LIBRARY_RULES_STEPS"] ?? 40);

describe("the Library keeps its rules under random use", () => {
  const seeds = Array.from({ length: seedCount }, (_, index) => index + 1);
  it.concurrent.each(seeds)("seed %i", async (seed) => {
    await runSeed(seed, stepCount);
  });
});
