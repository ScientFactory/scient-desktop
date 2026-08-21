import {
  ArtifactId,
  ArtifactRevisionId,
  PdfSourceDescriptor,
} from "@scientfactory/document-artifacts";
import * as Schema from "effect/Schema";

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty());
const PathString = NonEmptyString.check(Schema.isMaxLength(4_096));

/** The two engines Scient drives. `null` on a status means neither was found. */
export const ScientLatexToolchainKind = Schema.Literals(["latexmk", "tectonic"]);
export type ScientLatexToolchainKind = typeof ScientLatexToolchainKind.Type;

/**
 * Where the engine came from. `system` is anything already on this computer's
 * PATH; `scient-managed` is the distribution Scient installed and owns.
 */
export const ScientLatexToolchainSource = Schema.Literals(["system", "scient-managed"]);
export type ScientLatexToolchainSource = typeof ScientLatexToolchainSource.Type;

export const ScientLatexToolchainStatus = Schema.Struct({
  kind: Schema.NullOr(ScientLatexToolchainKind),
  executable: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  probedAtEpochMs: Schema.Number,
  /** Absent when no engine was found, and on statuses that predate managed installs. */
  source: Schema.optionalKey(ScientLatexToolchainSource),
});
export type ScientLatexToolchainStatus = typeof ScientLatexToolchainStatus.Type;

/**
 * One managed install, from the client's point of view. `downloading` is the
 * only phase that carries progress, and only once the server has been told how
 * many bytes to expect. `installing-packages` is the eager fetch of the
 * collections an ordinary document needs, which runs after the distribution is
 * in place and can only ever end in `ready`.
 */
export const ScientLatexManagedInstallPhase = Schema.Literals([
  "idle",
  "downloading",
  "verifying",
  "unpacking",
  "installing-packages",
  "ready",
  "failed",
]);
export type ScientLatexManagedInstallPhase = typeof ScientLatexManagedInstallPhase.Type;

/** Why an install stopped. Clients turn these into their own copy. */
export const ScientLatexManagedInstallFailureReason = Schema.Literals([
  "unsupported-platform",
  "unsupported-archive",
  "download-failed",
  "checksum-mismatch",
  "unpack-failed",
  "install-failed",
]);
export type ScientLatexManagedInstallFailureReason =
  typeof ScientLatexManagedInstallFailureReason.Type;

export const ScientLatexManagedInstallState = Schema.Struct({
  state: ScientLatexManagedInstallPhase,
  /** The pinned distribution this install is placing, or the installed one. */
  version: Schema.NullOr(Schema.String),
  bytesReceived: Schema.NullOr(Schema.Number),
  totalBytes: Schema.NullOr(Schema.Number),
  failureReason: Schema.NullOr(ScientLatexManagedInstallFailureReason),
  updatedAtEpochMs: Schema.Number,
  /**
   * Present only on an install that finished with its eager package fetch
   * unfinished. The engine works either way, so this is a note beside a
   * `ready` install, never a reason to offer another one.
   */
  packagesWarning: Schema.optional(Schema.String),
});
export type ScientLatexManagedInstallState = typeof ScientLatexManagedInstallState.Type;

/**
 * What the toolchain endpoint answers: the probe result every build snapshot
 * also carries, plus the managed-install facts only this endpoint reports.
 */
export const ScientLatexToolchainReport = Schema.Struct({
  ...ScientLatexToolchainStatus.fields,
  /** Scient has a pinned distribution it can install on this platform. */
  canInstallManaged: Schema.Boolean,
  /** Absent until this server has been asked to install one. */
  managedInstall: Schema.optionalKey(ScientLatexManagedInstallState),
});
export type ScientLatexToolchainReport = typeof ScientLatexToolchainReport.Type;

export const ScientLatexDiagnosticSeverity = Schema.Literals(["error", "warning"]);
export type ScientLatexDiagnosticSeverity = typeof ScientLatexDiagnosticSeverity.Type;

/** Wire mirror of the server-side `LatexDiagnostic` produced by `parseLatexLog`. */
export const ScientLatexDiagnostic = Schema.Struct({
  severity: ScientLatexDiagnosticSeverity,
  file: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Int),
  message: Schema.String,
});
export type ScientLatexDiagnostic = typeof ScientLatexDiagnostic.Type;

export const ScientLatexBuildState = Schema.Literals([
  "idle",
  "queued",
  "running",
  "publishing",
  "succeeded",
  "failed",
  "cancelled",
]);
export type ScientLatexBuildState = typeof ScientLatexBuildState.Type;

