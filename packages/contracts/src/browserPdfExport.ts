import {
  ArtifactProducerId,
  LogicalDocumentKey,
  PdfSourceDescriptor,
  ProducingOperationId,
} from "@scientfactory/document-artifacts";
import * as Schema from "effect/Schema";

/** The one-click profile honors the page's native print and fragmentation rules. */
export const BrowserPdfExportProfile = Schema.Literal("document-layout");
export type BrowserPdfExportProfile = typeof BrowserPdfExportProfile.Type;

export const BrowserPdfExportMedia = Schema.Literal("print");
export type BrowserPdfExportMedia = typeof BrowserPdfExportMedia.Type;

/**
 * Keep JSON-RPC payloads below the Node WebSocket transport's 100 MiB default
 * after URL-safe Base64 expansion and JSON framing. A future binary upload can
 * raise this without changing the renderer or generated-document contracts.
 */
export const BROWSER_PDF_EXPORT_MAX_BYTES = 64 * 1_024 * 1_024;
export const BROWSER_PDF_EXPORT_MAX_BASE64_LENGTH =
  Math.ceil((BROWSER_PDF_EXPORT_MAX_BYTES * 4) / 3) + 4;

const ExportUrl = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768));
const ExportTitle = Schema.String.check(Schema.isMaxLength(512));
const ExportWarning = Schema.String.check(Schema.isMaxLength(256));

/** Signals collected from the live page before Chromium prints it. */
export const BrowserPdfExportSourceSignals = Schema.Struct({
  bodyTextLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  imageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  brokenImageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  canvasCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  videoCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  iframeCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  scrollWidth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  scrollHeight: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type BrowserPdfExportSourceSignals = typeof BrowserPdfExportSourceSignals.Type;

export const BrowserPdfExportInput = Schema.Struct({
  logicalDocumentKey: LogicalDocumentKey,
  operationId: ProducingOperationId,
  producerId: ArtifactProducerId,
  title: ExportTitle,
  sourceUrl: ExportUrl,
  profile: BrowserPdfExportProfile,
  media: BrowserPdfExportMedia,
  warnings: Schema.Array(ExportWarning).check(Schema.isMaxLength(32)),
  sourceSignals: BrowserPdfExportSourceSignals,
  bytesBase64: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(BROWSER_PDF_EXPORT_MAX_BASE64_LENGTH),
  ),
});
export type BrowserPdfExportInput = typeof BrowserPdfExportInput.Type;

export const BrowserPdfExportReceipt = Schema.Struct({
  operationId: ProducingOperationId,
  producerId: ArtifactProducerId,
  logicalDocumentKey: LogicalDocumentKey,
  sourceUrl: ExportUrl,
  title: ExportTitle,
  profile: BrowserPdfExportProfile,
  media: BrowserPdfExportMedia,
  warnings: Schema.Array(ExportWarning).check(Schema.isMaxLength(32)),
  sourceSignals: BrowserPdfExportSourceSignals,
  pageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  exportedAtEpochMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type BrowserPdfExportReceipt = typeof BrowserPdfExportReceipt.Type;

export const BrowserPdfExportResult = Schema.Struct({
  source: PdfSourceDescriptor,
  receipt: BrowserPdfExportReceipt,
});
export type BrowserPdfExportResult = typeof BrowserPdfExportResult.Type;

export class BrowserPdfExportError extends Schema.TaggedErrorClass<BrowserPdfExportError>()(
  "BrowserPdfExportError",
  {
    reason: Schema.Literals(["too-large", "invalid-pdf", "superseded", "storage", "failed"]),
    detail: Schema.String.check(Schema.isMaxLength(2_048)),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
