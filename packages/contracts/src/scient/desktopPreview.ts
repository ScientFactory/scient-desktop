import * as Schema from "effect/Schema";

export const DesktopPreviewNavStatusSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("Idle") }),
  Schema.Struct({
    kind: Schema.Literal("Loading"),
    url: Schema.String,
    title: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("Success"),
    url: Schema.String,
    title: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("LoadFailed"),
    url: Schema.String,
    title: Schema.String,
    code: Schema.Number,
    description: Schema.String,
  }),
]);

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

export interface DesktopControlledHtmlPdfRenderInput {
  sourceUrl: string;
}

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
