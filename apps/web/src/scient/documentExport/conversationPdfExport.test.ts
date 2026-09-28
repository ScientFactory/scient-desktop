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
const published = {
  title: "Study",
  warnings,
  source: { _tag: "generated-pdf", fileName: "Study.pdf" },
} as unknown as ScientDocumentPdfPublished;
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
    release: vi.fn(async () => undefined),
    saveCopy: vi.fn(async () => ({ _tag: "saved" as const, path: "/Users/someone/Study.pdf" })),
    open: vi.fn(),
    ...overrides,
  };
}

describe("conversation PDF export", () => {
  it("captures with the dialog's options, prints, publishes, and saves like other formats", async () => {
    const deps = dependencies();
    const produced = await runConversationPdfExport(deps, request);
    expect(produced).toMatchObject({
      title: "Export saved",
      description: "/Users/someone/Study.pdf",
      warnings,
    });
    expect(deps.prepare).toHaveBeenCalledWith(request);
    expect(deps.render).toHaveBeenCalledWith({
      inputRelativeUrl: prepared.inputRelativeUrl,
      expected,
    });
    expect(deps.publish).toHaveBeenCalledWith({ captureId: expected.captureId, render: result });
    expect(deps.saveCopy).toHaveBeenCalledWith(published);
    expect(deps.release).not.toHaveBeenCalled();
    // The reader opens only when the notice's Open is chosen.
    expect(deps.open).not.toHaveBeenCalled();
    produced!.open!();
    expect(deps.open).toHaveBeenCalledWith(published);
  });

  it("stays in the dialog when saving is cancelled, and reports a failed save", async () => {
    const cancelled = dependencies({
      saveCopy: vi.fn(async () => ({ _tag: "cancelled" as const })),
    });
    expect(await runConversationPdfExport(cancelled, request)).toBeNull();
    const failed = dependencies({
      saveCopy: vi.fn(async () => ({ _tag: "failed" as const, reason: "write-failed" as const })),
    });
    await expect(runConversationPdfExport(failed, request)).rejects.toThrow(
      "The file could not be written.",
    );
    const downloaded = dependencies({
      saveCopy: vi.fn(async () => ({ _tag: "download-started" as const })),
    });
    expect(await runConversationPdfExport(downloaded, request)).toMatchObject({
      title: "Download started",
      description: "Study.pdf",
    });
  });

  it("releases the capture when the desktop refuses or fails to print it", async () => {
    const refused = dependencies({
      render: vi.fn(async () => ({
        _tag: "rejected" as const,
        reason: "page-rejected" as const,
        detail: 'The captured image "plot.png" could not be loaded.',
      })),
    });
    await expect(runConversationPdfExport(refused, request)).rejects.toThrow("plot.png");
    expect(refused.release).toHaveBeenCalledWith(expected.captureId);
    const crashed = dependencies({
      render: vi.fn(async () => {
        throw new Error("The desktop bridge went away.");
      }),
      release: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    // A failed release never hides the export's own error.
    await expect(runConversationPdfExport(crashed, request)).rejects.toThrow("bridge went away");
    expect(crashed.release).toHaveBeenCalledWith(expected.captureId);
    expect(crashed.publish).not.toHaveBeenCalled();
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
    expect(deps.release).toHaveBeenCalledWith(expected.captureId);
    expect(deps.saveCopy).not.toHaveBeenCalled();
  });

  it("is unavailable, with the reason, without a Scient desktop", () => {
    expect(conversationPdfAvailability()).toEqual({
      available: false,
      reason: DOCUMENT_PDF_DESKTOP_REQUIRED,
    });
  });
});
