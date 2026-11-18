import * as Schema from "effect/Schema";

/**
 * Linked results: values and figures a fresh script run left in `SCIENT_RESULTS_DIR`, kept as one
 * revision on this computer and referenced from a manuscript by revision, never by a moving path.
 */
export const ComputeResultRevisionId = Schema.String.check(
  Schema.isPattern(/^r[0-9a-z]{12}$/u),
).pipe(Schema.brand("ComputeResultRevisionId"));
export type ComputeResultRevisionId = typeof ComputeResultRevisionId.Type;

const ProjectPath = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096));
const Cwd = Schema.String.check(Schema.isMaxLength(4096));
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Text = Schema.String.check(Schema.isMaxLength(4096));

export const ComputeResultInput = Schema.Struct({
  path: ProjectPath,
  size: Schema.Number,
  /** Decimal nanoseconds, compared exactly with what the runtime saw. */
  modifiedAtNs: Schema.String,
  /** Status-change time, which no ordinary tool can set back, so equal times mean equal bytes. */
  changedAtNs: Schema.optional(Schema.String),
  /** Null above the hashing limit, where size and modification time are all that is compared. */
  sha256: Schema.NullOr(Sha256),
  /** The file was different at the end of the run from when the script opened it. */
  changedDuringRun: Schema.Boolean,
});
export type ComputeResultInput = typeof ComputeResultInput.Type;

/** `table` is a CSV; `latex` is a `.tex` file the script wrote itself, such as a finished table. */
export const ComputeResultOutputKind = Schema.Literals([
  "values",
  "figure",
  "table",
  "latex",
  "file",
]);
export type ComputeResultOutputKind = typeof ComputeResultOutputKind.Type;

export const ComputeResultOutput = Schema.Struct({
  /** POSIX path inside the run's results folder. */
  name: ProjectPath,
  kind: ComputeResultOutputKind,
  mediaType: Text,
  sha256: Sha256,
  size: Schema.Number,
  /** Bytes removed by retention; the metadata, and any manuscript copy, stay. */
  pruned: Schema.optional(Schema.Boolean),
});
export type ComputeResultOutput = typeof ComputeResultOutput.Type;

export const ComputeResultRevision = Schema.Struct({
  revision: ComputeResultRevisionId,
  script: Schema.Struct({
    path: ProjectPath,
    /** As people name it: "Python", "R". */
    language: Text,
    /** Of the code that ran, which is the saved file unless it was run with unsaved changes. */
    sha256: Sha256,
  }),
  run: Schema.Struct({
    sessionId: Text,
    executionId: Text,
    startedAt: Schema.NullOr(Text),
    finishedAt: Text,
    /** Absent when the researcher ran it. */
    threadId: Schema.optional(Text),
  }),
  runtime: Schema.Struct({
    executable: Schema.NullOr(Text),
    version: Schema.NullOr(Text),
    fingerprint: Schema.NullOr(Text),
  }),
  inputs: Schema.Struct({
    tracking: Schema.Literals(["observed", "not-tracked"]),
    files: Schema.Array(ComputeResultInput),
    truncated: Schema.Boolean,
  }),
  outputs: Schema.Array(ComputeResultOutput),
  /** Files the folder held beyond the retained limits. */
  omitted: Schema.Number,
});
export type ComputeResultRevision = typeof ComputeResultRevision.Type;

export const ComputeResultCause = Schema.Struct({
  kind: Schema.Literals([
    "script-changed",
    "script-missing",
    "input-changed",
    "input-missing",
    "input-changed-during-run",
  ]),
  path: ProjectPath,
});
export type ComputeResultCause = typeof ComputeResultCause.Type;

export const ComputeResultSummary = Schema.Struct({
  revision: ComputeResultRevisionId,
  scriptPath: ProjectPath,
  language: Text,
  finishedAt: Text,
  threadId: Schema.optional(Text),
  runtime: Schema.Struct({ executable: Schema.NullOr(Text), version: Schema.NullOr(Text) }),
  inputTracking: Schema.Literals(["observed", "not-tracked"]),
  inputs: Schema.Array(ProjectPath),
  inputsTruncated: Schema.Boolean,
  /** What changed since this revision ran; empty when nothing Scient checks has. */
  causes: Schema.Array(ComputeResultCause),
});
export type ComputeResultSummary = typeof ComputeResultSummary.Type;

/** One value or figure a manuscript points at, as the editor currently shows it. */
export const ComputeResultReference = Schema.Struct({
  revision: Text,
  output: ProjectPath,
  pointer: Schema.NullOr(Text),
});
export type ComputeResultReference = typeof ComputeResultReference.Type;

