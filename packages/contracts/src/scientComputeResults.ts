import {
  ComputeExecutionId,
  ComputeExecutionOutputs,
  ComputeOutsideDataPaths,
  ComputeSessionId,
  ComputeSessionRecord,
  DataTableColumn,
} from "@scientfactory/compute";
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
  /**
   * How Scient knows the run used it: the runtime saw it opened, the run was told it is an input,
   * or both. Absent means observed, as in records made before declared inputs existed.
   */
  origin: Schema.optional(Schema.Literals(["observed", "declared", "both"])),
  /** A saved view or query the run read this dataset through, such as `views/adults.sql`. */
  via: Schema.optional(ProjectPath),
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

const ParameterName = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128));

/** A value a run used: a notebook's `parameters` cell, or a value passed to the run. */
export const ComputeResultParameter = Schema.Struct({
  name: ParameterName,
  /** The value as JSON text, such as `0.5`, `"adults"` or `[1, 2]`. */
  value: Text,
  /** `default` comes from the source itself; `override` was passed to this run. */
  source: Schema.Literals(["default", "override"]),
});
export type ComputeResultParameter = typeof ComputeResultParameter.Type;

/** What a run can show about its environment beyond the runtime: evidence, not a guarantee. */
export const ComputeResultEnvironment = Schema.Struct({
  /** Lockfiles in the project when the run started: `uv.lock`, `renv.lock`, `environment.yml`. */
  lockfiles: Schema.Array(Schema.Struct({ path: ProjectPath, sha256: Sha256 })),
  /** Installed packages the runtime reported, by name; absent when it was not asked. */
  packages: Schema.optional(
    Schema.Array(Schema.Struct({ name: Text, version: Text })).check(Schema.isMaxLength(4000)),
  ),
  /** More packages were installed than were kept. */
  packagesTruncated: Schema.optional(Schema.Boolean),
});
export type ComputeResultEnvironment = typeof ComputeResultEnvironment.Type;

export const ComputeResultSourceKind = Schema.Literals(["script", "notebook"]);
export type ComputeResultSourceKind = typeof ComputeResultSourceKind.Type;

const ComputeResultDirectoryInput = Schema.Struct({
  path: ProjectPath,
  sha256: Sha256,
  changedDuringRun: Schema.Boolean,
});

const UnresolvedViewInput = Schema.Struct({
  via: ProjectPath,
  reference: ProjectPath,
  reason: Schema.Literals(["no-matches", "unrecorded", "limit"]),
});

export const ComputeResultRevision = Schema.Struct({
  revision: ComputeResultRevisionId,
  /** The script or notebook that ran; the field keeps its first name so older records read. */
  script: Schema.Struct({
    path: ProjectPath,
    /** As people name it: "Python", "R". */
    language: Text,
    /**
     * Of the code that ran, which is the saved file unless it was run with unsaved changes. For a
     * notebook: the executed cell array with injected parameters (legacy: joined by a newline).
     */
    sha256: Sha256,
    /** Notebook source identity, excluding generated parameter injections. */
    codeSha256: Schema.optional(Sha256),
    notebookDigestVersion: Schema.optional(Schema.Literal(1)),
    /** Absent means a script. */
    kind: Schema.optional(ComputeResultSourceKind),
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
    directories: Schema.optional(
      Schema.Array(ComputeResultDirectoryInput).check(Schema.isMaxLength(128)),
    ),
    directoryListingVersion: Schema.optional(Schema.Literals([2, 3])),
    /** A declared saved-view pattern and the digest of its sorted matching file paths. */
    globs: Schema.optional(
      Schema.Array(ComputeResultDirectoryInput).check(Schema.isMaxLength(1000)),
    ),
    readsOutsideProject: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    outsideDataPaths: Schema.optional(ComputeOutsideDataPaths),
    unresolvedViewInputs: Schema.optional(
      Schema.Array(UnresolvedViewInput).check(Schema.isMaxLength(1000)),
    ),
    truncated: Schema.Boolean,
  }),
  outputs: Schema.Array(ComputeResultOutput),
  /** A sweep keeps this revision addressable without moving the published result. */
  publication: Schema.optional(Schema.Literal("alternative")),
  /** Files the folder held beyond the retained limits. */
  omitted: Schema.Number,
  /** Absent in records made before parameters were recorded; an empty list means none. */
  parameters: Schema.optional(Schema.Array(ComputeResultParameter).check(Schema.isMaxLength(200))),
  environment: Schema.optional(ComputeResultEnvironment),
  /** An analysis plan the run was made under, as it was when the run started. */
  plan: Schema.optional(Schema.Struct({ path: ProjectPath, sha256: Sha256 })),
});
export type ComputeResultRevision = typeof ComputeResultRevision.Type;

