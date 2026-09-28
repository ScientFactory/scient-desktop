import { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";
import {
  BROWSER_PDF_EXPORT_MAX_BASE64_LENGTH,
  BrowserPdfExportSourceSignals,
} from "./browserPdfExport.ts";
import {
  DocumentAsset,
  DocumentAssetId,
  DocumentAssetUnavailableReason,
  DocumentDirection,
  DocumentMarkdownProfile,
  DocumentWarning,
  Sha256Digest,
} from "./scientConversationExport.ts";

/**
 * Scient's document page: one complete, non-virtualized rendering of a captured
 * document that the desktop prints in a hidden, isolated window. The server
 * captures the source, the page renders it and reports readiness, and the
 * desktop refuses to print unless that report matches what was captured.
 */

/** Served by the web client next to its main entry. */
export const SCIENT_DOCUMENT_PAGE_PATH = "/scient-document.html";
/** The page reads its input from this hash parameter, never from the network location. */
export const SCIENT_DOCUMENT_PAGE_INPUT_PARAMETER = "input";
/** The page publishes a promise of its readiness report on this window property. */
export const SCIENT_DOCUMENT_PAGE_READINESS_GLOBAL = "__scientDocumentPageReadiness";
/** File names inside one server capture; captured asset bytes live under `assets/`. */
export const SCIENT_DOCUMENT_CAPTURE_ENTRY_FILE = "index.html";
export const SCIENT_DOCUMENT_CAPTURE_INPUT_FILE = "document.json";
export const SCIENT_DOCUMENT_PAGE_PROTOCOL = 1;
/** A document larger than this is not a sensible single PDF and is rejected before rendering. */
export const SCIENT_DOCUMENT_MAX_MARKDOWN_LENGTH = 8 * 1_024 * 1_024;
export const SCIENT_DOCUMENT_MAX_ASSETS = 4_096;
export const SCIENT_DOCUMENT_MAX_WARNINGS = 512;

const BoundedText = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Which kind of document bundle a page renders; the same tags as `DocumentSourceRef`. */
export const ScientDocumentKind = Schema.Literals(["workspace-file", "conversation"]);
export type ScientDocumentKind = typeof ScientDocumentKind.Type;

export const ScientDocumentCaptureId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
export type ScientDocumentCaptureId = typeof ScientDocumentCaptureId.Type;

/**
 * Content limitations the page found while rendering. They never stop
 * publication; each is a labelled placeholder in the PDF and a warning.
 */
export const ScientDocumentPageWarningCode = Schema.Literals([
  "missing-image",
  "remote-image-omitted",
  "diagram-failed",
  "math-unrendered",
  "unsupported-diagram-language",
  "raw-html-sanitized",
]);
export type ScientDocumentPageWarningCode = typeof ScientDocumentPageWarningCode.Type;

/** Execution failures. Any one of them stops publication. */
export const ScientDocumentPageFatalCode = Schema.Literals([
  "input-unavailable",
  "input-invalid",
  "render-crashed",
  "diagram-incomplete",
  "math-incomplete",
  "image-incomplete",
  "resource-unresolved",
  "fonts-unsettled",
]);
export type ScientDocumentPageFatalCode = typeof ScientDocumentPageFatalCode.Type;

export const ScientDocumentPageDiagnostic = Schema.Union([
  Schema.Struct({
    severity: Schema.Literal("warning"),
    code: ScientDocumentPageWarningCode,
    detail: BoundedText(2_048),
  }),
  Schema.Struct({
    severity: Schema.Literal("fatal"),
    code: ScientDocumentPageFatalCode,
    detail: BoundedText(2_048),
  }),
]);
export type ScientDocumentPageDiagnostic = typeof ScientDocumentPageDiagnostic.Type;

/**
 * One bundle asset as the page sees it. Captured bytes were copied next to the
 * page input; the page never reads the workspace or the attachment store.
 */
export const ScientDocumentPageAsset = Schema.Struct({
  id: DocumentAssetId,
  role: DocumentAsset.fields.role,
  fileName: DocumentAsset.fields.fileName,
  mediaType: DocumentAsset.fields.mediaType,
  content: Schema.Union([
    Schema.TaggedStruct("captured", {
      path: Schema.String.check(Schema.isPattern(/^assets\/[0-9]{4}\.[a-z0-9]{1,8}$/u)),
      /**
       * Digest of the captured bytes. A captured image that loads but does not
       * decode is a placeholder only when the served bytes match it; otherwise
       * the capture was not served as recorded. Absent from older servers.
       */
      sha256: Schema.optionalKey(Sha256Digest),
    }),
    Schema.TaggedStruct("unavailable", { reason: DocumentAssetUnavailableReason }),
  ]),
});
export type ScientDocumentPageAsset = typeof ScientDocumentPageAsset.Type;

/**
 * The captured, self-contained form of one `DocumentBundle` that the document
 * page renders. Its Markdown still refers to assets as `scient-asset:<id>`.
 */
export const ScientDocumentPageInput = Schema.Struct({
  protocol: Schema.Literal(SCIENT_DOCUMENT_PAGE_PROTOCOL),
  captureId: ScientDocumentCaptureId,
  documentKind: ScientDocumentKind,
  sourceDigest: Sha256Digest,
  profile: DocumentMarkdownProfile,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  language: Schema.NullOr(BoundedText(35)),
  direction: DocumentDirection,
  createdAt: Schema.NullOr(IsoDateTime),
  markdown: Schema.String.check(Schema.isMaxLength(SCIENT_DOCUMENT_MAX_MARKDOWN_LENGTH)),
  assets: Schema.Array(ScientDocumentPageAsset).check(
    Schema.isMaxLength(SCIENT_DOCUMENT_MAX_ASSETS),
  ),
  warnings: Schema.Array(DocumentWarning).check(Schema.isMaxLength(SCIENT_DOCUMENT_MAX_WARNINGS)),
});
export type ScientDocumentPageInput = typeof ScientDocumentPageInput.Type;

/** What the page must report before the desktop prints it. */
export const ScientDocumentPageExpectation = Schema.Struct({
  captureId: ScientDocumentCaptureId,
  documentKind: ScientDocumentKind,
  sourceDigest: Sha256Digest,
});
export type ScientDocumentPageExpectation = typeof ScientDocumentPageExpectation.Type;

export const ScientDocumentPageBlockCounts = Schema.Struct({
  headings: NonNegativeInt,
  paragraphs: NonNegativeInt,
  lists: NonNegativeInt,
  tables: NonNegativeInt,
  codeBlocks: NonNegativeInt,
  inlineMath: NonNegativeInt,
  displayMath: NonNegativeInt,
  diagrams: NonNegativeInt,
  images: NonNegativeInt,
});
export type ScientDocumentPageBlockCounts = typeof ScientDocumentPageBlockCounts.Type;

export const ScientDocumentPageReadiness = Schema.Struct({
  protocol: Schema.Literal(SCIENT_DOCUMENT_PAGE_PROTOCOL),
  status: Schema.Literals(["ready", "failed"]),
  captureId: Schema.NullOr(ScientDocumentCaptureId),
  documentKind: Schema.NullOr(ScientDocumentKind),
  sourceDigest: Schema.NullOr(Sha256Digest),
  title: BoundedText(512),
  blocks: ScientDocumentPageBlockCounts,
  /** Captured assets the page referenced but could not load. */
  unresolvedAssets: Schema.Array(DocumentAssetId).check(
    Schema.isMaxLength(SCIENT_DOCUMENT_MAX_ASSETS),
  ),
  settled: Schema.Struct({
    fonts: Schema.Boolean,
    math: Schema.Boolean,
    diagrams: Schema.Boolean,
    images: Schema.Boolean,
  }),
  diagnostics: Schema.Array(ScientDocumentPageDiagnostic).check(Schema.isMaxLength(256)),
});
export type ScientDocumentPageReadiness = typeof ScientDocumentPageReadiness.Type;

/** Server-to-desktop document render. The signed URL is short-lived and never model-visible. */
export const ScientDocumentPageRenderRequest = Schema.Struct({
  inputRelativeUrl: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(32_768),
  ),
  expected: ScientDocumentPageExpectation,
});
export type ScientDocumentPageRenderRequest = typeof ScientDocumentPageRenderRequest.Type;