export const ComputeResultValue = Schema.Struct({
  output: ProjectPath,
  pointer: Text,
  value: Text,
});
export type ComputeResultValue = typeof ComputeResultValue.Type;

const ResultTableRows = Schema.Array(Schema.Array(Text).check(Schema.isMaxLength(40))).check(
  Schema.isMaxLength(501),
);

export const ComputeResultResolution = Schema.Union([
  Schema.TaggedStruct("unrecorded", {}),
  Schema.TaggedStruct("resolved", {
    summary: ComputeResultSummary,
    /** Null when the revision has no such output or value. */
    value: Schema.NullOr(Text),
    figure: Schema.Boolean,
    /** A CSV table's rows, header first; absent or null for anything else. */
    table: Schema.optional(Schema.NullOr(ResultTableRows)),
    /** The newest revision of the same script, when it is newer than this one. */
    newer: Schema.NullOr(
      Schema.Struct({
        summary: ComputeResultSummary,
        value: Schema.NullOr(Text),
        figure: Schema.Boolean,
        table: Schema.optional(Schema.NullOr(ResultTableRows)),
      }),
    ),
  }),
]);
export type ComputeResultResolution = typeof ComputeResultResolution.Type;

export const ComputeResultsResolveInput = Schema.Struct({
  cwd: Cwd,
  references: Schema.Array(ComputeResultReference).check(Schema.isMaxLength(2000)),
});
export type ComputeResultsResolveInput = typeof ComputeResultsResolveInput.Type;

export const ComputeResultsResolveResult = Schema.Struct({
  resolutions: Schema.Array(ComputeResultResolution),
});
export type ComputeResultsResolveResult = typeof ComputeResultsResolveResult.Type;

export const ComputeResultsListInput = Schema.Struct({ cwd: Cwd });
export type ComputeResultsListInput = typeof ComputeResultsListInput.Type;

export const ComputeResultScript = Schema.Struct({
  latest: ComputeResultSummary,
  values: Schema.Array(ComputeResultValue),
  /** Includes PDF figures, which LaTeX papers take and Markdown papers cannot show. */
  figures: Schema.Array(ProjectPath),
  /** CSV tables and `.tex` files; optional so an older server's answer still reads. */
  tables: Schema.optional(Schema.Array(ProjectPath)),
  revisions: Schema.Number,
});
export type ComputeResultScript = typeof ComputeResultScript.Type;

export const ComputeResultsListResult = Schema.Struct({
  scripts: Schema.Array(ComputeResultScript),
});
export type ComputeResultsListResult = typeof ComputeResultsListResult.Type;

/** Copies a revision's figure beside the manuscript, so the manuscript keeps that exact figure. */
export const ComputeResultsPlaceFigureInput = Schema.Struct({
  cwd: Cwd,
  documentPath: ProjectPath,
  revision: Text,
  output: ProjectPath,
});
export type ComputeResultsPlaceFigureInput = typeof ComputeResultsPlaceFigureInput.Type;

export const ComputeResultsPlaceFigureResult = Schema.Struct({
  /** Relative to the manuscript. */
  src: ProjectPath,
});
export type ComputeResultsPlaceFigureResult = typeof ComputeResultsPlaceFigureResult.Type;

export const ComputeResultsRerunInput = Schema.Struct({
  cwd: Cwd,
  scriptPath: ProjectPath,
});
export type ComputeResultsRerunInput = typeof ComputeResultsRerunInput.Type;

export const ComputeResultsRerunResult = Schema.Union([
  Schema.TaggedStruct("published", { summary: ComputeResultSummary }),
  Schema.TaggedStruct("failed", { message: Text }),
]);
export type ComputeResultsRerunResult = typeof ComputeResultsRerunResult.Type;

/**
 * LaTeX papers take results as ordinary files at stable paths beside the root document, under
 * `results/<script>/`. Scient places them from one revision and replaces them only on Update files.
 */
export const ComputeResultsPlaceLatexInput = Schema.Struct({
  cwd: Cwd,
  /** The root document, whose folder LaTeX resolves `\input` and `\includegraphics` from. */
  documentPath: ProjectPath,
  revision: Text,
  output: ProjectPath,
  /** For a value: its JSON Pointer in `output`. */
  pointer: Schema.NullOr(Text),
});
export type ComputeResultsPlaceLatexInput = typeof ComputeResultsPlaceLatexInput.Type;

