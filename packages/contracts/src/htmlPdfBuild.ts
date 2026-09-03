import { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import * as Schema from "effect/Schema";

import {
  BROWSER_PDF_EXPORT_MAX_BASE64_LENGTH,
  BrowserPdfExportMedia,
  BrowserPdfExportProfile,
  BrowserPdfExportSourceSignals,
} from "./browserPdfExport.ts";

const BoundedText = Schema.String.check(Schema.isMaxLength(2_048));
const ProjectHtmlPath = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
  Schema.isPattern(/^[^\0]+$/u),
);

const ProjectPdfPath = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
  Schema.isPattern(/^[^\0]+$/u),
);

/** The deliberately small public input for a project-owned HTML document build. */
export const ScientPdfBuildInput = Schema.Struct({
  sourcePath: ProjectHtmlPath.annotate({
    description: "Project-relative path to an existing .html, .htm, or .xhtml source document.",
  }),
  outputPath: ProjectPdfPath.annotate({
    description:
      "Project-relative .pdf path where the validated PDF should be written or replaced.",
  }),
});
export type ScientPdfBuildInput = typeof ScientPdfBuildInput.Type;

/** Server-to-desktop request. The signed URL is short-lived and never model-visible. */
export const ControlledHtmlPdfRenderRequest = Schema.Struct({
  assetRelativeUrl: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(32_768),
  ),
});
export type ControlledHtmlPdfRenderRequest = typeof ControlledHtmlPdfRenderRequest.Type;

/** Desktop-to-server render result carried only by the authenticated host rail. */
export const ControlledHtmlPdfRenderResult = Schema.Struct({
  title: Schema.String.check(Schema.isMaxLength(512)),
  sourceUrl: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
  profile: BrowserPdfExportProfile,
  media: BrowserPdfExportMedia,
  warnings: Schema.Array(BoundedText).check(Schema.isMaxLength(32)),
  sourceSignals: BrowserPdfExportSourceSignals,
  blockedRequestCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  bytesBase64: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(BROWSER_PDF_EXPORT_MAX_BASE64_LENGTH),
  ),
});
export type ControlledHtmlPdfRenderResult = typeof ControlledHtmlPdfRenderResult.Type;

/** Server-to-desktop request after validation and immutable publication succeed. */
export const ControlledPdfPresentRequest = Schema.Struct({
  source: PdfSourceDescriptor,
});
export type ControlledPdfPresentRequest = typeof ControlledPdfPresentRequest.Type;

export const ScientPdfBuildResult = Schema.Struct({
  sourcePath: ProjectHtmlPath,
  outputPath: ProjectPdfPath,
  source: PdfSourceDescriptor,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  pageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  warnings: Schema.Array(BoundedText).check(Schema.isMaxLength(32)),
  validation: Schema.Literal("structural"),
  visualReviewPerformed: Schema.Literal(false),
});
export type ScientPdfBuildResult = typeof ScientPdfBuildResult.Type;
