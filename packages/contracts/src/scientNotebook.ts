import * as Schema from "effect/Schema";

import { FilePathString, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentFilePath } from "./fileOpening.ts";
import { ComputeExecutionId, ComputeSessionId } from "./scientCompute.ts";
import {
  ComputeResultCounts,
  ComputeResultParameter,
  ComputeResultParameterValues,
  ComputeResultRevision,
  ComputeResultRevisionId,
  ComputeResultValue,
  ComputeResultsRerunInput,
  ComputeResultsRerunResult,
} from "./scientComputeResults.ts";

const NotebookAddress = {
  cwd: TrimmedNonEmptyString,
  path: FilePathString,
};

export const NotebookFreshRunInput = Schema.Struct({
  ...ComputeResultsRerunInput.fields,
  /** Each setting saves an alternative revision and leaves the published setting in place. */
  sweep: Schema.optional(
    Schema.Array(ComputeResultParameterValues).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  ),
});
export type NotebookFreshRunInput = typeof NotebookFreshRunInput.Type;

export const NotebookFreshRunSubscribeInput = Schema.Struct({
  cwd: ComputeResultsRerunInput.fields.cwd,
  scriptPath: ComputeResultsRerunInput.fields.scriptPath,
});
export type NotebookFreshRunSubscribeInput = typeof NotebookFreshRunSubscribeInput.Type;

export const NotebookFreshRunStatusInput = Schema.Struct({
  ...NotebookFreshRunSubscribeInput.fields,
  /** Omit to find the latest job for this notebook. */
  runId: Schema.optional(ComputeSessionId),
});
export type NotebookFreshRunStatusInput = typeof NotebookFreshRunStatusInput.Type;

export const NotebookFreshRunStopInput = Schema.Struct({
  ...NotebookFreshRunStatusInput.fields,
  runId: ComputeSessionId,
});
export type NotebookFreshRunStopInput = typeof NotebookFreshRunStopInput.Type;

export const NotebookFreshRun = Schema.Struct({
  runId: ComputeSessionId,
  /** Absent while running. */
  outcome: Schema.optional(ComputeResultsRerunResult),
  parameters: Schema.optional(ComputeResultParameterValues),
  progress: Schema.optional(
    Schema.Struct({
      phase: Schema.Literals(["starting", "running", "saving", "stopping"]),
      cell: Schema.Int,
      total: Schema.Int,
    }),
  ),
  publishedResults: Schema.optional(ComputeResultCounts),
  sweepSummary: Schema.optional(
    Schema.Struct({
      total: Schema.Int,
      saved: Schema.Int,
      failures: Schema.Array(
        Schema.Struct({
          index: Schema.Int,
          parameters: ComputeResultParameterValues,
          message: Schema.String,
        }),
      ),
    }),
  ),
});
export type NotebookFreshRun = typeof NotebookFreshRun.Type;

export const NotebookFreshRunUpdate = Schema.Struct({
  job: Schema.NullOr(NotebookFreshRun),
  settledRunId: Schema.NullOr(ComputeSessionId),
});
export type NotebookFreshRunUpdate = typeof NotebookFreshRunUpdate.Type;

const CellId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

export const NotebookCellType = Schema.Literals(["code", "markdown", "raw"]);
export type NotebookCellType = typeof NotebookCellType.Type;

/** Scient's record of a cell's last run, kept in the cell's `metadata.scient`. */
export const NotebookCellRun = Schema.Struct({
  execution: Schema.String,
  /** Hash of the code that produced the outputs. */
  code: Schema.String,
  at: Schema.String,
  ms: Schema.NullOr(Schema.Number),
});
export type NotebookCellRun = typeof NotebookCellRun.Type;