export const ComputeResultCause = Schema.Struct({
  kind: Schema.Literals([
    "script-changed",
    "script-missing",
    "script-unconfirmed",
    "input-changed",
    "input-missing",
    "input-changed-during-run",
    /** A lockfile recorded with the run changed or disappeared. */
    "lockfile-changed",
  ]),
  path: ProjectPath,
});
export type ComputeResultCause = typeof ComputeResultCause.Type;

export const ComputeResultLastAttempt = Schema.Struct({
  status: Schema.Literals(["failed", "cancelled"]),
  finishedAt: Text,
  message: Schema.NullOr(Text),
});
export type ComputeResultLastAttempt = typeof ComputeResultLastAttempt.Type;

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
  /** Digest of recorded input identities and contents when all were checked. */
  inputFingerprint: Schema.optional(Sha256),
  /** What changed since this revision ran; empty when nothing Scient checks has. */
  causes: Schema.Array(ComputeResultCause),
  kind: Schema.optional(ComputeResultSourceKind),
  /** Inputs the run was told about, a subset of `inputs`. */
  declaredInputs: Schema.optional(Schema.Array(ProjectPath)),
  /** Inputs named by a saved view, excluding files declared directly. */
  derivedInputs: Schema.optional(Schema.Array(ProjectPath)),
  observedInputCount: Schema.optional(Schema.Number),
  observedDirectories: Schema.optional(Schema.Array(ProjectPath)),
  readsOutsideProject: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  outsideDataPaths: Schema.optional(ComputeOutsideDataPaths),
  lastAttempt: Schema.optional(ComputeResultLastAttempt),
  inputCoverageIncomplete: Schema.optional(Schema.Boolean),
  unresolvedViewInputCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  parameters: Schema.optional(Schema.Array(ComputeResultParameter)),
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

export const ComputeResultsListInput = Schema.Struct({
  cwd: Cwd,
  preferCurrent: Schema.optionalKey(Schema.Boolean),
  revision: Schema.optionalKey(ComputeResultRevisionId),
});
export type ComputeResultsListInput = typeof ComputeResultsListInput.Type;

export const ComputeResultListedAttempt = Schema.Struct({
  ...ComputeResultLastAttempt.fields,
  sessionId: Schema.optional(ComputeSessionId),
  /** Absent when startup ended before an execution started. */
  executionId: Schema.optional(ComputeExecutionId),
});

export const ComputeResultScript = Schema.Struct({
  latest: ComputeResultSummary,
  values: Schema.Array(ComputeResultValue),
  /** Includes PDF figures, which LaTeX papers take and Markdown papers cannot show. */
  figures: Schema.Array(ProjectPath),
  /** CSV tables and `.tex` files; optional so an older server's answer still reads. */
  tables: Schema.optional(Schema.Array(ProjectPath)),
  revisions: Schema.Number,
  /**
   * The newest attempt to publish, when it did not publish: the latest successful revision stays
   * the one shown, and this says a later run failed or was stopped.
   */
  lastAttempt: Schema.optional(Schema.NullOr(ComputeResultListedAttempt)),
});
export type ComputeResultScript = typeof ComputeResultScript.Type;

export const ComputeResultsPublicationInput = Schema.Struct({
  cwd: Cwd,
  sessionId: ComputeSessionId,
  executionId: ComputeExecutionId,
  scriptPath: ProjectPath,
});
export type ComputeResultsPublicationInput = typeof ComputeResultsPublicationInput.Type;

export const ComputeResultCounts = Schema.Struct({
  values: Schema.Int,
  tables: Schema.Int,
  figures: Schema.Int,
  files: Schema.Int,
});
export type ComputeResultCounts = typeof ComputeResultCounts.Type;

export const ComputeResultsPublicationResult = Schema.Union([
  Schema.TaggedStruct("published", {
    count: Schema.Int,
    counts: Schema.optional(ComputeResultCounts),
  }),
  Schema.TaggedStruct("failed", { message: Text }),
  Schema.TaggedStruct("unavailable", {}),
]);
export type ComputeResultsPublicationResult = typeof ComputeResultsPublicationResult.Type;

export const ComputeResultsAttemptOutputInput = Schema.Struct({
  cwd: Cwd,
  scriptPath: ProjectPath,
  finishedAt: Text,
});
export type ComputeResultsAttemptOutputInput = typeof ComputeResultsAttemptOutputInput.Type;

export const ComputeResultsAttemptOutputResult = Schema.Struct({
  output: ComputeExecutionOutputs,
  session: Schema.NullOr(ComputeSessionRecord),
  executionId: Schema.NullOr(ComputeExecutionId),
  cellId: Schema.optional(Text),
  parameters: Schema.optional(Schema.Array(ComputeResultParameter).check(Schema.isMaxLength(200))),
});
export type ComputeResultsAttemptOutputResult = typeof ComputeResultsAttemptOutputResult.Type;

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

