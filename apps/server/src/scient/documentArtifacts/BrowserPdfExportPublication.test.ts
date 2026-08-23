import {
  ArtifactProducerId,
  BindingGeneration,
  LogicalDocumentKey,
  ProducingOperationId,
} from "@scientfactory/document-artifacts";
import { PDF_VALIDATION_MAX_BYTES } from "@scientfactory/pdf-validation";
import { BROWSER_PDF_EXPORT_MAX_BYTES, BrowserPdfExportInput } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import { vi } from "vite-plus/test";

import {
  GeneratedDocumentStoreError,
  type GeneratedDocumentStore,
} from "./GeneratedDocumentStore.ts";
import { publishBrowserPdfExport } from "./BrowserPdfExportPublication.ts";

const input = BrowserPdfExportInput.make({
  logicalDocumentKey: LogicalDocumentKey.make("browser-export:fixture"),
  operationId: ProducingOperationId.make("browser-export-operation-1"),
  producerId: ArtifactProducerId.make("browser.export"),
  title: "Live report",
  sourceUrl: "https://example.test/report",
  profile: "document-layout",
  media: "print",
  warnings: [],
  sourceSignals: {
    bodyTextLength: 120,
    imageCount: 2,
    brokenImageCount: 0,
    canvasCount: 1,
    videoCount: 0,
    iframeCount: 1,
    scrollWidth: 800,
    scrollHeight: 1_200,
  },
  bytesBase64: Encoding.encodeBase64Url(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
});

function makeStore(publishError?: GeneratedDocumentStoreError) {
  const handle = {
    logicalDocumentKey: input.logicalDocumentKey,
    operationId: input.operationId,
    producerId: input.producerId,
    generation: BindingGeneration.make(1),
  };
  const source = {
    _tag: "generated-pdf" as const,
    authority: "environment-1",
    logicalDocumentKey: input.logicalDocumentKey,
    title: input.title,
    fileName: "Live report.pdf",
    capabilities: { canSaveCopy: true, canRevealSource: false },
    artifactId: "artifact-1",
    revisionId: "revision-1",
    bindingGeneration: 1,
    bindingStatus: "current" as const,
    staleReason: null,
    pageCount: 2,
  };
  const beginProduction = vi.fn(() => Effect.succeed(handle));
  const publishPdf = vi.fn(() =>
    publishError === undefined ? Effect.succeed(source) : Effect.fail(publishError),
  );
  const failProduction = vi.fn(() => Effect.void);
  const store = {
    beginProduction,
    publishPdf,
    failProduction,
  } as unknown as GeneratedDocumentStore["Service"];
  return { beginProduction, publishPdf, failProduction, source, store };
}

describe("BrowserPdfExportPublication", () => {
  it("keeps the JSON transport ceiling narrower than general PDF validation", () => {
    expect(BROWSER_PDF_EXPORT_MAX_BYTES).toBe(64 * 1_024 * 1_024);
    expect(PDF_VALIDATION_MAX_BYTES).toBe(256 * 1_024 * 1_024);
  });

  it.effect(
    "publishes through the generated-document boundary with browser validation evidence",
    () =>
      Effect.gen(function* () {
        const fixture = makeStore();

        const result = yield* publishBrowserPdfExport(fixture.store, input);

        expect(fixture.beginProduction).toHaveBeenCalledWith({
          logicalDocumentKey: input.logicalDocumentKey,
          operationId: input.operationId,
          producerId: input.producerId,
        });
        expect(fixture.publishPdf).toHaveBeenCalledWith(
          expect.objectContaining({
            provenanceKind: "browser-export",
            validationProfile: "browser-export",
          }),
        );
        expect(result.source).toBe(fixture.source);
        expect(result.receipt).toMatchObject({
          byteLength: 4,
          pageCount: 2,
          sourceSignals: input.sourceSignals,
        });
        expect(fixture.failProduction).not.toHaveBeenCalled();
      }),
  );

  it.effect("rejects malformed Base64 before creating a production", () =>
    Effect.gen(function* () {
      const fixture = makeStore();
      const exit = yield* Effect.exit(
        publishBrowserPdfExport(fixture.store, { ...input, bytesBase64: "%%%" }),
      );

      expect(exit._tag).toBe("Failure");
      expect(fixture.beginProduction).not.toHaveBeenCalled();
      expect(fixture.publishPdf).not.toHaveBeenCalled();
    }),
  );

  it.effect("marks an acquired production failed when publication cannot complete", () =>
    Effect.gen(function* () {
      const fixture = makeStore(
        new GeneratedDocumentStoreError({
          operation: "write-revision",
          reason: "filesystem",
          detail: "The PDF revision could not be stored.",
        }),
      );

      const error = yield* Effect.flip(publishBrowserPdfExport(fixture.store, input));

      expect(error.reason).toBe("storage");
      expect(fixture.failProduction).toHaveBeenCalledWith({
        logicalDocumentKey: input.logicalDocumentKey,
        operationId: input.operationId,
        producerId: input.producerId,
        generation: BindingGeneration.make(1),
        reason: "The PDF revision could not be stored.",
      });
    }),
  );
});