/** The printed page as it travels back to the server for validation and publication. */
export const ScientDocumentPageRenderResult = Schema.Struct({
  readiness: ScientDocumentPageReadiness,
  warnings: Schema.Array(BoundedText(256)).check(Schema.isMaxLength(32)),
  sourceSignals: BrowserPdfExportSourceSignals,
  blockedRequestCount: NonNegativeInt,
  bytesBase64: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(BROWSER_PDF_EXPORT_MAX_BASE64_LENGTH),
  ),
});
export type ScientDocumentPageRenderResult = typeof ScientDocumentPageRenderResult.Type;

/**
 * Why the desktop refused to print or return a document page. `page-rejected`
 * means the readiness report did not match the capture or reported a fatal
 * problem; its detail is the page's own explanation.
 */
export const ScientDocumentPageRenderRejection = Schema.TaggedStruct("rejected", {
  reason: Schema.Literals(["page-rejected", "too-large", "failed"]),
  detail: BoundedText(2_048),
});
export type ScientDocumentPageRenderRejection = typeof ScientDocumentPageRenderRejection.Type;

/** What the document-page host operation returns to the server. */
export const ScientDocumentPageRenderOutcome = Schema.Union([
  Schema.TaggedStruct("rendered", { result: ScientDocumentPageRenderResult }),
  ScientDocumentPageRenderRejection,
]);
export type ScientDocumentPageRenderOutcome = typeof ScientDocumentPageRenderOutcome.Type;

