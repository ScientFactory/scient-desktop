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
import type { WorkerAction, WorkerRequest, WorkerResult } from "./libraryWorker.ts";

/**
 * Stops one step at its file changes with a real SIGKILL (or a full disk) in a child process;
 * a fresh process then checks the rules, recovers, does the step again and checks once more.
 * Default: a smoke check. Every change of every case: LIBRARY_CRASH_SWEEP=full vp test run <file>.
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
/**
 * The default run is a smoke check sized for CI, where these process-and-fsync tests run about
 * eight times slower than on a developer's Mac: four cases, two changes each, one at a time.
 */
const SAMPLE_SIZE = 2;
const SMOKE_CASES = new Set([
  "add a paper with its PDF",
  "delete for good",
  "merge two papers",
  "undo a merge",
]);
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

/** Removing, renaming or linking a real file: where a store's state changes hands. */
const PUBLISHES = new Set(["rename", "link", "unlink", "rm", "rmdir", "copyFile"]);

/**
 * The changes to stop at: every one in a full sweep; otherwise an even spread over the changes
 * just before and just after each publication, which is where a half-done state can show.
 */
function sample(points: ReadonlyArray<{ readonly call: string; readonly path: string }>) {
  const all = points.map((_, index) => index + 1);
  if (FULL || all.length <= SAMPLE_SIZE) return all;
  const around = all.filter((at) =>
    [points[at - 1], points[at - 2]].some(
      (point) => point && PUBLISHES.has(point.call) && !point.path.includes(".tmp-"),
    ),
  );
  const from = around.length >= SAMPLE_SIZE ? around : all;
  return [
    ...new Set(
      Array.from(
        { length: SAMPLE_SIZE },
        (_, index) => from[Math.round((index * (from.length - 1)) / (SAMPLE_SIZE - 1))]!,
      ),
    ),
  ];
}

const NO_HARD_LINKS: FileFaultPlan = { kind: "count", refuseLinks: true };

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
    for (const at of sample(points)) {
      plans.push({ kind: "kill", at });
      if (!FULL) continue;
      if (WRITES_CONTENTS.has(points[at - 1]!.call)) plans.push({ kind: "kill", at, torn: true });
      plans.push({ kind: "error", at, code: "ENOSPC", persist: true });
    }
    // The same step on a volume without hard links, once, with no interruption.
    plans.push(NO_HARD_LINKS);

    const failures: string[] = [];
    const run = (actions: ReadonlyArray<WorkerAction>) =>
      runWorker(base, { root: live, model: before, actions });
    const report = (told: string, when: string, result: WorkerResult | undefined) => {
      if (result?.kind === "check") {
        for (const violation of result.report.violations) {
          failures.push(`${told}, ${when}: ${violation}`);
        }
      } else if (result?.error) {
        failures.push(`${told}, ${when}: ${result.error}`);
      }
    };
    for (const plan of plans.filter((_, index) => index % PARTS === part)) {
      await restore();
      if (plan.kind === "count") {
        const told = "on a volume without hard links";
        const { results, stderr } = await run([
          { kind: "step", step: crashCase.step, fault: plan },
          { kind: "recover", fault: plan },
          { kind: "check", models: [refreshed(after)] },
        ]);
        if (!results) failures.push(`${told}: the process failed: ${stderr.trim().slice(0, 600)}`);
        report(told, "the step", results?.[0]);
        report(told, "recovery", results?.[1]);
        report(told, "afterwards", results?.[2]);
        continue;
      }
      const where = points[plan.at - 1]!;
      const what =
        plan.kind === "kill"
          ? plan.torn
            ? "killed halfway through"
            : "killed before"
          : "disk full from";
      const told = `${what} change ${plan.at} of ${points.length} (${where.call} ${NodePath.relative(live, where.path)})`;
      const interrupt = () => run([{ kind: "step", step: crashCase.step, fault: plan }]);
      if (plan.kind === "kill" && (await interrupt()).signal !== "SIGKILL") {
        failures.push(`${told}: the worker was not killed`);
        continue;
      }
      if (plan.kind !== "kill") await interrupt();
      if (plan.kind === "kill" && FULL) {
        // Recovery is itself killed halfway, and the next process starts it again.
        const counted = (await run([{ kind: "recover", fault: { kind: "count" } }])).results?.[0];
        const changes = counted?.kind === "recover" ? counted.points : 0;
        if (changes > 1) {
          await restore();
          await interrupt();
          const at = Math.ceil(changes / 2);
          const killed = await run([{ kind: "recover", fault: { kind: "kill", at } }]);
          if (killed.signal !== "SIGKILL") {
            failures.push(`${told}: recovery was not killed at its change ${at} of ${changes}`);
          }
        }
      }
      const { results, stderr } = await run([
        { kind: "check", models: [before, after] },
        { kind: "recover" },
        { kind: "check", models: [refreshed(before)] },
        { kind: "check", models: [refreshed(after)] },
        { kind: "step", step: crashCase.step },
        { kind: "recover" },
        { kind: "check", models: [refreshed(after)] },
        // Recovering once more changes nothing.
        { kind: "recover" },
        { kind: "check", models: [refreshed(after)] },
      ]);
      if (!results) {
        failures.push(`${told}: the next process failed: ${stderr.trim().slice(0, 600)}`);
        continue;
      }
      const [evidence, recovery, asBefore, asAfter, retry, again, final, third, last] = results;
      report(told, "before anything else ran", evidence);
      report(told, "recovery", recovery);
      if (
        asBefore?.kind === "check" &&
        asAfter?.kind === "check" &&
        asBefore.report.violations.length > 0 &&
        asAfter.report.violations.length > 0
      ) {
        failures.push(
          `${told}, after recovery the Library is neither as before nor as after the step. Against before: ${asBefore.report.violations.join(" ")} Against after: ${asAfter.report.violations.join(" ")}`,
        );
      }
      report(told, "doing the step again", retry);
      report(told, "recovery after the step", again);
      report(told, "after doing the step again", final);
      report(told, "a further recovery", third);
      report(told, "after a further recovery", last);
    }
    return failures;
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
}

describe("the Library keeps its rules when a write is interrupted", () => {
  const runs = CASES.filter((crashCase) => FULL || SMOKE_CASES.has(crashCase.name)).flatMap(
    (crashCase) =>
      Array.from({ length: PARTS }, (_, part) => ({
        crashCase,
        part,
        name: PARTS === 1 ? crashCase.name : `${crashCase.name}, part ${part + 1}`,
      })),
  );
  // Side by side only in a full sweep on a developer's machine; CI has few cores.
  (FULL ? it.concurrent.each(runs) : it.each(runs))("$name", async ({ crashCase, part }) => {
    expect(await sweep(crashCase, part)).toEqual([]);
  });
});
