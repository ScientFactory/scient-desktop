import { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import * as Schema from "effect/Schema";

import {
  ScientLatexBuildState,
  ScientLatexDiagnostic,
  ScientLatexToolchainStatus,
} from "./scientLatex.ts";

const ProjectPath = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
  Schema.isPattern(/^[^\0]+$/u),
);
const BoundedText = Schema.String.check(Schema.isMaxLength(2_048));
export const ScientLatexPdfBuildDiagnostic = Schema.Struct({
  severity: ScientLatexDiagnostic.fields.severity,
  file: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024))),
  line: ScientLatexDiagnostic.fields.line,
  message: BoundedText,
});
export type ScientLatexPdfBuildDiagnostic = typeof ScientLatexPdfBuildDiagnostic.Type;
const Diagnostics = Schema.Array(ScientLatexPdfBuildDiagnostic).check(Schema.isMaxLength(64));
const PackageNames = Schema.Array(
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256)),
).check(Schema.isMaxLength(40));

/** The deliberately small public input for a project-owned LaTeX document build. */
export const ScientLatexPdfBuildInput = Schema.Struct({
  sourcePath: ProjectPath.annotate({
    description: "Project-relative path to an existing .tex source document.",
  }),
  outputPath: ProjectPath.annotate({
    description:
      "Project-relative .pdf path where the validated PDF should be written or replaced.",
  }),
});
export type ScientLatexPdfBuildInput = typeof ScientLatexPdfBuildInput.Type;

/** Internal desktop handoff after a successful project LaTeX build. */
export const ControlledLatexPresentRequest = Schema.Struct({
  rootSourcePath: ProjectPath,
});
export type ControlledLatexPresentRequest = typeof ControlledLatexPresentRequest.Type;

const SharedBuildFields = {
  sourcePath: ProjectPath,
  rootSourcePath: ProjectPath,
  outputPath: ProjectPath,
} as const;

export const ScientLatexPdfBuildInProgressResult = Schema.Struct({
  status: Schema.Literal("in-progress"),
  ...SharedBuildFields,
  buildState: ScientLatexBuildState,
  toolchain: Schema.NullOr(ScientLatexToolchainStatus),
  installingPackages: PackageNames,
  retryAfterMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(250)),
});
export type ScientLatexPdfBuildInProgressResult = typeof ScientLatexPdfBuildInProgressResult.Type;

export const ScientLatexPdfBuildCompletedResult = Schema.Struct({
  status: Schema.Literal("completed"),
  ...SharedBuildFields,
  source: PdfSourceDescriptor,
  title: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512)),
  pageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  diagnostics: Diagnostics,
  warnings: Schema.Array(BoundedText).check(Schema.isMaxLength(32)),
  toolchain: ScientLatexToolchainStatus,
  validation: Schema.Literal("structural"),
  visualReviewPerformed: Schema.Literal(false),
});
export type ScientLatexPdfBuildCompletedResult = typeof ScientLatexPdfBuildCompletedResult.Type;

/** A build either finishes in this invocation or gives the agent one paced retry contract. */
export const ScientLatexPdfBuildResult = Schema.Union([
  ScientLatexPdfBuildInProgressResult,
  ScientLatexPdfBuildCompletedResult,
]);
export type ScientLatexPdfBuildResult = typeof ScientLatexPdfBuildResult.Type;
