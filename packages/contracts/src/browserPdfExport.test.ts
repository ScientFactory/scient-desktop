import { describe, expect, it } from "vite-plus/test";

import {
  ArtifactProducerId,
  LogicalDocumentKey,
  ProducingOperationId,
} from "@scientfactory/document-artifacts";
import { Schema } from "effect";
import * as Base64Url from "effect/encoding/Base64Url";

import {
  BROWSER_PDF_EXPORT_MAX_BASE64_LENGTH,
  BROWSER_PDF_EXPORT_MAX_BYTES,
  BrowserPdfExportInput,
  BrowserPdfExportResult,
  ServerBrowserPdfExportInput,
  ServerBrowserDocumentNavigateInput,
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
  bytesBase64: Base64Url.encode(new Uint8Array([37, 80, 68, 70])),
};
const decodeInput = Schema.decodeUnknownSync(BrowserPdfExportInput);
const decodeResult = Schema.decodeUnknownSync(BrowserPdfExportResult);

describe("browser PDF export contracts", () => {
  it("carries PDF bytes as bounded URL-safe Base64 for JSON-RPC", () => {
    const decoded = decodeInput(input);
    expect(Base64Url.decode(decoded.bytesBase64)).toEqual(Base64Url.decode(input.bytesBase64));
  });

  it("keeps the shared export size budget aligned with PDF validation", () => {
    expect(BROWSER_PDF_EXPORT_MAX_BYTES).toBe(64 * 1_024 * 1_024);
    expect(BROWSER_PDF_EXPORT_MAX_BASE64_LENGTH).toBeLessThan(100 * 1_024 * 1_024);
  });

  it("rejects malformed publication results", () => {
    expect(() => decodeResult({ source: input })).toThrow();
  });
});

describe("remote live browser PDF contracts", () => {
  const target = {
    threadId: "remote-thread",
    tabId: "remote-tab",
    expectedServerEpoch: "remote-epoch",
    expectedSourceUrl: "https://example.test/current",
  };
  it("requires a live tab epoch and page URL and exposes no caller-selected workspace", () => {
    const decoded = Schema.decodeUnknownSync(ServerBrowserPdfExportInput)({
      ...target,
      logicalDocumentKey: input.logicalDocumentKey,
      operationId: input.operationId,
      producerId: input.producerId,
      workspaceRoot: "/outside/the/thread",
    });
    expect(decoded).not.toHaveProperty("workspaceRoot");
    expect(() =>
      Schema.decodeUnknownSync(ServerBrowserPdfExportInput)({
        ...decoded,
        expectedServerEpoch: "",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ServerBrowserPdfExportInput)({ ...decoded, expectedSourceUrl: "" }),
    ).toThrow();
  });
  it("carries the controlling viewer generation for navigation and rejects malformed generations", () => {
    const navigate = {
      ...target,
      authorizedUrl: "https://example.test/renewed",
      controllingViewerId: "private-viewer",
      expectedControlGeneration: 3,
    };
    expect(Schema.decodeUnknownSync(ServerBrowserDocumentNavigateInput)(navigate)).toEqual(
      navigate,
    );
    expect(() =>
      Schema.decodeUnknownSync(ServerBrowserDocumentNavigateInput)({
        ...navigate,
        expectedControlGeneration: -1,
      }),
    ).toThrow();
  });
});
