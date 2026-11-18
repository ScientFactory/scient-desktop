import type {
  ComputeResultCause,
  ComputeResultScript,
  ComputeResultSummary,
} from "@t3tools/contracts";
import {
  findMarkdownResultReferences,
  formatResultFigureMarkdown,
  formatResultValueMarkdown,
} from "@t3tools/shared/computeResults";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { agentScope, computeFailed, type AgentScope } from "./agentComputeScope.ts";

const DEFAULT_WAIT_SECONDS = 120;

const CAUSE_LABELS: Record<ComputeResultCause["kind"], string> = {
  "script-changed": "script changed",
  "script-missing": "script missing",
  "input-changed": "input changed",
  "input-missing": "input missing",
  "input-changed-during-run": "input changed while the script ran",
};

const describeCauses = (causes: ReadonlyArray<ComputeResultCause>) =>
  causes.map((cause) => `${CAUSE_LABELS[cause.kind]}: ${cause.path}`);

const summaryForAgent = (summary: ComputeResultSummary) => ({
  revision: summary.revision,
  script: summary.scriptPath,
  finishedAt: summary.finishedAt,
  inputTracking: summary.inputTracking,
  inputs: summary.inputs,
  outOfDate: describeCauses(summary.causes),
});

const scriptForAgent = (script: ComputeResultScript) => ({
  latest: summaryForAgent(script.latest),
  revisions: script.revisions,
  values: script.values.map((value) => ({
    ...value,
    markdown: formatResultValueMarkdown(value.value, {
      revision: script.latest.revision,
      output: value.output,
      pointer: value.pointer,
    }),
  })),
  figures: script.figures,
});

const project = Effect.fn("ScientResultsTools.project")(function* (scope: AgentScope) {
  return yield* scope.gateway.project({ cwd: scope.cwd }).pipe(Effect.mapError(computeFailed));
});

export const runScientResults = Effect.fn("ScientResultsTools.run")(function* (input: {
  readonly path: string;
  readonly waitSeconds?: number | undefined;
}) {
  const scope = yield* agentScope();
  const outcome = yield* scope.gateway
    .runResultScript({ cwd: scope.cwd, scriptPath: input.path, threadId: scope.threadId })
    .pipe(
      Effect.timeoutOption(Duration.seconds(input.waitSeconds ?? DEFAULT_WAIT_SECONDS)),
      Effect.mapError(computeFailed),
    );
  if (Option.isNone(outcome))
    return {
      status: "running" as const,
      message: "Still running. Its revision appears in scient_results_list once the run finishes.",
    };
  if (outcome.value._tag === "failed")
    return { status: "failed" as const, message: outcome.value.message };
  const revision = outcome.value.summary.revision;
  const scripts = yield* scope.gateway
    .listResults(yield* project(scope))
    .pipe(Effect.mapError(computeFailed));
  const script = scripts.find((candidate) => candidate.latest.revision === revision);
  return {
    status: "published" as const,
    revision: summaryForAgent(outcome.value.summary),
    ...(script === undefined
      ? {}
      : { values: scriptForAgent(script).values, figures: script.figures }),
  };
});

export const listScientResults = Effect.fn("ScientResultsTools.list")(function* () {
  const scope = yield* agentScope();
  const scripts = yield* scope.gateway
    .listResults(yield* project(scope))
    .pipe(Effect.mapError(computeFailed));
  return { scripts: scripts.map(scriptForAgent) };
});

export const scientResultMarkdown = Effect.fn("ScientResultsTools.markdown")(function* (input: {
  readonly document: string;
  readonly revision: string;
  readonly output: string;
  readonly pointer?: string | undefined;
  readonly alt?: string | undefined;
}) {
  const scope = yield* agentScope();
  const resultsProject = yield* project(scope);
  const target = { revision: input.revision, output: input.output, pointer: input.pointer ?? null };
  if (input.pointer !== undefined) {
    const [resolution] = yield* scope.gateway
      .resolveResults(resultsProject, [target])
      .pipe(Effect.mapError(computeFailed));
    if (resolution?._tag !== "resolved" || resolution.value === null)
      return yield* computeFailed({
        message: `Revision ${input.revision} has no value ${input.pointer} in ${input.output}.`,
      });
    return { markdown: formatResultValueMarkdown(resolution.value, target) };
  }
  const src = yield* scope.gateway
    .placeResultFigure(resultsProject, {
      documentPath: input.document,
      revision: input.revision,
      output: input.output,
    })
    .pipe(Effect.mapError(computeFailed));
  const alt = input.alt ?? input.output.replace(/^.*\//u, "").replace(/\.[^.]+$/u, "");
  return { markdown: formatResultFigureMarkdown({ alt, src }, target) };
});

export const checkScientResults = Effect.fn("ScientResultsTools.check")(function* (input: {
  readonly document: string;
}) {
  const scope = yield* agentScope();
  const file = yield* scope.gateway
    .readFile({ cwd: scope.cwd, relativePath: input.document })
    .pipe(Effect.mapError(computeFailed));
  const references = findMarkdownResultReferences(file.contents);
  const resolutions = yield* scope.gateway
    .resolveResults(
      yield* project(scope),
      references.map(({ revision, output, pointer }) => ({ revision, output, pointer })),
    )
    .pipe(Effect.mapError(computeFailed));
  return {
    results: references.map((reference, index) => {
      const resolution = resolutions[index];
      const shown = reference.kind === "value" ? reference.text : reference.src;
      const line = file.contents.slice(0, reference.start).split("\n").length;
      const base = {
        line,
        kind: reference.kind,
        shown,
        revision: reference.revision,
      };
      if (resolution === undefined || resolution._tag === "unrecorded")
        return {
          ...base,
          state: "no-record" as const,
          value: null,
          newerRevision: null,
          newerValue: null,
          outOfDate: [],
        };
      const present = reference.kind === "value" ? resolution.value !== null : resolution.figure;
      const newer = resolution.newer;
      const newerDiffers =
        newer !== null &&
        (reference.kind === "figure"
          ? newer.figure
          : newer.value !== null && newer.value !== resolution.value);
      const state = !present
        ? ("missing" as const)
        : resolution.summary.causes.length > 0
          ? ("out-of-date" as const)
          : reference.kind === "value" && reference.text !== resolution.value
            ? ("edited" as const)
            : newerDiffers
              ? ("newer-run" as const)
              : ("current" as const);
      return {
        ...base,
        state,
        value: resolution.value,
        newerRevision: newer?.summary.revision ?? null,
        newerValue: newer?.value ?? null,
        outOfDate: describeCauses(resolution.summary.causes),
      };
    }),
  };
});