/**
 * One poll of a document's build. Clients poll until the state is terminal and
 * `pendingRerun` is false, because a coalesced rebuild re-arms the document
 * right after the terminal state is written; `descriptor` is the published PDF
 * the viewer renders and survives a later failure, so a stale binding still has
 * something to show.
 */
export const ScientLatexBuildSnapshot = Schema.Struct({
  logicalDocumentKey: Schema.String,
  rootRelativePath: Schema.String,
  state: ScientLatexBuildState,
  diagnostics: Schema.Array(ScientLatexDiagnostic),
  descriptor: Schema.NullOr(PdfSourceDescriptor),
  failureSummary: Schema.NullOr(Schema.String),
  startedAtEpochMs: Schema.NullOr(Schema.Number),
  finishedAtEpochMs: Schema.NullOr(Schema.Number),
  toolchain: Schema.NullOr(ScientLatexToolchainStatus),
  /** A rebuild was requested while this one was still running and will follow it. */
  pendingRerun: Schema.Boolean,
  /**
   * Present only while this build is fetching packages the last compile said
   * were missing. The state stays `running` throughout, so a client polls as
   * it already does and only the label it shows changes.
   */
  installingPackages: Schema.optional(Schema.Array(Schema.String)),
});
export type ScientLatexBuildSnapshot = typeof ScientLatexBuildSnapshot.Type;

export const ScientLatexBuildRequest = Schema.Struct({
  workspaceRoot: PathString,
  relativePath: PathString,
});
export type ScientLatexBuildRequest = typeof ScientLatexBuildRequest.Type;

export const ScientLatexStatusRequest = Schema.Struct({
  workspaceRoot: PathString,
  relativePath: PathString,
});
export type ScientLatexStatusRequest = typeof ScientLatexStatusRequest.Type;

export const ScientLatexCancelRequest = Schema.Struct({
  workspaceRoot: PathString,
  relativePath: PathString,
});
export type ScientLatexCancelRequest = typeof ScientLatexCancelRequest.Type;

const PositiveLine = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const NonNegativeColumn = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const SyncCoordinate = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const ScientLatexSyncRevision = {
  workspaceRoot: PathString,
  rootRelativePath: PathString,
  artifactId: ArtifactId,
  revisionId: ArtifactRevisionId,
} as const;

export const ScientLatexForwardSyncRequest = Schema.Struct({
  ...ScientLatexSyncRevision,
  sourceRelativePath: PathString,
  line: PositiveLine,
  column: Schema.optional(NonNegativeColumn),
  pageHint: Schema.optional(PositiveLine),
});
export type ScientLatexForwardSyncRequest = typeof ScientLatexForwardSyncRequest.Type;

export const ScientLatexInverseSyncRequest = Schema.Struct({
  ...ScientLatexSyncRevision,
  page: PositiveLine,
  x: SyncCoordinate,
  y: SyncCoordinate,
});
export type ScientLatexInverseSyncRequest = typeof ScientLatexInverseSyncRequest.Type;

export const ScientLatexSyncUnavailableReason = Schema.Literals([
  "revision-unavailable",
  "index-missing",
  "index-invalid",
  "navigator-unavailable",
  "navigator-failed",
  "query-timed-out",
  "position-unmapped",
  "invalid-source",
]);
export type ScientLatexSyncUnavailableReason = typeof ScientLatexSyncUnavailableReason.Type;

export const ScientLatexSyncUnavailable = Schema.TaggedStruct("unavailable", {
  reason: ScientLatexSyncUnavailableReason,
  message: Schema.String,
});
export type ScientLatexSyncUnavailable = typeof ScientLatexSyncUnavailable.Type;

export const ScientLatexForwardSyncResult = Schema.Union([
  Schema.TaggedStruct("found", {
    page: PositiveLine,
    x: SyncCoordinate,
    y: SyncCoordinate,
  }),
  ScientLatexSyncUnavailable,
]);
export type ScientLatexForwardSyncResult = typeof ScientLatexForwardSyncResult.Type;

export const ScientLatexInverseSyncResult = Schema.Union([
  Schema.TaggedStruct("found", {
    relativePath: PathString,
    line: PositiveLine,
    column: Schema.NullOr(NonNegativeColumn),
  }),
  ScientLatexSyncUnavailable,
]);
export type ScientLatexInverseSyncResult = typeof ScientLatexInverseSyncResult.Type;

export const ScientLatexToolchainRequest = Schema.Struct({
  refresh: Schema.Boolean,
});
export type ScientLatexToolchainRequest = typeof ScientLatexToolchainRequest.Type;