export const NotebookOutputView = Schema.Struct({
  outputType: Schema.String,
  mediaTypes: Schema.Array(Schema.String),
  bytes: Schema.Number,
  /** The nbformat output as JSON, or null when it is large enough to load on demand. */
  json: Schema.NullOr(Schema.String),
  /** For an output loaded on demand: the version of the cell's outputs it belongs to. */
  token: Schema.optional(Schema.String),
});
export type NotebookOutputView = typeof NotebookOutputView.Type;

const NotebookFold = Schema.Literals(["source", "outputs", "section"]);
export type NotebookFold = typeof NotebookFold.Type;

export const NotebookCellView = Schema.Struct({
  id: CellId,
  cellType: NotebookCellType,
  source: Schema.String,
  executionCount: Schema.NullOr(Schema.Number),
  run: Schema.NullOr(NotebookCellRun),
  /** A submitted run this cell is waiting to record. */
  pendingExecution: Schema.NullOr(Schema.String),
  outputs: Schema.Array(NotebookOutputView),
  folded: Schema.optional(Schema.Array(NotebookFold)),
  parameterCell: Schema.optional(Schema.Boolean),
  injectedParameters: Schema.optional(Schema.Boolean),
  parameterHints: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  savedParameters: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  parameterEvidenceMismatch: Schema.optional(Schema.Boolean),
});
export type NotebookCellView = typeof NotebookCellView.Type;

export const NotebookRevisionSource = Schema.Struct({
  language: Schema.String,
  cells: Schema.Array(
    Schema.Struct({
      id: NotebookCellView.fields.id,
      cellType: NotebookCellType,
      source: Schema.String,
      parameterCell: NotebookCellView.fields.parameterCell,
      injectedParameters: NotebookCellView.fields.injectedParameters,
    }),
  ),
});
export type NotebookRevisionSource = typeof NotebookRevisionSource.Type;

const NotebookSavedOutput = Schema.Struct({
  name: Schema.String,
  retainedPath: Schema.optional(EnvironmentFilePath),
  preview: Schema.NullOr(
    Schema.Union([
      Schema.TaggedStruct("figure", {
        mediaType: Schema.Literals(["image/png", "image/jpeg", "image/svg+xml"]),
        data: Schema.String,
      }),
      Schema.TaggedStruct("table", {
        rows: Schema.Array(Schema.Array(Schema.String)),
        partial: Schema.Boolean,
      }),
    ]),
  ),
});

const NotebookAlternatives = Schema.Struct({
  publishedRevision: Schema.NullOr(ComputeResultRevisionId),
  currentSourceSha256: ComputeResultRevision.fields.script.fields.codeSha256,
  runs: Schema.Array(
    Schema.Struct({
      revision: ComputeResultRevisionId,
      codeSha256: ComputeResultRevision.fields.script.fields.codeSha256,
      notebookDigestVersion: ComputeResultRevision.fields.script.fields.notebookDigestVersion,
      source: Schema.optional(NotebookRevisionSource),
      finishedAt: Schema.optional(ComputeResultRevision.fields.run.fields.finishedAt),
      parameters: Schema.Array(ComputeResultParameter),
      values: Schema.Array(ComputeResultValue),
      outputs: Schema.Array(NotebookSavedOutput),
    }),
  ),
  prunedRuns: Schema.Int,
});
export type NotebookAlternatives = typeof NotebookAlternatives.Type;

export const NotebookView = Schema.Struct({
  revision: Schema.String,
  language: Schema.String,
  cells: Schema.Array(NotebookCellView),
  alternatives: Schema.optional(NotebookAlternatives),
  /** Why the last save failed. Scient keeps trying until a save succeeds. */
  saveProblem: Schema.optional(Schema.String),
});
export type NotebookView = typeof NotebookView.Type;

export const NotebookReadInput = Schema.Struct({
  ...NotebookAddress,
  /** Null comes back when the notebook is still at this revision. */
  knownRevision: Schema.optional(Schema.String),
  includeAlternatives: Schema.optional(Schema.Boolean),
});
export type NotebookReadInput = typeof NotebookReadInput.Type;

