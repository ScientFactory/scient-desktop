import { ScientSourceWebPage } from "@scientfactory/scient-sources";
import * as Schema from "effect/Schema";

export interface DesktopPreviewPdfExportSourceSignals {
  bodyTextLength: number;
  imageCount: number;
  brokenImageCount: number;
  canvasCount: number;
  videoCount: number;
  iframeCount: number;
  scrollWidth: number;
  scrollHeight: number;
}

export const DesktopPreviewPdfExportSourceSignalsSchema = Schema.Struct({
  bodyTextLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  imageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  brokenImageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  canvasCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  videoCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  iframeCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  scrollWidth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  scrollHeight: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export interface DesktopPreviewPdfExportArtifact {
  data: Uint8Array;
  sourceUrl: string;
  title: string;
  profile: "document-layout";
  media: "print";
  warnings: ReadonlyArray<string>;
  sourceSignals: DesktopPreviewPdfExportSourceSignals;
}

export const DesktopPreviewPdfExportArtifactSchema: Schema.Codec<DesktopPreviewPdfExportArtifact> =
  Schema.Struct({
    data: Schema.Uint8Array,
    sourceUrl: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
    title: Schema.String.check(Schema.isMaxLength(512)),
    profile: Schema.Literal("document-layout"),
    media: Schema.Literal("print"),
    warnings: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(
      Schema.isMaxLength(32),
    ),
    sourceSignals: DesktopPreviewPdfExportSourceSignalsSchema,
  });

export const DesktopControlledHtmlPdfRenderInputSchema = Schema.Struct({
  sourceUrl: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(32_768),
  ),
});

export interface DesktopControlledHtmlPdfRenderArtifact extends DesktopPreviewPdfExportArtifact {
  /** Requests denied because they escaped the signed document capability. */
  blockedRequestCount: number;
}

export const DesktopControlledHtmlPdfRenderArtifactSchema: Schema.Codec<DesktopControlledHtmlPdfRenderArtifact> =
  Schema.Struct({
    data: Schema.Uint8Array,
    sourceUrl: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
    title: Schema.String.check(Schema.isMaxLength(512)),
    profile: Schema.Literal("document-layout"),
    media: Schema.Literal("print"),
    warnings: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(
      Schema.isMaxLength(32),
    ),
    sourceSignals: DesktopPreviewPdfExportSourceSignalsSchema,
    blockedRequestCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  });

/** A browser tab as read for "Save to Library": a page's details, or a PDF's bytes fetched with the tab's sign-in. */
export const DesktopPreviewLibraryPageSchema = Schema.Union([
  Schema.TaggedStruct("page", { page: ScientSourceWebPage }),
  Schema.TaggedStruct("pdf", {
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
    fileName: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(255),
      Schema.isPattern(/^[^/\\\x00]+\.pdf$/iu),
    ),
    data: Schema.Uint8Array.check(Schema.isMinLength(5), Schema.isMaxLength(100 * 1024 * 1024)),
  }),
]);
export type DesktopPreviewLibraryPage = typeof DesktopPreviewLibraryPageSchema.Type;
