import {
  BROWSER_PDF_EXPORT_MAX_BYTES,
  BrowserPdfExportError,
  type BrowserPdfExportInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";

import type { GeneratedDocumentStore } from "./GeneratedDocumentStore.ts";

export const publishBrowserPdfExport = Effect.fn(
  "BrowserPdfExportPublication.publishBrowserPdfExport",
)(
  function* (generatedDocuments: GeneratedDocumentStore["Service"], input: BrowserPdfExportInput) {
    const bytes = yield* Effect.try({
      try: () => Result.getOrThrow(Encoding.decodeBase64Url(input.bytesBase64)),
      catch: () =>
        new BrowserPdfExportError({
          reason: "failed",
          detail: "The browser PDF export bytes were not valid Base64.",
        }),
    });
    if (bytes.byteLength > BROWSER_PDF_EXPORT_MAX_BYTES) {
      return yield* new BrowserPdfExportError({
        reason: "too-large",
        detail: "The generated PDF exceeds the current 64 MiB HTML export limit.",
      });
    }

    const handle = yield* generatedDocuments.beginProduction({
      logicalDocumentKey: input.logicalDocumentKey,
      operationId: input.operationId,
      producerId: input.producerId,
    });
    const source = yield* generatedDocuments
      .publishPdf({
        ...handle,
        bytes,
        title: input.title,
        provenanceKind: "browser-export",
        validationProfile: "browser-export",
      })
      .pipe(
        Effect.catchTag("GeneratedDocumentStoreError", (cause) =>
          generatedDocuments
            .failProduction({
              ...handle,
              reason: cause.detail,
            })
            .pipe(Effect.ignore, Effect.andThen(Effect.fail(cause))),
        ),
      );

    return {
      source,
      receipt: {
        operationId: input.operationId,
        producerId: input.producerId,
        logicalDocumentKey: input.logicalDocumentKey,
        sourceUrl: input.sourceUrl,
        title: input.title,
        profile: input.profile,
        media: input.media,
        warnings: input.warnings,
        sourceSignals: input.sourceSignals,
        pageCount: source.pageCount ?? 1,
        byteLength: bytes.byteLength,
        exportedAtEpochMs: yield* Clock.currentTimeMillis,
      },
    };
  },
  Effect.mapError((cause) => {
    if (cause._tag === "BrowserPdfExportError") return cause;
    const reason =
      cause.reason === "validation-rejected"
        ? cause.detail.includes("exceeds")
          ? "too-large"
          : "invalid-pdf"
        : cause.reason === "superseded"
          ? "superseded"
          : cause.reason === "filesystem"
            ? "storage"
            : "failed";
    return new BrowserPdfExportError({ reason, detail: cause.detail });
  }),
);
