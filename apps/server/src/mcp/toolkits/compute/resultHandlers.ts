import type {
  ComputeResultCause,
  ComputeResultsRerunInput,
  ComputeResultsCompareInput,
  ComputeResultScript,
  ComputeResultSummary,
} from "@t3tools/contracts";
import {
  formatResultFigureMarkdown,
  formatResultTableCaption,
  formatResultValueMarkdown,
  isResultTableOutput,
  resultInputCoverageIncomplete,
  type ResultReferenceState,
} from "@t3tools/shared/computeResults";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

import { agentScope, computeFailed } from "./agentComputeScope.ts";

const DEFAULT_WAIT_SECONDS = 120;

const CAUSE_LABELS: Record<ComputeResultCause["kind"], string> = {
  "script-changed": "script changed",
  "script-missing": "script missing",
  "input-changed": "input changed",
  "input-missing": "input missing",
  "input-changed-during-run": "input changed while the script ran",
  "lockfile-changed": "environment may differ",
};

/** The editor's states, in words an agent reads without the app. */
const STATE_FOR_AGENT: Record<ResultReferenceState, string> = {
  current: "current",
  incomplete: "freshness-partly-unknown",
  newer: "newer-run",
  stale: "out-of-date",
  edited: "edited",
  missing: "missing",
  unrecorded: "no-record",
};

const describeCauses = (causes: ReadonlyArray<ComputeResultCause>) =>
  causes
    .filter((cause) => cause.kind !== "lockfile-changed")
    .map((cause) => `${CAUSE_LABELS[cause.kind]}: ${cause.path}`);

const environmentMayDiffer = (causes: ReadonlyArray<ComputeResultCause>) =>
  causes.filter(({ kind }) => kind === "lockfile-changed").map(({ path }) => path);

const summaryForAgent = (summary: ComputeResultSummary) => ({
  revision: summary.revision,
  script: summary.scriptPath,
  finishedAt: summary.finishedAt,
  inputTracking: summary.inputTracking,
  inputs: summary.inputs,
  observedDirectories: summary.observedDirectories,
  readsOutsideProject: summary.readsOutsideProject,
  outsideDataPaths: summary.outsideDataPaths,
  declaredInputs: summary.declaredInputs ?? [],
  parameters: summary.parameters ?? [],
  inputCoverageIncomplete: resultInputCoverageIncomplete(summary),
  kind: summary.kind ?? ("script" as const),
  outOfDate: describeCauses(summary.causes),
  environmentMayDiffer: environmentMayDiffer(summary.causes),
});

const scriptForAgent = (script: ComputeResultScript) => ({
  latest: summaryForAgent(script.latest),
  revisions: script.revisions,
  lastAttempt: script.lastAttempt ?? null,
  values: script.values.map((value) => ({
    ...value,
    markdown: formatResultValueMarkdown(value.value, {
      revision: script.latest.revision,
      output: value.output,
      pointer: value.pointer,
    }),
  })),
  figures: script.figures,
  tables: script.tables ?? [],
});

export const runScientResults = Effect.fn("ScientResultsTools.run")(function* (input: {
  readonly path: string;
  readonly parameters?: Readonly<Record<string, Schema.Json>> | undefined;
  readonly inputs?: ComputeResultsRerunInput["inputs"];
  readonly waitSeconds?: number | undefined;
}) {
  const scope = yield* agentScope();
  const outcome = yield* scope.gateway
    .rerunResults({
      cwd: scope.cwd,
      scriptPath: input.path,
      threadId: scope.threadId,
      parameters:
        input.parameters === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(input.parameters).map(([name, value]) => [
                name,
                JSON.stringify(value),
              ]),
            ),
      inputs: input.inputs,
    })
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
  const { scripts } = yield* scope.gateway
    .listResults({ cwd: scope.cwd })
    .pipe(Effect.mapError(computeFailed));
  const script = scripts.find((candidate) => candidate.latest.revision === revision);
  return {
    status: "published" as const,
    revision: summaryForAgent(outcome.value.summary),
    ...(script === undefined
      ? {}
      : {
          values: scriptForAgent(script).values,
          figures: script.figures,
          tables: script.tables ?? [],
        }),
  };
});

export const listScientResults = Effect.fn("ScientResultsTools.list")(function* (input: {
  readonly path?: string | undefined;
  readonly revision?: string | undefined;
  readonly output?: string | undefined;
  readonly includePackages?: boolean | undefined;
}) {
  const scope = yield* agentScope();
  if (input.revision !== undefined || input.output !== undefined) {
    if (input.revision === undefined || input.output === undefined)
      return yield* computeFailed({ message: "Provide both a revision and its output name." });
    return {
      scripts: [],
      outputContent: yield* scope.gateway
        .resultOutputContent({
          cwd: scope.cwd,
          revision: input.revision,
          output: input.output,
        })
        .pipe(Effect.mapError(computeFailed)),
    };
  }
  const { scripts } = yield* scope.gateway
    .listResults({ cwd: scope.cwd })
    .pipe(Effect.mapError(computeFailed));
  if (input.path === undefined) return { scripts: scripts.map(scriptForAgent) };
  const script = scripts.find(({ latest }) => latest.scriptPath === input.path);
  const {
    history: { latest, revisions },
    setup,
  } = yield* Effect.all(
    {
      history: scope.gateway.resultHistory({
        cwd: scope.cwd,
        scriptPath: input.path,
        includeLatest: true,
      }),
      setup: scope.gateway.resultSetup({ cwd: scope.cwd, scriptPath: input.path }),
    },
    { concurrency: "unbounded" },
  ).pipe(Effect.mapError(computeFailed));
  const { packages, ...environment } = latest?.environment ?? {
    lockfiles: [],
    packages: undefined,
  };
  const latestRecord =
    latest?.environment !== undefined && input.includePackages !== true
      ? { ...latest, environment }
      : latest;
  return {
    scripts: script === undefined ? [] : [scriptForAgent(script)],
    history: revisions,
    suggestedInputs: setup.suggestedInputs,
    ...(latestRecord === undefined ? {} : { latestRecord }),
    ...(packages === undefined ? {} : { packageCount: packages.length }),
  };
});

