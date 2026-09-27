import type {
  ScientConversationExportRequest,
  ScientDocumentPageRenderResult,
  ScientDocumentPdfPrepared,
  ScientDocumentPdfPublished,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DOCUMENT_PDF_DESKTOP_REQUIRED } from "./documentPagePdf";
import {
  CONVERSATION_PDF_TOO_LARGE_MESSAGE,
  conversationPdfAvailability,
  runConversationPdfExport,
  type ConversationPdfExportDependencies,
} from "./conversationPdfExport";

const expected = {
  captureId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  documentKind: "conversation",
  sourceDigest: `sha256:${"b".repeat(64)}`,
} as const;
const prepared = {
  inputRelativeUrl: "/api/assets/token/document.json",
  expected,
  title: "Study",
  warnings: [],
} as unknown as ScientDocumentPdfPrepared;
const warnings = [
  { code: "attachment-unavailable" as const, message: "figure.png is unavailable." },
];
const published = { title: "Study", warnings } as unknown as ScientDocumentPdfPublished;
const result = { bytesBase64: "JVBERi0" } as unknown as ScientDocumentPageRenderResult;
const request = {
  threadId: "thread-1",
  format: "pdf",
  delivery: "file",
  options: {
    includeWorkLog: true,
    includeReasoning: false,
    range: { _tag: "through-message", messageId: "m2" },
  },
  timeZone: "Asia/Jerusalem",
} as unknown as ScientConversationExportRequest;

function dependencies(
  overrides: Partial<ConversationPdfExportDependencies> = {},
): ConversationPdfExportDependencies {
  return {
    prepare: vi.fn(async () => prepared),
    render: vi.fn(async () => ({ _tag: "rendered" as const, result })),
    publish: vi.fn(async () => published),
    open: vi.fn(),
    ...overrides,
  };
}

describe("conversation PDF export", () => {
  it("captures with the dialog's options, prints, publishes, and opens the reader", async () => {
    const deps = dependencies();
    expect(await runConversationPdfExport(deps, request)).toEqual({
      title: "PDF exported",
      warnings,
    });
    expect(deps.prepare).toHaveBeenCalledWith(request);
    expect(deps.render).toHaveBeenCalledWith({
      inputRelativeUrl: prepared.inputRelativeUrl,
      expected,
    });
    expect(deps.publish).toHaveBeenCalledWith({ captureId: expected.captureId, render: result });
    expect(deps.open).toHaveBeenCalledWith(published);
  });

  it("suggests a shorter range or no work log for an over-limit PDF, and publishes nothing", async () => {
    const deps = dependencies({
      render: vi.fn(async () => ({
        _tag: "rejected" as const,
        reason: "too-large" as const,
        detail: "",
      })),
    });
    await expect(runConversationPdfExport(deps, request)).rejects.toThrow(
      CONVERSATION_PDF_TOO_LARGE_MESSAGE,
    );
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.open).not.toHaveBeenCalled();
  });

  it("is unavailable, with the reason, without a Scient desktop", () => {
    expect(conversationPdfAvailability()).toEqual({
      available: false,
      reason: DOCUMENT_PDF_DESKTOP_REQUIRED,
    });
  });
});
