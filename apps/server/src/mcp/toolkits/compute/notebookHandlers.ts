// @effect-diagnostics nodeBuiltinImport:off -- cell and execution ids are random UUIDs.
import * as NodeCrypto from "node:crypto";

import {
  ComputeExecutionId,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type ComputeExecutionRecord,
  type NotebookCellView,
  type NotebookEdit,
  type NotebookView,
} from "@t3tools/contracts";
import {
  notebookCodeHash,
  staleNotebookCells,
  type NotebookStaleness,
} from "@t3tools/shared/notebookStaleness";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

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
    state:
      cell.cellType !== "code"
        ? "text"
        : stale === "edited"
          ? "edited since it ran"
          : stale === "upstream"
            ? "a cell above changed"
            : cell.pendingExecution !== null
              ? "running"
              : failed
                ? "failed"
                : cell.run === null && cell.executionCount === null
                  ? "never run"
                  : "ran",
    count: cell.executionCount,
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
  return {
    language: view.language,
    total: view.cells.length,
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
  const { executionId, sessionId, code, submittedAt } = execution.request;
  const cellId = cells.get(executionId);
  if (cellId === undefined || !execution.result?.startedAt) return;
  const { startedAt, finishedAt } = execution.result;
  yield* scope.gateway
    .recordNotebookRun(
      {
        cwd: scope.cwd,
        path,
        cellId,
        sessionId,
        executionId,
        executionCount: execution.result.executionCount ?? null,
        run: {
          execution: executionId,
          code: notebookCodeHash(code),
          at: finishedAt ?? submittedAt,
          ms: finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
        },
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
      const parsed = stored.json === null ? null : (JSON.parse(stored.json) as unknown);
      const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data[mediaType] : undefined;
      if (data !== undefined) images.push({ mediaType, data: text(data).replaceAll(/\s/gu, "") });
    }
  }
  return images;
});

export const readScientNotebook = Effect.fn("ScientComputeToolkit.notebookRead")(function* (input: {
  readonly path: string;
  readonly cells?: ReadonlyArray<string> | undefined;
}) {
  const scope = yield* agentScope();
  yield* recordSettledRuns(scope, input.path, yield* requireNotebook(scope, input.path));
  return describeNotebook(
    yield* requireNotebook(scope, input.path),
    input.cells === undefined ? undefined : new Set(input.cells),
  );
});

type AgentEdit =
  | { readonly op: "replace"; readonly cell: string; readonly source: string }
  | {
      readonly op: "insert";
      readonly after: string | null;
      readonly type: "code" | "markdown";
      readonly source: string;
    }
  | { readonly op: "delete"; readonly cell: string }
  | { readonly op: "move"; readonly cell: string; readonly offset: -1 | 1 }
  | { readonly op: "clear-outputs" };

function notebookEdit(edit: AgentEdit): NotebookEdit {
  switch (edit.op) {
    case "replace":
      return { _tag: "set-source", cellId: edit.cell, source: edit.source };
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
  yield* scope.gateway
    .editNotebook({ cwd: scope.cwd, path: input.path, edits })
    .pipe(Effect.mapError(notebookFailed));
  yield* scope.gateway
    .flushNotebook({ cwd: scope.cwd, path: input.path })
    .pipe(Effect.mapError(notebookFailed));
  return describeNotebook(
    yield* requireNotebook(scope, input.path),
    new Set(edits.flatMap((edit) => ("cellId" in edit ? [edit.cellId] : []))),
  );
});

export const runScientNotebook = Effect.fn("ScientComputeToolkit.notebookRun")(function* (input: {
  readonly path: string;
  readonly cells?: ReadonlyArray<string> | undefined;
  readonly waitSeconds?: number | undefined;
  readonly includeImages?: boolean | undefined;
}) {
  const scope = yield* agentScope();
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
