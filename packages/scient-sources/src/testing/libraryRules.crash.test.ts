// @effect-diagnostics nodeBuiltinImport:off -- Kills real child processes mid-write in temporary folders.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { describe, expect, it } from "@effect/vitest";

import type { FileFaultPlan } from "./fileFaults.ts";
import { applyStep, EMPTY_MODEL, type Model, type Step } from "./libraryModel.ts";
import { createScenario, PROJECT_COUNT, runStep } from "./librarySteps.ts";
import type { WorkerRequest, WorkerResult } from "./libraryWorker.ts";

/**
 * Stops one step at its file changes with a real SIGKILL (or a full disk) in a child process;
 * a fresh process then checks the rules, recovers, does the step again and checks once more.
 * Default: a spread sample per case. Every change: LIBRARY_CRASH_SWEEP=full vp test run <file>.
 */
interface CrashCase {
  readonly name: string;
  readonly setup: ReadonlyArray<Step>;
  readonly step: Step;
}

const two: ReadonlyArray<Step> = [
  { op: "add", label: "w1", pdf: true },
  { op: "add", label: "w2", pdf: true },
  { op: "setNote", work: "w1", note: "Personal note on w1" },
  { op: "setNote", work: "w2", note: "Personal note on w2" },
  { op: "pin", project: 0, work: "w1", note: "Why project 1 cites w1" },
  { op: "pin", project: 1, work: "w2", note: "Why project 2 cites w2" },
  { op: "pin", project: 2, work: "w1", note: null },
  { op: "pin", project: 2, work: "w2", note: null },
];

const CASES: ReadonlyArray<CrashCase> = [
  { name: "add a paper with its PDF", setup: [], step: { op: "add", label: "w1", pdf: true } },
  { name: "add a paper without a PDF", setup: two, step: { op: "add", label: "w3", pdf: false } },
  { name: "edit a title", setup: two, step: { op: "editTitle", work: "w1", title: "A new title" } },
  {
    name: "change a personal note",
    setup: two,
    step: { op: "setNote", work: "w1", note: "Changed" },
  },
  { name: "move to the Trash", setup: two, step: { op: "trash", work: "w1" } },
  {
    name: "restore from the Trash",
    setup: [...two, { op: "trash", work: "w1" }],
    step: { op: "restore", work: "w1" },
  },
  {
    name: "delete for good",
    setup: [...two, { op: "trash", work: "w1" }],
    step: { op: "deleteForGood", work: "w1" },
  },
  {
    name: "add to a project with a note",
    setup: two,
    step: { op: "pin", project: 1, work: "w1", note: "Why project 2 cites w1" },
  },
  { name: "remove from a project", setup: two, step: { op: "unpin", project: 0, work: "w1" } },
  {
    name: "change a project note",
    setup: two,
    step: { op: "setProjectNote", project: 0, work: "w1", note: "A changed project note" },
  },
  {
    name: "refresh a project after an edit",
    setup: [...two, { op: "editTitle", work: "w1", title: "A new title" }],
    step: { op: "resolveProject", project: 2 },
  },
  { name: "merge two papers", setup: two, step: { op: "merge", survivor: "w1", loser: "w2" } },
  {
    name: "undo a merge",
    setup: [...two, { op: "merge", survivor: "w1", loser: "w2" }],
    step: { op: "undoMerge", loser: "w2" },
  },
  {
    name: "refresh a project after a merge",
    setup: [...two, { op: "merge", survivor: "w1", loser: "w2" }],
    step: { op: "resolveProject", project: 1 },
  },
];

const WORKER = NodePath.join(import.meta.dirname, "libraryWorker.ts");
const FULL = NodeProcess.env["LIBRARY_CRASH_SWEEP"] === "full";
const SAMPLE_SIZE = 5;
/** A full sweep runs in parts, so each test stays well inside the project's test time. */
const PARTS = FULL ? 12 : 1;

interface WorkerRun {
  readonly signal: NodeJS.Signals | null;
  readonly code: number | null;
  readonly results: ReadonlyArray<WorkerResult> | null;
  readonly stderr: string;
}

async function runWorker(base: string, request: WorkerRequest): Promise<WorkerRun> {
  const requestPath = NodePath.join(base, "request.json");
  await NodeFSP.writeFile(requestPath, JSON.stringify(request));
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(NodeProcess.execPath, [WORKER, requestPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      let results: ReadonlyArray<WorkerResult> | null = null;
      try {
        results = JSON.parse(stdout) as ReadonlyArray<WorkerResult>;
      } catch {
        // A killed worker prints nothing.
      }
      resolve({ signal, code, results, stderr });
    });
  });
}

const WRITES_CONTENTS = new Set(["writeFile", "handle.writeFile", "copyFile"]);

/** The model once every project was resolved and refreshed, as recovery leaves them. */
const refreshed = (model: Model): Model =>
  Array.from({ length: PROJECT_COUNT }, (_, project) => project).reduce<Model>(
    (current, project) => applyStep(current, { op: "resolveProject", project }),
    model,
  );