const WorkspacePath = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.isPattern(/^[^\0]+$/u),
);

/**
 * Editor export of a saved project Markdown file. `expectedRevision` is the
 * revision the editor last saved; the server refuses to capture anything else.
 */
export const ScientMarkdownPdfPrepareInput = Schema.Struct({
  cwd: WorkspacePath,
  relativePath: WorkspacePath,
  expectedRevision: Sha256Digest,
});
export type ScientMarkdownPdfPrepareInput = typeof ScientMarkdownPdfPrepareInput.Type;

export const ScientDocumentPdfPrepared = Schema.Struct({
  inputRelativeUrl: ScientDocumentPageRenderRequest.fields.inputRelativeUrl,
  expected: ScientDocumentPageExpectation,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  warnings: Schema.Array(DocumentWarning).check(Schema.isMaxLength(SCIENT_DOCUMENT_MAX_WARNINGS)),
});
export type ScientDocumentPdfPrepared = typeof ScientDocumentPdfPrepared.Type;

export const ScientDocumentPdfPublishInput = Schema.Struct({
  captureId: ScientDocumentCaptureId,
  render: ScientDocumentPageRenderResult,
});
export type ScientDocumentPdfPublishInput = typeof ScientDocumentPdfPublishInput.Type;

/** Gives up a capture the desktop refused to print, so it does not wait out its expiry. */
export const ScientDocumentPdfReleaseInput = Schema.Struct({
  captureId: ScientDocumentCaptureId,
});
export type ScientDocumentPdfReleaseInput = typeof ScientDocumentPdfReleaseInput.Type;

export const ScientDocumentPdfPublished = Schema.Struct({
  source: PdfSourceDescriptor,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  pageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  warnings: Schema.Array(DocumentWarning).check(Schema.isMaxLength(SCIENT_DOCUMENT_MAX_WARNINGS)),
});
export type ScientDocumentPdfPublished = typeof ScientDocumentPdfPublished.Type;

