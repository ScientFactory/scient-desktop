// @effect-diagnostics nodeBuiltinImport:off -- Test support: a child process that runs Library steps and can be killed mid-write.
/**
 * Runs the actions of a request file against a scenario folder and prints one JSON line:
 *   node libraryWorker.ts <request.json>
 * A step with a `kill` fault ends this process with SIGKILL at the chosen file change, so the
 * parent sees a real process death and a fresh process carries on from what is on disk.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeProcess from "node:process";

import { startFileFaults, stopFileFaults, type FileFaultPlan } from "./fileFaults.ts";
import { applyStep, type Model, type Step, type StepFacts } from "./libraryModel.ts";
import { checkLibraryRules, type RuleReport } from "./libraryRules.ts";
import { recoverScenario, runStep, scenarioAt } from "./librarySteps.ts";

export type WorkerAction =
  /** Runs a step from `model`, the state the step may assume. A failed step is reported, not fatal. */
  | { readonly kind: "step"; readonly step: Step; readonly fault?: FileFaultPlan }
  | { readonly kind: "check"; readonly models: ReadonlyArray<Model> }
  /** What a restarted server does before a person acts (`recoverScenario`). */
  | { readonly kind: "recover" };

export interface WorkerRequest {
  readonly root: string;
  /** What the Library held before the first action; steps move it forward. */
  readonly model: Model;
  readonly actions: ReadonlyArray<WorkerAction>;
}

export type WorkerResult =
  | {
      readonly kind: "step";
      readonly facts: StepFacts | null;
      readonly error: string | null;
      readonly points: ReadonlyArray<{ readonly call: string; readonly path: string }>;
    }
  | { readonly kind: "check"; readonly report: RuleReport }
  | { readonly kind: "recover"; readonly error: string | null };

async function main(): Promise<void> {
  const requestPath = NodeProcess.argv[2];
  if (!requestPath) throw new Error("Usage: node libraryWorker.ts <request.json>");
  const request = JSON.parse(await NodeFSP.readFile(requestPath, "utf8")) as WorkerRequest;
  const scenario = scenarioAt(request.root);
  let model = request.model;
  const results: WorkerResult[] = [];
  for (const action of request.actions) {
    if (action.kind === "check") {
      results.push({ kind: "check", report: await checkLibraryRules(scenario, action.models) });
      continue;
    }
    if (action.kind === "recover") {
      const error = await recoverScenario(scenario).then(
        () => null,
        (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
      );
      results.push({ kind: "recover", error });
      continue;
    }
    let facts: StepFacts | null = null;
    let error: string | null = null;
    if (action.fault) startFileFaults(action.fault);
    try {
      facts = await runStep(scenario, model, action.step);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const points = action.fault ? stopFileFaults() : [];
    if (facts) model = applyStep(model, action.step, facts);
    results.push({ kind: "step", facts, error, points });
  }
  NodeProcess.stdout.write(`${JSON.stringify(results)}\n`);
}

await main();
