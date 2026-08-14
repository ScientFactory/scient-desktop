import { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
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
 * many bytes to expect.
 */
export const ScientLatexManagedInstallPhase = Schema.Literals([
  "idle",
  "downloading",
  "verifying",
  "unpacking",
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

export const ScientLatexToolchainRequest = Schema.Struct({
  refresh: Schema.Boolean,
});
export type ScientLatexToolchainRequest = typeof ScientLatexToolchainRequest.Type;