/** Values passed to one run, by name, each as JSON text. */
export const ComputeResultParameterValues = Schema.Record(ParameterName, Text).check(
  Schema.isMaxProperties(200),
);
export type ComputeResultParameterValues = typeof ComputeResultParameterValues.Type;

export const ComputeResultsSetupInput = Schema.Struct({ cwd: Cwd, scriptPath: ProjectPath });
export type ComputeResultsSetupInput = typeof ComputeResultsSetupInput.Type;

export const ComputeResultsSetupResult = Schema.Struct({
  parameters: Schema.Array(ComputeResultParameter),
  inputs: Schema.Array(ProjectPath),
  suggestedInputs: Schema.Array(ProjectPath),
});
export type ComputeResultsSetupResult = typeof ComputeResultsSetupResult.Type;

export const ComputeResultsRerunInput = Schema.Struct({
  cwd: Cwd,
  /** A script, or an `.ipynb` notebook, which runs from a fresh kernel top to bottom. */
  scriptPath: ProjectPath,
  /**
   * Overrides for this run. A script reads them as JSON from `SCIENT_PARAMETERS`; a notebook gets
   * them as a cell after its `parameters`-tagged cell. Absent: the latest revision's overrides.
   */
  parameters: Schema.optional(ComputeResultParameterValues),
  /** Project files the run is declared to read. Absent: the latest revision's declared inputs. */
  inputs: Schema.optional(Schema.Array(ProjectPath).check(Schema.isMaxLength(200))),
});
export type ComputeResultsRerunInput = typeof ComputeResultsRerunInput.Type;

export const ComputeResultsRerunResult = Schema.Union([
  Schema.TaggedStruct("published", {
    summary: ComputeResultSummary,
    notebookSaved: Schema.optional(Schema.Boolean),
    notebookMessage: Schema.optional(Text),
  }),
  Schema.TaggedStruct("completed", {
    notebookSaved: Schema.Boolean,
    notebookMessage: Schema.optional(Text),
    message: Schema.optional(Text),
  }),
  Schema.TaggedStruct("failed", { message: Text }),
]);
export type ComputeResultsRerunResult = typeof ComputeResultsRerunResult.Type;

/** Two revisions side by side; usually of one script, but any two may be compared. */
export const ComputeResultsCompareInput = Schema.Struct({
  cwd: Cwd,
  from: Text,
  to: Text,
});
export type ComputeResultsCompareInput = typeof ComputeResultsCompareInput.Type;

export const ComputeResultsHistoryInput = Schema.Struct({
  cwd: Cwd,
  scriptPath: ProjectPath,
  includeLatest: Schema.optional(Schema.Boolean),
});
export type ComputeResultsHistoryInput = typeof ComputeResultsHistoryInput.Type;

export const ComputeResultsHistoryResult = Schema.Struct({
  revisions: Schema.Array(
    Schema.Struct({
      revision: ComputeResultRevisionId,
      finishedAt: Text,
      parameters: Schema.optional(Schema.Array(ComputeResultParameter)),
    }),
  ),
  latest: Schema.optional(ComputeResultRevision),
});
export type ComputeResultsHistoryResult = typeof ComputeResultsHistoryResult.Type;

export const ComputeResultOutputContent = Schema.Union([
  Schema.TaggedStruct("content", {
    revision: ComputeResultRevisionId,
    output: ProjectPath,
    mediaType: Text,
    encoding: Schema.Literals(["utf8", "base64"]),
    content: Schema.String.check(Schema.isMaxLength(22_000)),
    truncated: Schema.Boolean,
  }),
  Schema.TaggedStruct("unavailable", { reason: Schema.Literals(["missing", "pruned"]) }),
]);
export type ComputeResultOutputContent = typeof ComputeResultOutputContent.Type;

export const ComputeResultsPreviewInput = Schema.Struct({
  cwd: Cwd,
  revision: Text,
  output: ProjectPath,
});
export type ComputeResultsPreviewInput = typeof ComputeResultsPreviewInput.Type;

export const ComputeResultsPreviewResult = Schema.Union([
  Schema.TaggedStruct("unavailable", {
    reason: Schema.Literals(["missing", "pruned", "table-limit"]),
  }),
  Schema.TaggedStruct("figure", { path: ProjectPath, mediaType: Text }),
  Schema.TaggedStruct("table", {
    rows: ResultTableRows,
    columns: Schema.optional(Schema.Array(DataTableColumn)),
  }),
]);
export type ComputeResultsPreviewResult = typeof ComputeResultsPreviewResult.Type;

const Change = Schema.Literals(["added", "removed", "changed", "same"]);

const ComparedInputEvidence = Schema.Struct({
  origin: Schema.Literals(["observed", "declared", "both"]),
  via: Schema.optional(ProjectPath),
  changedDuringRun: Schema.Boolean,
});