export const compareScientResults = Effect.fn("ScientResultsTools.compare")(function* (
  input: Omit<ComputeResultsCompareInput, "cwd">,
) {
  const scope = yield* agentScope();
  return yield* scope.gateway
    .compareResults({ cwd: scope.cwd, ...input })
    .pipe(Effect.mapError(computeFailed));
});

export const scientResultMarkdown = Effect.fn("ScientResultsTools.markdown")(function* (input: {
  readonly document: string;
  readonly revision: string;
  readonly output: string;
  readonly pointer?: string | undefined;
  readonly alt?: string | undefined;
}) {
  const scope = yield* agentScope();
  const target = { revision: input.revision, output: input.output, pointer: input.pointer ?? null };
  if (/\.tex$/iu.test(input.document)) {
    const placed = yield* scope.gateway
      .placeLatexResult({ cwd: scope.cwd, documentPath: input.document, ...target })
      .pipe(Effect.mapError(computeFailed));
    return {
      markdown: placed.insert.source,
      preamble: [
        ...placed.packages.map((name) => `\\usepackage{${name}}`),
        ...(placed.preambleInput === null ? [] : [placed.preambleInput]),
      ],
    };
  }
  if (input.pointer === undefined && isResultTableOutput(input.output)) {
    const { resolutions } = yield* scope.gateway
      .resolveResults({ cwd: scope.cwd, references: [target] })
      .pipe(Effect.mapError(computeFailed));
    const resolution = resolutions[0];
    const rows = resolution?._tag === "resolved" ? resolution.table : null;
    if (rows == null || rows.length === 0)
      return yield* computeFailed({
        message: `Revision ${input.revision} has no table ${input.output} Scient can show.`,
      });
    const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
    const line = (row: ReadonlyArray<string>) => `| ${row.map(cell).join(" | ")} |`;
    const caption = input.alt ?? input.output.replace(/^.*\//u, "").replace(/\.[^.]+$/u, "");
    return {
      markdown: [
        line(rows[0]!),
        `|${rows[0]!.map(() => " --- ").join("|")}|`,
        ...rows.slice(1).map(line),
        "",
        formatResultTableCaption(caption, target),
      ].join("\n"),
    };
  }
  if (input.pointer !== undefined) {
    const { resolutions } = yield* scope.gateway
      .resolveResults({ cwd: scope.cwd, references: [target] })
      .pipe(Effect.mapError(computeFailed));
    const resolution = resolutions[0];
    if (resolution?._tag !== "resolved" || resolution.value === null)
      return yield* computeFailed({
        message: `Revision ${input.revision} has no value ${input.pointer} in ${input.output}.`,
      });
    return { markdown: formatResultValueMarkdown(resolution.value, target) };
  }
  const { src } = yield* scope.gateway
    .placeResultFigure({
      cwd: scope.cwd,
      documentPath: input.document,
      revision: input.revision,
      output: input.output,
    })
    .pipe(Effect.mapError(computeFailed));
  const alt = input.alt ?? input.output.replace(/^.*\//u, "").replace(/\.[^.]+$/u, "");
  return { markdown: formatResultFigureMarkdown({ alt, src }, target) };
});

const FILE_STATE_FOR_AGENT = {
  current: "current",
  incomplete: "freshness-partly-unknown",
  "out-of-date": "out-of-date",
  edited: "edited",
  missing: "missing",
} as const;

export const checkScientResults = Effect.fn("ScientResultsTools.check")(function* (input: {
  readonly document: string;
}) {
  const scope = yield* agentScope();
  if (/\.tex$/iu.test(input.document)) {
    const { scripts } = yield* scope.gateway
      .latexResultFiles({ cwd: scope.cwd, documentPath: input.document, build: null })
      .pipe(Effect.mapError(computeFailed));
    return {
      results: scripts.flatMap((script) =>
        script.files.map((file) => ({
          line: 0,
          kind: "file" as const,
          shown: file.path,
          state:
            file.state === "current" && script.newer !== null
              ? STATE_FOR_AGENT.newer
              : FILE_STATE_FOR_AGENT[file.state],
          revision: script.summary.revision,
          value: null,
          newerRevision: script.newer?.revision ?? null,
          newerValue: null,
          outOfDate: describeCauses(script.summary.causes),
          environmentMayDiffer: environmentMayDiffer(script.summary.causes),
        })),
      ),
    };
  }
  const checked = yield* scope.gateway
    .checkResults({ cwd: scope.cwd, documentPath: input.document })
    .pipe(Effect.mapError(computeFailed));
  return {
    results: checked.map(({ reference, line, resolution, state }) => {
      const resolved = resolution?._tag === "resolved" ? resolution : null;
      return {
        line,
        kind: reference.kind,
        shown:
          reference.kind === "value"
            ? reference.text
            : reference.kind === "table"
              ? reference.caption
              : reference.src,
        state: STATE_FOR_AGENT[state],
        revision: reference.revision,
        value: resolved?.value ?? null,
        newerRevision: resolved?.newer?.summary.revision ?? null,
        newerValue: resolved?.newer?.value ?? null,
        outOfDate: describeCauses(resolved?.summary.causes ?? []),
        environmentMayDiffer: environmentMayDiffer(resolved?.summary.causes ?? []),
      };
    }),
  };
});