export const ComputeResultsPlaceLatexResult = Schema.Struct({
  /** LaTeX for the cursor: a macro call inline, or a `figure`/`table` environment as a block. */
  insert: Schema.Struct({ kind: Schema.Literals(["inline", "block"]), source: Text }),
  /** For a value: the macro and its LaTeX definition, so an editor can show it before compiling. */
  macro: Schema.NullOr(Schema.Struct({ name: Text, definition: Text })),
  /** A preamble line the insertion needs, already absent-checked by the caller: `\input{…}`. */
  preambleInput: Schema.NullOr(Text),
  /** Packages the inserted LaTeX needs, such as `booktabs` for a table. */
  packages: Schema.Array(Text),
  /** Project paths written or confirmed. */
  files: Schema.Array(ProjectPath),
});
export type ComputeResultsPlaceLatexResult = typeof ComputeResultsPlaceLatexResult.Type;

export const ComputeResultFileState = Schema.Literals([
  /** Matches its run, and nothing the run used has changed. */
  "current",
  /** Matches its run, but the script or an input changed since. */
  "out-of-date",
  /** Changed in the project since Scient placed it. */
  "edited",
  "missing",
]);
export type ComputeResultFileState = typeof ComputeResultFileState.Type;

export const ComputeResultPlacedFile = Schema.Struct({
  path: ProjectPath,
  state: ComputeResultFileState,
  /** The open PDF was built from a different version of this file: recompile to see it. */
  differsFromBuild: Schema.Boolean,
});
export type ComputeResultPlacedFile = typeof ComputeResultPlacedFile.Type;

export const ComputeResultPlacedScript = Schema.Struct({
  /** The revision the placed files come from. */
  summary: ComputeResultSummary,
  /** A newer successful revision Update files would place. */
  newer: Schema.NullOr(ComputeResultSummary),
  /** Why Update files would refuse the newer revision, such as a value it no longer produces. */
  updateBlocked: Schema.NullOr(Text),
  /** What Update files would change, as people read it: `\resultAnalysisHr: 0.75 → 0.73`. */
  changes: Schema.Array(Text),
  files: Schema.Array(ComputeResultPlacedFile),
  /** The last Update files can still be undone. */
  canUndo: Schema.Boolean,
});
export type ComputeResultPlacedScript = typeof ComputeResultPlacedScript.Type;

export const ComputeResultsPlacementsInput = Schema.Struct({
  cwd: Cwd,
  documentPath: ProjectPath,
  /**
   * What the shown PDF was built from: `.tex` paths with `sha256:<hex>` digests, and when the
   * build finished. Null when there is no build, or its dependency record was incomplete.
   */
  build: Schema.NullOr(
    Schema.Struct({
      finishedAt: Text,
      digests: Schema.Record(Schema.String, Schema.String),
    }),
  ),
});
export type ComputeResultsPlacementsInput = typeof ComputeResultsPlacementsInput.Type;

export const ComputeResultsPlacementsResult = Schema.Struct({
  scripts: Schema.Array(ComputeResultPlacedScript),
  /** "build" when the PDF's dependency record was compared; "placed" when only Scient's record was. */
  coverage: Schema.Literals(["build", "placed"]),
});
export type ComputeResultsPlacementsResult = typeof ComputeResultsPlacementsResult.Type;

export const ComputeResultsUpdateFilesInput = Schema.Struct({
  cwd: Cwd,
  documentPath: ProjectPath,
  scriptPath: ProjectPath,
  /** Replace files changed since they were placed; their bytes are kept for Undo. */
  replaceEdited: Schema.Boolean,
});
export type ComputeResultsUpdateFilesInput = typeof ComputeResultsUpdateFilesInput.Type;

export const ComputeResultsUndoUpdateInput = Schema.Struct({
  cwd: Cwd,
  documentPath: ProjectPath,
  scriptPath: ProjectPath,
});
export type ComputeResultsUndoUpdateInput = typeof ComputeResultsUndoUpdateInput.Type;

export const ComputeResultsFilesChangeResult = Schema.Union([
  Schema.TaggedStruct("changed", { files: Schema.Array(ProjectPath) }),
  /** Nothing was written. `edited` lists files changed since placement, which a retry may replace. */
  Schema.TaggedStruct("refused", { message: Text, edited: Schema.Array(ProjectPath) }),
]);
export type ComputeResultsFilesChangeResult = typeof ComputeResultsFilesChangeResult.Type;

export class ComputeResultsError extends Schema.TaggedError<ComputeResultsError>()(
  "ComputeResultsError",
  {
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
