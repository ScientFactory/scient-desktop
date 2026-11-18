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
  /** Null above the hashing limit, where size and modification time are all that is compared. */
  sha256: Schema.NullOr(Sha256),
  /** The file was different at the end of the run from when the script opened it. */
  changedDuringRun: Schema.Boolean,
});
export type ComputeResultInput = typeof ComputeResultInput.Type;

export const ComputeResultOutputKind = Schema.Literals(["values", "figure", "file"]);
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
    languageId: Text,
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
  languageId: Text,
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

export const ComputeResultResolution = Schema.Union([
  Schema.TaggedStruct("unrecorded", {}),
  Schema.TaggedStruct("resolved", {
    summary: ComputeResultSummary,
    /** Null when the revision has no such output or value. */
    value: Schema.NullOr(Text),
    figure: Schema.Boolean,
    /** The newest revision of the same script, when it is newer than this one. */
    newer: Schema.NullOr(
      Schema.Struct({
        summary: ComputeResultSummary,
        value: Schema.NullOr(Text),
        figure: Schema.Boolean,
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
  figures: Schema.Array(ProjectPath),
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

export class ComputeResultsError extends Schema.TaggedError<ComputeResultsError>()(
  "ComputeResultsError",
  {
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
