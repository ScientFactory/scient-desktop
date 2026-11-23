// @effect-diagnostics nodeBuiltinImport:off -- cell and execution ids are random UUIDs.
import * as NodeCrypto from "node:crypto";

import {
  ComputeExecutionId,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type ComputeExecutionRecord,
  type ComputeResultsRerunInput,
  type ComputeSessionId,
  type NotebookFold,
  type NotebookCellView,
  type NotebookEdit,
  type NotebookView,
} from "@t3tools/contracts";
import {
  notebookCellRun,
  notebookCodeHash,
  notebookHeadings,
  staleNotebookCells,
  type NotebookStaleness,
} from "@t3tools/shared/notebookStaleness";
import {
  notebookOverrideAllowed,
  notebookParameters,
  parseNotebookOverride,
} from "@t3tools/shared/notebookParameters";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { agentScope, ownedSession, toolError, type AgentScope } from "./agentComputeScope.ts";
import type { ComputeToolImage, ComputeToolNotebookCell } from "./tools.ts";

const DEFAULT_WAIT_SECONDS = 120;
const POLL_INTERVAL = Duration.millis(400);
/** A session lists at most this many recent runs. */
const RUN_HISTORY_LIMIT = 200;
const MAXIMUM_CELL_OUTPUT_CHARACTERS = 4000;
/** A whole-notebook read is an outline; asking for cells by id returns them in full. */
const OUTLINE_CHARACTERS = 160;
const MAXIMUM_IMAGES = 6;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif"] as const;
const decodeOutput = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const notebookFailed = (error: { readonly message: string }) =>
  toolError("compute-failed", error.message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.filter((line) => typeof line === "string").join("")
      : "";
const withoutColor = (value: string) => value.replaceAll(/\u001b\[[0-9;]*m/gu, "");

function outputText(output: Record<string, unknown>): string {
  switch (output.output_type) {
    case "stream":
      return text(output.text);
    case "error":
      return `${String(output.ename)}: ${String(output.evalue)}\n`;
    default:
      return isRecord(output.data) ? `${text(output.data["text/plain"])}\n` : "";
  }
}

function describeCell(
  cell: NotebookCellView,
  stale: NotebookStaleness | undefined,
): ComputeToolNotebookCell {
  const parsed = cell.outputs.map((output) =>
    output.json === null ? null : (JSON.parse(output.json) as Record<string, unknown>),
  );
  const output = withoutColor(
    parsed.map((entry) => (entry === null ? "[large output]\n" : outputText(entry))).join(""),
  );
  const failed = cell.outputs.some((entry) => entry.outputType === "error");
  return {
    cell: cell.id,
    type: cell.cellType,
    source: cell.source,
    version: notebookCodeHash(cell.source),
    state:
      cell.cellType !== "code"
        ? "text"
        : stale === "edited"
          ? "edited since it ran"
          : stale === "upstream"
            ? "output may be out of date"
            : cell.pendingExecution !== null
              ? "running"
              : failed
                ? "failed"
                : cell.run === null && cell.executionCount === null
                  ? "never run"
                  : "ran",
    count: cell.executionCount,
    ...(cell.folded === undefined ? {} : { folded: cell.folded }),
    ...(cell.injectedParameters ? { parameterRole: "scient-injected-parameters" as const } : {}),
    output:
      output.length > MAXIMUM_CELL_OUTPUT_CHARACTERS
        ? `${output.slice(0, MAXIMUM_CELL_OUTPUT_CHARACTERS)}\n… output cut, ${output.length} characters in all`
        : output,
    figures: cell.outputs.filter((entry) =>
      entry.mediaTypes.some((type) => type.startsWith("image/")),
    ).length,
  };
}

const outlined = (value: string) =>
  value.length > OUTLINE_CHARACTERS ? `${value.slice(0, OUTLINE_CHARACTERS)}…` : value;

/** Every cell as an outline, or the given cells in full. */
const describeNotebook = (view: NotebookView, only?: ReadonlySet<string>) => {
  const stale = staleNotebookCells(view.cells);
  const cells = view.cells
    .filter((cell) => only === undefined || only.has(cell.id))
    .map((cell) => describeCell(cell, stale.get(cell.id)));
  const parameterCell = view.cells.find((cell) => cell.parameterCell);
  return {
    language: view.language,
    total: view.cells.length,
    outline: view.cells.flatMap((cell) =>
      cell.cellType === "markdown"
        ? notebookHeadings(cell.source).map((heading) => ({ ...heading, cell: cell.id }))
        : [],
    ),
    ...(parameterCell === undefined
      ? {}
      : {
          parameterCell: parameterCell.id,
          parameters: notebookParameters(parameterCell, view.language).map((parameter) => ({
            name: parameter.name,
            value: parameter.defaultJson ?? null,
            saved: Object.hasOwn(parameterCell.savedParameters ?? {}, parameter.name)
              ? (parameterCell.savedParameters?.[parameter.name] ?? null)
              : null,
          })),
        }),
    cells:
      only !== undefined
        ? cells
        : cells.map((cell) => ({
            ...cell,
            source: outlined(cell.source),
            output: outlined(cell.output),
          })),
  };
};

const requireNotebook = Effect.fn("ScientComputeToolkit.requireNotebook")(function* (
  scope: AgentScope,
  path: string,
) {
  const view = yield* scope.gateway
    .readNotebook({ cwd: scope.cwd, path })
    .pipe(Effect.mapError(notebookFailed));
  if (view === null) return yield* toolError("compute-failed", "This notebook could not be read.");
  return view;
});

/** Writes results of runs that finished while no notebook was open to record them. */
const recordSettledRuns = Effect.fn("ScientComputeToolkit.recordSettledRuns")(function* (
  scope: AgentScope,
  path: string,
  view: NotebookView,
) {
  const waiting = new Map(
    view.cells.flatMap((cell) =>
      cell.pendingExecution === null ? [] : [[cell.pendingExecution, cell.id] as const],
    ),
  );
  if (waiting.size === 0) return;
  const sessions = yield* scope.gateway
    .listSessions({ cwd: scope.cwd })
    .pipe(Effect.mapError(notebookFailed));
  for (const session of sessions) {
    if (session.owner?._tag !== "file" || session.owner.path !== path) continue;
    const executions = yield* scope.gateway
      .listExecutions({ cwd: scope.cwd, sessionId: session.sessionId, limit: RUN_HISTORY_LIMIT })
      .pipe(Effect.mapError(notebookFailed));
    const settled = executions
      .filter(
        (execution) =>
          waiting.has(execution.request.executionId) &&
          execution.result !== null &&
          TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status),
      )
      .toSorted((left, right) => left.request.submittedAt.localeCompare(right.request.submittedAt));
    for (const execution of settled) yield* recordRun(scope, path, waiting, execution);
  }
});

const recordRun = Effect.fn("ScientComputeToolkit.recordNotebookRun")(function* (
  scope: AgentScope,
  path: string,
  cells: ReadonlyMap<string, string>,
  execution: ComputeExecutionRecord,
) {
  const { executionId, sessionId } = execution.request;
  const cellId = cells.get(executionId);
  if (cellId === undefined || !execution.result?.startedAt) return;
  yield* scope.gateway
    .recordNotebookRun(
      {
        cwd: scope.cwd,
        path,
        cellId,
        sessionId,
        executionId,
        executionCount: execution.result.executionCount ?? null,
        run: notebookCellRun(execution),
      },
      scope.gateway.notebookOutputs,
    )
    .pipe(Effect.mapError(notebookFailed));
});

const figuresOf = Effect.fn("ScientComputeToolkit.notebookFigures")(function* (
  scope: AgentScope,
  path: string,
  view: NotebookView,
  cellIds: ReadonlySet<string>,
) {
  const images: Array<ComputeToolImage> = [];
  for (const cell of view.cells) {
    if (!cellIds.has(cell.id)) continue;
    for (const [index, output] of cell.outputs.entries()) {
      if (images.length >= MAXIMUM_IMAGES) return images;
      const mediaType = IMAGE_TYPES.find((type) => output.mediaTypes.includes(type));
      if (mediaType === undefined) continue;
      const stored = yield* scope.gateway
        .readNotebookOutput({ cwd: scope.cwd, path, cellId: cell.id, index })
        .pipe(Effect.mapError(notebookFailed));
      const parsed = stored.json === null ? null : Option.getOrNull(decodeOutput(stored.json));
      const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data[mediaType] : undefined;
      if (data !== undefined) images.push({ mediaType, data: text(data).replaceAll(/\s/gu, "") });
    }
  }
  return images;
});

export const readScientNotebook = Effect.fn("ScientComputeToolkit.notebookRead")(function* (input: {
  readonly path: string;
  readonly cells?: ReadonlyArray<string> | undefined;
  readonly includeAlternatives?: boolean | undefined;
  readonly savedRevision?: string | undefined;
  readonly freshRunId?: ComputeSessionId | undefined;
  readonly includeFreshRun?: boolean | undefined;
}) {
  const scope = yield* agentScope();
  if (input.includeFreshRun || input.freshRunId !== undefined) {
    const freshRun = yield* scope.gateway
      .notebookFreshStatus({
        cwd: scope.cwd,
        scriptPath: input.path,
        ...(input.freshRunId === undefined ? {} : { runId: input.freshRunId }),
      })
      .pipe(Effect.mapError(notebookFailed));
    return { ...describeNotebook(yield* requireNotebook(scope, input.path)), freshRun };
  }
  if (input.includeAlternatives || input.savedRevision !== undefined) {
    const alternatives = yield* scope.gateway
      .notebookAlternatives({ cwd: scope.cwd, path: input.path })
      .pipe(Effect.mapError(notebookFailed));
    const selected = alternatives.runs.find((entry) => entry.revision === input.savedRevision);
    if (input.savedRevision !== undefined && selected === undefined) {
      return yield* toolError("compute-failed", "That saved notebook revision is unavailable.");
    }
    const images = (selected?.outputs ?? [])
      .flatMap(({ preview }) =>
        preview?._tag === "figure" &&
        (preview.mediaType === "image/png" || preview.mediaType === "image/jpeg")
          ? [{ mediaType: preview.mediaType, data: preview.data }]
          : [],
      )
      .slice(0, MAXIMUM_IMAGES);
    return {
      ...describeNotebook(
        yield* requireNotebook(scope, input.path),
        input.cells === undefined ? undefined : new Set(input.cells),
      ),
      alternatives: (selected === undefined ? alternatives.runs : [selected]).map((run) => ({
        revision: run.revision,
        ...(run.codeSha256 === undefined ? {} : { codeSha256: run.codeSha256 }),
        parameters: run.parameters,
        outputs: run.outputs.map(({ name, preview }) => ({
          name,
          ...(preview?._tag === "table" && selected !== undefined
            ? { rows: preview.rows, partial: preview.partial }
            : {}),
        })),
        ...(selected === undefined ? {} : { values: run.values }),
      })),
      publishedRevision: alternatives.publishedRevision,
      omittedAlternatives: alternatives.prunedRuns,
      ...(images.length === 0 ? {} : { images }),
    };
  }
  yield* recordSettledRuns(scope, input.path, yield* requireNotebook(scope, input.path));
  return describeNotebook(
    yield* requireNotebook(scope, input.path),
    input.cells === undefined ? undefined : new Set(input.cells),
  );
});

type AgentEdit =
  | {
      readonly op: "replace";
      readonly cell: string;
      readonly source: string;
      readonly version: string;
    }
  | {
      readonly op: "insert";
      readonly after: string | null;
      readonly type: "code" | "markdown";
      readonly source: string;
    }
  | { readonly op: "delete"; readonly cell: string }
  | { readonly op: "move"; readonly cell: string; readonly offset: -1 | 1 }
  | {
      readonly op: "fold";
      readonly cell: string;
      readonly part: NotebookFold;
      readonly folded: boolean;
    }
  | { readonly op: "parameters"; readonly cell: string; readonly enabled: boolean }
  | { readonly op: "clear-outputs" };

function notebookEdit(edit: AgentEdit): NotebookEdit {
  switch (edit.op) {
    case "replace":
      return { _tag: "set-source", cellId: edit.cell, source: edit.source, base: edit.version };
    case "insert":
      return {
        _tag: "insert",
        cellId: NodeCrypto.randomUUID().slice(0, 12),
        afterCellId: edit.after,
        cellType: edit.type,
        source: edit.source,
      };
    case "delete":
      return { _tag: "delete", cellId: edit.cell };
    case "move":
      return { _tag: "move", cellId: edit.cell, offset: edit.offset };
    case "fold":
      return { _tag: "set-fold", cellId: edit.cell, part: edit.part, folded: edit.folded };
    case "parameters":
      return { _tag: "set-parameters", cellId: edit.cell, enabled: edit.enabled };
    case "clear-outputs":
      return { _tag: "clear-outputs" };
  }
}

export const editScientNotebook = Effect.fn("ScientComputeToolkit.notebookEdit")(function* (input: {
  readonly path: string;
  readonly edits: ReadonlyArray<AgentEdit>;
}) {
  const scope = yield* agentScope();
  const edits = input.edits.map(notebookEdit);
  const { refused } = yield* scope.gateway
    .editNotebook({ cwd: scope.cwd, path: input.path, edits })
    .pipe(Effect.mapError(notebookFailed));
  yield* scope.gateway
    .flushNotebook({ cwd: scope.cwd, path: input.path })
    .pipe(Effect.mapError(notebookFailed));
  return {
    ...describeNotebook(
      yield* requireNotebook(scope, input.path),
      new Set(edits.flatMap((edit) => ("cellId" in edit ? [edit.cellId] : []))),
    ),
    ...(refused.length > 0 ? { refused } : {}),
  };
});

type AgentParameterValues = Readonly<Record<string, Schema.Json>>;

function normalizeAgentNotebookParameters(
  values: AgentParameterValues,
  parameters: ReturnType<typeof notebookParameters>,
) {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => {
      if (typeof value === "string") {
        const legacy = parseNotebookOverride(value);
        const declared = parameters.find((parameter) => parameter.name === name);
        if (
          legacy !== undefined &&
          (declared === undefined || notebookOverrideAllowed(declared, legacy))
        )
          return [name, value];
      }
      return [name, JSON.stringify(value)];
    }),
  );
}