export const ComputeResultsCompareResult = Schema.Struct({
  from: ComputeResultSummary,
  to: ComputeResultSummary,
  /** Null when the recorded notebook digests cannot establish a comparison. */
  codeChanged: Schema.NullOr(Schema.Boolean),
  parameters: Schema.Array(
    Schema.Struct({ name: ParameterName, from: Schema.NullOr(Text), to: Schema.NullOr(Text) }),
  ),
  inputs: Schema.Array(
    Schema.Struct({
      path: ProjectPath,
      change: Change,
      /** A missing digest prevents a content comparison. */
      contentUnchecked: Schema.optional(Schema.Literal(true)),
      evidence: Schema.optional(
        Schema.Struct({
          from: ComparedInputEvidence,
          to: ComparedInputEvidence,
        }),
      ),
    }),
  ),
  runtime: Schema.Struct({
    from: Schema.Struct({ executable: Schema.NullOr(Text), version: Schema.NullOr(Text) }),
    to: Schema.Struct({ executable: Schema.NullOr(Text), version: Schema.NullOr(Text) }),
    changed: Schema.Boolean,
  }),
  /** Lockfiles and packages that differ; empty when neither revision recorded any. */
  environment: Schema.Array(
    Schema.Struct({
      name: Text,
      from: Schema.NullOr(Text),
      to: Schema.NullOr(Text),
      kind: Schema.optional(Schema.Literals(["lockfile", "package"])),
    }),
  ),
  environmentEvidence: Schema.optional(
    Schema.Struct({
      fromLockfiles: Schema.Boolean,
      toLockfiles: Schema.Boolean,
      fromPackages: Schema.Boolean,
      toPackages: Schema.Boolean,
      packagesTruncated: Schema.Boolean,
    }),
  ),
  outputs: Schema.Array(
    Schema.Struct({ name: ProjectPath, kind: ComputeResultOutputKind, change: Change }),
  ),
  /** Value pairs from the revisions' JSON outputs, capped at 500. */
  values: Schema.Array(
    Schema.Struct({
      output: ProjectPath,
      pointer: Text,
      from: Schema.NullOr(Text),
      to: Schema.NullOr(Text),
      delta: Schema.optional(Schema.Number),
      relativeChange: Schema.optional(Schema.Number),
      typeChanged: Schema.optional(Schema.Boolean),
    }),
  ).check(Schema.isMaxLength(500)),
  /** More value pairs differed than could be listed. */
  valuesTruncated: Schema.Boolean,
});
export type ComputeResultsCompareResult = typeof ComputeResultsCompareResult.Type;

/**
 * LaTeX papers take results as ordinary files at stable paths beside the root document, under
 * `results/<script>/`. Scient places them from one revision and replaces them only on Update files.
 */
export const ComputeResultsPlaceLatexInput = Schema.Struct({
  cwd: Cwd,
  /** The root document, whose folder LaTeX resolves `\input` and `\includegraphics` from. */
  documentPath: ProjectPath,
  /** The editor's preamble with its included files, so new macro names avoid every one in use. */
  setup: Schema.optional(Schema.String.check(Schema.isMaxLength(512 * 1024))),
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
  macro: Schema.NullOr(Schema.Struct({ name: Text, definition: Text, includedMarker: Text })),
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
  sha256: Schema.optional(Sha256),
  state: ComputeResultFileState,
  /**
   * Whether the shown PDF read this file, from its build's dependency record; null when that
   * record cannot say, as for figures or an incomplete record.
   */
  usedByBuild: Schema.NullOr(Schema.Boolean),
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
  /** An Update or Undo stopped part way; Undo update puts the earlier files back. */
  interrupted: Schema.Boolean,
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

/** A file as the user saw it when agreeing to replace it. */
export const ComputeResultFileDigest = Schema.Struct({ path: ProjectPath, sha256: Text });
export type ComputeResultFileDigest = typeof ComputeResultFileDigest.Type;

export const ComputeResultsUpdateFilesInput = Schema.Struct({
  cwd: Cwd,
  documentPath: ProjectPath,
  scriptPath: ProjectPath,
  /**
   * The run the card offered. A different newest run refuses, so nothing is placed that the user
   * did not see. The files' own run restores missing files.
   */
  toRevision: Text,
  /** Edited files the user agreed to replace, as they were then; their bytes are kept for Undo. */
  replaceEdited: Schema.Array(ComputeResultFileDigest).check(Schema.isMaxLength(500)),
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
  Schema.TaggedStruct("refused", { message: Text, edited: Schema.Array(ComputeResultFileDigest) }),
]);
export type ComputeResultsFilesChangeResult = typeof ComputeResultsFilesChangeResult.Type;

export class ComputeResultsError extends Schema.TaggedError<ComputeResultsError>()(
  "ComputeResultsError",
  {
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
