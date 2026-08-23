import { describe, expect, it } from "vite-plus/test";

import {
  ArtifactProducerId,
  LogicalDocumentKey,
  ProducingOperationId,
} from "@scientfactory/document-artifacts";
import { Schema } from "effect";
import * as Encoding from "effect/Encoding";

import {
  BROWSER_PDF_EXPORT_MAX_BYTES,
  BrowserPdfExportInput,
  BrowserPdfExportResult,
} from "./browserPdfExport.ts";

const input = {
  logicalDocumentKey: LogicalDocumentKey.make("browser-export:fixture"),
  operationId: ProducingOperationId.make("browser-export-op"),
  producerId: ArtifactProducerId.make("browser.export"),
  title: "Fixture",
  sourceUrl: "https://example.test/fixture.html",
  profile: "document-layout" as const,
  media: "print" as const,
  warnings: [],
  sourceSignals: {
    bodyTextLength: 10,
    imageCount: 0,
    brokenImageCount: 0,
    canvasCount: 0,
    videoCount: 0,
    iframeCount: 0,
    scrollWidth: 800,
    scrollHeight: 1_200,
  },
  bytesBase64: Encoding.encodeBase64Url(new Uint8Array([37, 80, 68, 70])),
};
const decodeInput = Schema.decodeUnknownSync(BrowserPdfExportInput);
const decodeResult = Schema.decodeUnknownSync(BrowserPdfExportResult);

describe("browser PDF export contracts", () => {
  it("carries PDF bytes as bounded URL-safe Base64 for JSON-RPC", () => {
    const decoded = decodeInput(input);
    expect(Encoding.decodeBase64Url(decoded.bytesBase64)).toEqual(
      Encoding.decodeBase64Url(input.bytesBase64),
    );
  });

  it("keeps the shared export size budget aligned with PDF validation", () => {
    expect(BROWSER_PDF_EXPORT_MAX_BYTES).toBe(256 * 1_024 * 1_024);
  });

  it("rejects malformed publication results", () => {
    expect(() => decodeResult({ source: input })).toThrow();
  });
});
