import { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import * as Schema from "effect/Schema";

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty());
const PathString = NonEmptyString.check(Schema.isMaxLength(4_096));

/** The two engines Scient drives. `null` on a status means neither was found. */
export const ScientLatexToolchainKind = Schema.Literals(["latexmk", "tectonic"]);
export type ScientLatexToolchainKind = typeof ScientLatexToolchainKind.Type;

export const ScientLatexToolchainStatus = Schema.Struct({
  kind: Schema.NullOr(ScientLatexToolchainKind),
  executable: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  probedAtEpochMs: Schema.Number,
});
export type ScientLatexToolchainStatus = typeof ScientLatexToolchainStatus.Type;

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
 * One poll of a document's build. Clients poll until the state is terminal;
 * `descriptor` is the published PDF the viewer renders and survives a later
 * failure, so a stale binding still has something to show.
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
