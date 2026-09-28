// @effect-diagnostics nodeBuiltinImport:off -- Operation identity stays server-owned.
import { ArtifactProducerId, ProducingOperationId } from "@scientfactory/document-artifacts";
import {
  BROWSER_PDF_EXPORT_MAX_BYTES,
  SCIENT_DOCUMENT_MAX_WARNINGS,
  ScientDocumentPdfExportError,
  scientDocumentBlockedRequestsNote,
  scientDocumentReadinessRejection,
  type DocumentWarning,
  type ScientDocumentPageDiagnostic,
  type ScientDocumentPageRenderResult,
  type ScientDocumentPdfPublished,
  type ScientDocumentPdfPublishInput,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";

import * as GeneratedDocumentStore from "../documentArtifacts/GeneratedDocumentStore.ts";
import {
  readDocumentCapture,
  removeDocumentCapture,
  type DocumentCaptureRecord,
} from "./DocumentCapture.ts";
import { readProjectMarkdownFile } from "./MarkdownFileBundle.ts";

/**
 * Accepting a rendered document page. Execution failures (wrong or unfinished
 * page, a changed source, an oversized or invalid PDF) stop publication;
 * content limitations the page reported travel with the result as warnings.
 */

const DOCUMENT_PDF_PRODUCER_ID = ArtifactProducerId.make("scient.document-pdf");

export const DOCUMENT_PDF_TOO_LARGE_DETAIL =
  "The PDF is larger than Scient's 64 MiB export limit. Export a shorter document, or for a conversation leave out the work log and reasoning.";

const PAGE_WARNING_CODES: Readonly<
  Record<
    Extract<ScientDocumentPageDiagnostic, { readonly severity: "warning" }>["code"],
    DocumentWarning["code"]
  >
> = {
  "missing-image": "resource-unresolved",
  "remote-image-omitted": "resource-unresolved",
  "diagram-failed": "unsupported-construct",
  "math-unrendered": "unsupported-construct",
  "unsupported-diagram-language": "unsupported-construct",
  "raw-html-sanitized": "unsupported-construct",
};

/** The capture's own warnings followed by the page's, each message once. */
export function documentPdfWarnings(
  record: DocumentCaptureRecord,
  render: ScientDocumentPageRenderResult,
): ReadonlyArray<DocumentWarning> {
  const warnings: DocumentWarning[] = [];
  const seen = new Set<string>();
  const add = (warning: DocumentWarning) => {
    if (seen.has(warning.message)) return;
    seen.add(warning.message);
    warnings.push(warning);
  };
  record.warnings.forEach(add);
  for (const diagnostic of render.readiness.diagnostics) {
    if (diagnostic.severity !== "warning") continue;
    const message = diagnostic.detail.trim();
    if (message) add({ code: PAGE_WARNING_CODES[diagnostic.code], message });
  }
  // Refused requests are the page's isolation working, not a failure; they are
  // reported, never silent. See DocumentPagePdfRenderer.
  if (render.blockedRequestCount > 0) {
    add({
      code: "resource-unresolved",
      message: scientDocumentBlockedRequestsNote(render.blockedRequestCount),
    });
  }
  return warnings.slice(0, SCIENT_DOCUMENT_MAX_WARNINGS);
}

/** Decodes and checks a render against its capture without touching any store. */
export const validateDocumentRender = Effect.fn("DocumentPdfPublication.validateRender")(function* (
  record: DocumentCaptureRecord,
  render: ScientDocumentPageRenderResult,
) {
  const rejection = scientDocumentReadinessRejection(render.readiness, record.expected);
  if (rejection !== null) {
    return yield* new ScientDocumentPdfExportError({
      reason: "render-rejected",
      detail: rejection,
    });
  }
  const bytes = yield* Effect.try({
    try: () => Result.getOrThrow(Encoding.decodeBase64Url(render.bytesBase64)),
    catch: () =>
      new ScientDocumentPdfExportError({
        reason: "invalid-pdf",
        detail: "The desktop returned invalid PDF bytes.",
      }),
  });
  if (bytes.byteLength > BROWSER_PDF_EXPORT_MAX_BYTES) {
    return yield* new ScientDocumentPdfExportError({
      reason: "too-large",
      detail: DOCUMENT_PDF_TOO_LARGE_DETAIL,
    });
  }
  return bytes;
});

/**
 * A project file must still be the same file, reached the same way, with
 * exactly the captured revision. The requested path is resolved again, so a
 * symlinked file or directory retargeted during the render is detected even
 * when the new target has identical contents.
 */
export const confirmCapturedSourceCurrent = Effect.fn(
  "DocumentPdfPublication.confirmSourceCurrent",
)(function* (record: DocumentCaptureRecord) {
  if (record.source._tag !== "workspace-file") return;
  const { workspaceRoot, relativePath, canonicalPath } = record.source;
  const changed = new ScientDocumentPdfExportError({
    reason: "source-changed",
    detail: "The document changed while the PDF was being made. Export it again.",
  });
  const current = yield* readProjectMarkdownFile(
    workspaceRoot,
    relativePath,
    record.expected.sourceDigest,
  ).pipe(Effect.mapError(() => changed));
  if (
    current.canonicalPath !== canonicalPath ||
    current.revision !== record.expected.sourceDigest
  ) {
    return yield* changed;
  }
});

const storeErrorToExportError = (
  cause: GeneratedDocumentStore.GeneratedDocumentStoreError,
): ScientDocumentPdfExportError =>
  new ScientDocumentPdfExportError({
    reason:
      cause.reason === "validation-rejected"
        ? cause.detail.includes("exceeds")
          ? "too-large"
          : "invalid-pdf"
        : cause.reason === "filesystem"
          ? "storage"
          : "failed",
    detail: cause.detail.slice(0, 2_048) || "Scient could not store the generated PDF.",
  });

export const beginDocumentPdfProduction = (record: DocumentCaptureRecord) =>
  Effect.gen(function* () {
    const store = yield* GeneratedDocumentStore.GeneratedDocumentStore;
    return yield* store
      .beginProduction({
        logicalDocumentKey: record.logicalDocumentKey,
        operationId: ProducingOperationId.make(`document-pdf-${NodeCrypto.randomUUID()}`),
        producerId: DOCUMENT_PDF_PRODUCER_ID,
      })
      .pipe(Effect.mapError(storeErrorToExportError));
  });

/** Publishes an authenticated client's rendered bytes, without claiming server attestation. */
export const publishDocumentPdfBytes = Effect.fn("DocumentPdfPublication.publishBytes")(function* (
  record: DocumentCaptureRecord,
  handle: GeneratedDocumentStore.GeneratedDocumentProductionHandle,
  bytes: Uint8Array,
) {
  const store = yield* GeneratedDocumentStore.GeneratedDocumentStore;
  return yield* store
    .publishPdf({
      ...handle,
      bytes,
      title: record.title || "Document",
      provenanceKind: "browser-export",
      validationProfile: "browser-export",
    })
    .pipe(
      Effect.tapError((cause) =>
        store.failProduction({ ...handle, reason: cause.detail }).pipe(Effect.ignore),
      ),
      Effect.mapError(storeErrorToExportError),
    );
});

/**
 * The editor's publication step: validate the returned render against its
 * capture, confirm the file is unchanged, and publish. The capture is removed
 * whatever the outcome; a retry starts from a fresh capture.
 */
export const publishCapturedDocumentPdf = Effect.fn("DocumentPdfPublication.publishCaptured")(
  function* (input: ScientDocumentPdfPublishInput) {
    const record = yield* readDocumentCapture(input.captureId);
    return yield* Effect.gen(function* () {
      const bytes = yield* validateDocumentRender(record, input.render);
      yield* confirmCapturedSourceCurrent(record);
      const handle = yield* beginDocumentPdfProduction(record);
      const source = yield* publishDocumentPdfBytes(record, handle, bytes);
      return {
        source,
        title: record.title || "Document",
        pageCount: source.pageCount ?? 1,
        byteLength: bytes.byteLength,
        warnings: documentPdfWarnings(record, input.render),
      } satisfies ScientDocumentPdfPublished;
    }).pipe(Effect.ensuring(removeDocumentCapture(input.captureId)));
  },
);