export class ScientDocumentPdfExportError extends Schema.TaggedError<ScientDocumentPdfExportError>()(
  "ScientDocumentPdfExportError",
  {
    reason: Schema.Literals([
      "invalid-source",
      "source-unavailable",
      "source-changed",
      "capture-expired",
      "render-rejected",
      "too-large",
      "invalid-pdf",
      "storage",
      "failed",
    ]),
    detail: BoundedText(2_048),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const ProjectDocumentPath = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
  Schema.isPattern(/^[^\0]+$/u),
);

/** Agent export of a project document to an explicit project output. */
export const ScientDocumentExportInput = Schema.Struct({
  sourcePath: ProjectDocumentPath.annotate({
    description: "Project-relative path to an existing Markdown (.md or .markdown) document.",
  }),
  outputPath: ProjectDocumentPath.annotate({
    description:
      "Project-relative output path. Its extension selects the format; .pdf is the available format.",
  }),
});
export type ScientDocumentExportInput = typeof ScientDocumentExportInput.Type;

export const ScientDocumentExportResult = Schema.Struct({
  sourcePath: ProjectDocumentPath,
  outputPath: ProjectDocumentPath,
  format: Schema.Literal("pdf"),
  source: PdfSourceDescriptor,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  pageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  warnings: Schema.Array(BoundedText(640)).check(Schema.isMaxLength(64)),
  validation: Schema.Literal("structural"),
  visualReviewPerformed: Schema.Literal(false),
});
export type ScientDocumentExportResult = typeof ScientDocumentExportResult.Type;

/**
 * The export note for requests the document page's isolation refused. The
 * desktop prints it in the PDF's notes and the server returns it as a warning,
 * so a refused request never passes silently.
 */
export function scientDocumentBlockedRequestsNote(count: number): string {
  return count === 1 ? "1 web resource was not loaded." : `${count} web resources were not loaded.`;
}

/** A readiness report the desktop may print: the expected page, finished, with no fatal diagnostic. */
export function scientDocumentReadinessRejection(
  readiness: ScientDocumentPageReadiness,
  expected: ScientDocumentPageExpectation,
): string | null {
  // The page's own explanation is the most useful one when it failed.
  const fatal = readiness.diagnostics.find((diagnostic) => diagnostic.severity === "fatal");
  if (fatal) return fatal.detail || `The document page reported ${fatal.code}.`;
  if (readiness.captureId !== expected.captureId) {
    return "The document page rendered a different capture than the one requested.";
  }
  if (readiness.documentKind !== expected.documentKind) {
    return "The document page rendered the wrong kind of document.";
  }
  if (readiness.sourceDigest !== expected.sourceDigest) {
    return "The document page rendered a different source revision than the one captured.";
  }
  if (readiness.status !== "ready") return "The document page did not finish rendering.";
  if (readiness.unresolvedAssets.length > 0) {
    return "The document page could not load a captured image.";
  }
  const { fonts, math, diagrams, images } = readiness.settled;
  if (!fonts || !math || !diagrams || !images) {
    return "The document page did not finish rendering fonts, math, diagrams, and images.";
  }
  return null;
}

/** Web-to-desktop render of one captured document page. */
export const DesktopDocumentPageRenderInput = Schema.Struct({
  /** Absolute, signed URL of the captured page input on the environment server. */
  inputUrl: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(32_768),
  ),
  expected: ScientDocumentPageExpectation,
});
export type DesktopDocumentPageRenderInput = typeof DesktopDocumentPageRenderInput.Type;

export const DesktopDocumentPageRenderArtifact = Schema.Struct({
  data: Schema.Uint8Array,
  readiness: ScientDocumentPageReadiness,
  warnings: ScientDocumentPageRenderResult.fields.warnings,
  sourceSignals: BrowserPdfExportSourceSignals,
  /** Requests denied because they left the document page or its signed capture. */
  blockedRequestCount: NonNegativeInt,
});
export type DesktopDocumentPageRenderArtifact = typeof DesktopDocumentPageRenderArtifact.Type;

export const DesktopDocumentPageRenderOutcome = Schema.Union([
  Schema.TaggedStruct("rendered", { artifact: DesktopDocumentPageRenderArtifact }),
  ScientDocumentPageRenderRejection,
]);
export type DesktopDocumentPageRenderOutcome = typeof DesktopDocumentPageRenderOutcome.Type;