export const NotebookReadOutputInput = Schema.Struct({
  ...NotebookAddress,
  cellId: CellId,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The output's `token`. A cell whose outputs changed since then answers `stale`. */
  token: Schema.optional(Schema.String),
});
export type NotebookReadOutputInput = typeof NotebookReadOutputInput.Type;

export const NotebookOutputJson = Schema.Struct({
  json: Schema.NullOr(Schema.String),
  stale: Schema.optional(Schema.Boolean),
});
export type NotebookOutputJson = typeof NotebookOutputJson.Type;

export const NotebookEdit = Schema.Union([
  Schema.TaggedStruct("set-source", {
    cellId: CellId,
    source: Schema.String,
    /** `notebookCodeHash` of the source this came from. A cell that moved on since refuses it. */
    base: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("insert", {
    cellId: CellId,
    afterCellId: Schema.NullOr(CellId),
    cellType: NotebookCellType,
    source: Schema.String,
  }),
  Schema.TaggedStruct("delete", { cellId: CellId }),
  /** Puts back a cell deleted earlier, outputs included. */
  Schema.TaggedStruct("restore", { cellId: CellId, afterCellId: Schema.NullOr(CellId) }),
  Schema.TaggedStruct("restore-file-version", { versionId: Schema.String }),
  Schema.TaggedStruct("move", { cellId: CellId, offset: Schema.Literals([-1, 1]) }),
  Schema.TaggedStruct("convert", { cellId: CellId, cellType: NotebookCellType }),
  Schema.TaggedStruct("set-parameters", { cellId: CellId, enabled: Schema.Boolean }),
  Schema.TaggedStruct("set-fold", {
    cellId: CellId,
    part: NotebookFold,
    folded: Schema.Boolean,
  }),
  Schema.TaggedStruct("clear-outputs", {}),
  /** Durable before the run ends, so its result is recorded even after a reload. */
  Schema.TaggedStruct("expect-run", { cellId: CellId, execution: Schema.String }),
]);
export type NotebookEdit = typeof NotebookEdit.Type;

export const NotebookEditInput = Schema.Struct({
  ...NotebookAddress,
  edits: Schema.Array(NotebookEdit).check(Schema.isMaxLength(1024)),
  /** Names this batch, so a batch sent again after a lost reply is applied once. */
  requestId: Schema.optional(Schema.String),
  /** Answers once the notebook is saved, with `saveProblem` if it could not be. */
  durable: Schema.optional(Schema.Boolean),
});
export type NotebookEditInput = typeof NotebookEditInput.Type;

export const NotebookEditResult = Schema.Struct({
  revision: Schema.String,
  /** Cells whose source moved on from an edit's `base`. Those edits changed nothing. */
  refused: Schema.Array(CellId),
  /** Cells an undo could no longer bring back; the editor reads the notebook again. */
  expired: Schema.optional(Schema.Array(CellId)),
  /** Why the last save failed. Scient keeps trying until a save succeeds. */
  saveProblem: Schema.optional(Schema.String),
});
export type NotebookEditResult = typeof NotebookEditResult.Type;

export const NotebookRecordRunInput = Schema.Struct({
  ...NotebookAddress,
  cellId: CellId,
  sessionId: ComputeSessionId,
  executionId: ComputeExecutionId,
  /** The kernel's own count for this run, when it reported one. */
  executionCount: Schema.NullOr(Schema.Number),
  run: NotebookCellRun,
});
export type NotebookRecordRunInput = typeof NotebookRecordRunInput.Type;

export const NotebookRecordRunResult = Schema.Struct({
  revision: Schema.String,
  cell: Schema.NullOr(NotebookCellView),
});
export type NotebookRecordRunResult = typeof NotebookRecordRunResult.Type;

export class NotebookError extends Schema.TaggedError<NotebookError>()("NotebookError", {
  message: Schema.String,
}) {}