export const runScientNotebook = Effect.fn("ScientComputeToolkit.notebookRun")(function* (input: {
  readonly path: string;
  readonly cells?: ReadonlyArray<string> | undefined;
  readonly waitSeconds?: number | undefined;
  readonly includeImages?: boolean | undefined;
  readonly fresh?: boolean | undefined;
  readonly sweep?: ReadonlyArray<AgentParameterValues> | undefined;
  readonly parameters?: AgentParameterValues | undefined;
  readonly inputs?: ComputeResultsRerunInput["inputs"] | undefined;
}) {
  const scope = yield* agentScope();
  if (
    input.fresh ||
    input.sweep !== undefined ||
    input.parameters !== undefined ||
    input.inputs !== undefined
  ) {
    if (input.cells !== undefined) {
      return yield* toolError(
        "compute-failed",
        "A fresh notebook run runs every code cell. Omit cells.",
      );
    }
    const view = yield* requireNotebook(scope, input.path);
    const declared = notebookParameters(
      view.cells.find((cell) => cell.parameterCell),
      view.language,
    );
    const freshRun = yield* scope.gateway
      .runNotebookFresh({
        cwd: scope.cwd,
        scriptPath: input.path,
        threadId: scope.threadId,
        ...(input.parameters === undefined
          ? {}
          : { parameters: normalizeAgentNotebookParameters(input.parameters, declared) }),
        ...(input.sweep === undefined
          ? {}
          : {
              sweep: input.sweep.map((values) =>
                normalizeAgentNotebookParameters(values, declared),
              ),
            }),
        ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
      })
      .pipe(Effect.mapError(notebookFailed));
    const outcome =
      freshRun.outcome ??
      Option.getOrUndefined(
        yield* scope.gateway
          .waitNotebookFresh({ cwd: scope.cwd, scriptPath: input.path, runId: freshRun.runId })
          .pipe(
            Effect.timeoutOption(Duration.seconds(input.waitSeconds ?? DEFAULT_WAIT_SECONDS)),
            Effect.mapError(notebookFailed),
          ),
      );
    const current = yield* scope.gateway
      .notebookFreshStatus({
        cwd: scope.cwd,
        scriptPath: input.path,
        runId: freshRun.runId,
      })
      .pipe(Effect.mapError(notebookFailed));
    return {
      ...describeNotebook(yield* requireNotebook(scope, input.path)),
      freshRun: current ?? { ...freshRun, ...(outcome === undefined ? {} : { outcome }) },
      ...(outcome === undefined || input.sweep !== undefined ? {} : { publication: outcome }),
    };
  }
  const view = yield* requireNotebook(scope, input.path);
  const requested = input.cells === undefined ? null : new Set(input.cells);
  const targets = view.cells.filter(
    (cell) =>
      cell.cellType === "code" &&
      cell.source.trim() !== "" &&
      (requested === null || requested.has(cell.id)),
  );
  if (targets.length === 0) {
    return yield* toolError("compute-failed", "None of these cells has code to run.");
  }
  const session = yield* ownedSession(scope, view.language, {
    _tag: "file",
    path: input.path,
  }).pipe(Effect.mapError(notebookFailed));
  const runs = targets.map((cell) => ({
    cellId: cell.id,
    executionId: ComputeExecutionId.make(NodeCrypto.randomUUID()),
    code: cell.source,
  }));
  yield* scope.gateway
    .submitCells({
      cwd: scope.cwd,
      sessionId: session.sessionId,
      expectedGeneration: session.generation,
      path: input.path,
      ...(requested === null ? { runAll: true } : {}),
      actor: { _tag: "agent", threadId: scope.threadId },
      cells: runs,
    })
    .pipe(Effect.mapError(notebookFailed));
  yield* scope.gateway
    .editNotebook({
      cwd: scope.cwd,
      path: input.path,
      edits: runs.map((run) => ({
        _tag: "expect-run" as const,
        cellId: run.cellId,
        execution: run.executionId,
      })),
    })
    .pipe(Effect.mapError(notebookFailed));

  const cellByRun = new Map(runs.map((run) => [run.executionId as string, run.cellId]));
  const polls = Math.ceil(
    ((input.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000) / Duration.toMillis(POLL_INTERVAL),
  );
  const unsettled = (executions: ReadonlyArray<ComputeExecutionRecord>) =>
    executions.some(
      (execution) =>
        cellByRun.has(execution.request.executionId) &&
        (execution.result === null ||
          !TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status)),
    );
  const history = scope.gateway
    .listExecutions({ cwd: scope.cwd, sessionId: session.sessionId, limit: RUN_HISTORY_LIMIT })
    .pipe(Effect.mapError(notebookFailed));
  let executions = yield* history;
  for (let poll = 0; poll < polls && unsettled(executions); poll += 1) {
    yield* Effect.sleep(POLL_INTERVAL);
    executions = yield* history;
  }
  const settled = executions
    .filter((execution) => cellByRun.has(execution.request.executionId))
    .filter(
      (execution) =>
        execution.result !== null &&
        TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status),
    )
    .toSorted((left, right) => left.request.submittedAt.localeCompare(right.request.submittedAt));
  for (const execution of settled) yield* recordRun(scope, input.path, cellByRun, execution);
  yield* scope.gateway
    .flushNotebook({ cwd: scope.cwd, path: input.path })
    .pipe(Effect.mapError(notebookFailed));

  const after = yield* requireNotebook(scope, input.path);
  const ran = new Set(runs.map((run) => run.cellId));
  const images =
    (input.includeImages ?? true) ? yield* figuresOf(scope, input.path, after, ran) : [];
  return {
    ...describeNotebook(after, ran),
    ...(images.length === 0 ? {} : { images }),
  };
});