/** Evenly spread positions, always with the first and the last. */
function sample(count: number, size: number): ReadonlyArray<number> {
  if (FULL || count <= size) return Array.from({ length: count }, (_, index) => index + 1);
  return [
    ...new Set(
      Array.from(
        { length: size },
        (_, index) => 1 + Math.round((index * (count - 1)) / (size - 1)),
      ),
    ),
  ];
}

async function sweep(crashCase: CrashCase, part: number): Promise<ReadonlyArray<string>> {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-library-crash-")),
  );
  try {
    // The Library stays at one path: a copied project folder would count as another checkout.
    const live = NodePath.join(base, "live");
    const snapshot = NodePath.join(base, "snapshot");
    await NodeFSP.mkdir(live);
    const scenario = await createScenario(live);
    let before: Model = EMPTY_MODEL;
    for (const step of crashCase.setup) {
      before = applyStep(before, step, await runStep(scenario, before, step));
    }
    await NodeFSP.cp(live, snapshot, { recursive: true });
    const restore = async () => {
      await NodeFSP.rm(live, { recursive: true, force: true });
      await NodeFSP.cp(snapshot, live, { recursive: true });
    };

    const counted = await runWorker(base, {
      root: live,
      model: before,
      actions: [{ kind: "step", step: crashCase.step, fault: { kind: "count" } }],
    });
    const first = counted.results?.[0];
    if (first?.kind !== "step" || !first.facts) {
      return [
        `The step did not run cleanly: ${first?.kind === "step" ? first.error : counted.stderr}`,
      ];
    }
    const after = applyStep(before, crashCase.step, first.facts);
    const { points } = first;

    const plans: FileFaultPlan[] = [];
    for (const at of sample(points.length, SAMPLE_SIZE)) {
      plans.push({ kind: "kill", at });
      if (WRITES_CONTENTS.has(points[at - 1]!.call)) plans.push({ kind: "kill", at, torn: true });
      plans.push({ kind: "error", at, code: "ENOSPC", persist: true });
    }
    // The same step on a volume without hard links, once, with no interruption.
    plans.push({ kind: "count", refuseLinks: true });

    const failures: string[] = [];
    for (const plan of plans.filter((_, index) => index % PARTS === part)) {
      const told = () => {
        if (plan.kind === "count") return "on a volume without hard links";
        const where = points[plan.at - 1]!;
        const what =
          plan.kind === "kill"
            ? plan.torn
              ? "killed halfway through"
              : "killed before"
            : "disk full from";
        return `${what} change ${plan.at} of ${points.length} (${where.call} ${NodePath.relative(live, where.path)})`;
      };
      await restore();
      const interrupted = await runWorker(base, {
        root: live,
        model: before,
        actions: [{ kind: "step", step: crashCase.step, fault: plan }],
      });
      if (plan.kind === "kill" && interrupted.signal !== "SIGKILL") {
        failures.push(`${told()}: the worker was not killed (${interrupted.stderr.trim()})`);
        continue;
      }
      const settled = await runWorker(base, {
        root: live,
        model: before,
        actions: [
          { kind: "check", models: [before, after] },
          { kind: "recover" },
          { kind: "check", models: [refreshed(before)] },
          { kind: "check", models: [refreshed(after)] },
          { kind: "step", step: crashCase.step },
          { kind: "recover" },
          { kind: "check", models: [refreshed(after)] },
        ],
      });
      if (!settled.results) {
        failures.push(`${told()}: the next process failed: ${settled.stderr.trim().slice(0, 600)}`);
        continue;
      }
      const [evidence, recovery, asBefore, asAfter, retry, , final] = settled.results;
      if (evidence?.kind === "check") {
        for (const violation of evidence.report.violations) {
          failures.push(`${told()}, before anything else ran: ${violation}`);
        }
      }
      if (recovery?.kind === "recover" && recovery.error) {
        failures.push(`${told()}: recovery failed: ${recovery.error}`);
      }
      if (
        asBefore?.kind === "check" &&
        asAfter?.kind === "check" &&
        asBefore.report.violations.length > 0 &&
        asAfter.report.violations.length > 0
      ) {
        failures.push(
          `${told()}, after recovery the Library is neither as before nor as after the step. Against before: ${asBefore.report.violations.join(" ")} Against after: ${asAfter.report.violations.join(" ")}`,
        );
      }
      if (retry?.kind === "step" && retry.error) {
        failures.push(`${told()}: doing the step again failed: ${retry.error}`);
      }
      if (final?.kind === "check") {
        for (const violation of final.report.violations) {
          failures.push(`${told()}, after doing the step again: ${violation}`);
        }
      }
    }
    return failures;
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
}

describe("the Library keeps its rules when a write is interrupted", () => {
  const runs = CASES.flatMap((crashCase) =>
    Array.from({ length: PARTS }, (_, part) => ({
      crashCase,
      part,
      name: PARTS === 1 ? crashCase.name : `${crashCase.name}, part ${part + 1}`,
    })),
  );
  it.concurrent.each(runs)("$name", async ({ crashCase, part }) => {
    expect(await sweep(crashCase, part)).toEqual([]);
  });
});
