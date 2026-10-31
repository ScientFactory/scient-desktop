import * as Schema from "effect/Schema";

import { FilePathString, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ComputeExecutionId, ComputeSessionId } from "./scientCompute.ts";

const NotebookAddress = {
  cwd: TrimmedNonEmptyString,
  path: FilePathString,
};

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
});
export type NotebookOutputView = typeof NotebookOutputView.Type;

export const NotebookCellView = Schema.Struct({
  id: CellId,
  cellType: NotebookCellType,
  source: Schema.String,
  executionCount: Schema.NullOr(Schema.Number),
  run: Schema.NullOr(NotebookCellRun),
  /** A submitted run this cell is waiting to record. */
  pendingExecution: Schema.NullOr(Schema.String),
  outputs: Schema.Array(NotebookOutputView),
});
export type NotebookCellView = typeof NotebookCellView.Type;

export const NotebookView = Schema.Struct({
  revision: Schema.String,
  language: Schema.String,
  cells: Schema.Array(NotebookCellView),
});
export type NotebookView = typeof NotebookView.Type;

export const NotebookReadInput = Schema.Struct({
  ...NotebookAddress,
  /** Null comes back when the notebook is still at this revision. */
  knownRevision: Schema.optional(Schema.String),
});
export type NotebookReadInput = typeof NotebookReadInput.Type;

export const NotebookReadOutputInput = Schema.Struct({
  ...NotebookAddress,
  cellId: CellId,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type NotebookReadOutputInput = typeof NotebookReadOutputInput.Type;

export const NotebookOutputJson = Schema.Struct({ json: Schema.NullOr(Schema.String) });
export type NotebookOutputJson = typeof NotebookOutputJson.Type;

export const NotebookEdit = Schema.Union([
  Schema.TaggedStruct("set-source", { cellId: CellId, source: Schema.String }),
  Schema.TaggedStruct("insert", {
    cellId: CellId,
    afterCellId: Schema.NullOr(CellId),
    cellType: NotebookCellType,
    source: Schema.String,
  }),
  Schema.TaggedStruct("delete", { cellId: CellId }),
  /** Puts back a cell deleted earlier, outputs included. */
  Schema.TaggedStruct("restore", { cellId: CellId, afterCellId: Schema.NullOr(CellId) }),
  Schema.TaggedStruct("move", { cellId: CellId, offset: Schema.Literals([-1, 1]) }),
  Schema.TaggedStruct("convert", { cellId: CellId, cellType: NotebookCellType }),
  Schema.TaggedStruct("clear-outputs", {}),
  /** Durable before the run ends, so its result is recorded even after a reload. */
  Schema.TaggedStruct("expect-run", { cellId: CellId, execution: Schema.String }),
]);
export type NotebookEdit = typeof NotebookEdit.Type;

export const NotebookEditInput = Schema.Struct({
  ...NotebookAddress,
  edits: Schema.Array(NotebookEdit).check(Schema.isMaxLength(1024)),
});
export type NotebookEditInput = typeof NotebookEditInput.Type;

export const NotebookEditResult = Schema.Struct({ revision: Schema.String });
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
