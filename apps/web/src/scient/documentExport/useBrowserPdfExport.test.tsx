import { EnvironmentFilePath, EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BrowserPdfExportTarget } from "./useBrowserPdfExport";

const mocks = vi.hoisted(() => ({
  exportPdf: vi.fn(),
  openScient: vi.fn(),
  publish: vi.fn(),
  recordExport: vi.fn(),
  updateScientGeneratedPdf: vi.fn(),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { exportPdf: mocks.exportPdf },
}));
vi.mock("~/lib/utils", () => ({ randomUUID: () => "operation-1" }));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({
      openScient: mocks.openScient,
      updateScientGeneratedPdf: mocks.updateScientGeneratedPdf,
    }),
  },
}));
vi.mock("~/state/browserPdfExport", () => ({
  browserPdfExportEnvironment: { publish: "browser-pdf-export-publish" },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.publish }));
vi.mock("../rightPanel/surfaces", () => ({
  scientGeneratedPdfSurface: (source: unknown) => ({
    id: "scient:generated-pdf:environment-1:artifact-1",
    kind: "scient",
    module: "generated-pdf",
    source,
  }),
}));
vi.mock("./htmlPdfSourceStore", () => ({
  readHtmlPdfRelation: () => ({
    id: "relation-1",
    source: {
      _tag: "environment-html",
      environmentId: EnvironmentId.make("environment-1"),
      canonicalPath: EnvironmentFilePath.make("/tmp/report.html"),
    },
  }),
  useHtmlPdfSourceStore: {
    getState: () => ({ recordExport: mocks.recordExport }),
  },
}));

import { useBrowserPdfExport } from "./useBrowserPdfExport";

let exportPdf: ((target: BrowserPdfExportTarget) => Promise<unknown>) | null = null;

function CaptureHook(): ReactElement | null {
  exportPdf = useBrowserPdfExport();
  return null;
}

const target: BrowserPdfExportTarget = {
  threadRef: {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
  },
  tabId: "tab-1",
  runtimeTabId: "runtime-tab-1",
  pageUrl: "http://127.0.0.1:16491/api/assets/renewed-token/report.html",
  activate: false,
};

const generatedSource = {
  _tag: "generated-pdf" as const,
  authority: "environment-1",
  logicalDocumentKey: "browser-export:published",
  title: "Report",
  fileName: "Report.pdf",
  capabilities: { canSaveCopy: true, canRevealSource: false },
  artifactId: "artifact-1",
  revisionId: "revision-2",
  bindingGeneration: 2,
  bindingStatus: "current" as const,
  staleReason: null,
  pageCount: 2,
};

describe("useBrowserPdfExport", () => {
  beforeEach(() => {
    exportPdf = null;
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.exportPdf.mockResolvedValue({
      data: new Uint8Array([37, 80, 68, 70]),
      sourceUrl: target.pageUrl,
      title: "Report",
      profile: "document-layout",
      media: "print",
      warnings: [],
      sourceSignals: {
        bodyTextLength: 100,
        imageCount: 0,
        brokenImageCount: 0,
        canvasCount: 0,
        videoCount: 0,
        iframeCount: 0,
        scrollWidth: 800,
        scrollHeight: 1_200,
      },
    });
    mocks.publish.mockResolvedValue({
      _tag: "Success",
      value: { source: generatedSource, receipt: { warnings: [] } },
    });
    renderToStaticMarkup(<CaptureHook />);
  });

  it("replaces an existing generated-PDF revision without activating its tab", async () => {
    await exportPdf?.(target);

    expect(mocks.updateScientGeneratedPdf).toHaveBeenCalledOnce();
    expect(mocks.openScient).not.toHaveBeenCalled();
    expect(mocks.recordExport).toHaveBeenCalledWith("relation-1", generatedSource);
    expect(mocks.publish).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: expect.objectContaining({
        logicalDocumentKey: expect.stringMatching(/^browser-export:[a-f0-9]{64}$/u),
      }),
    });
  });

  it("discards a raced render before publication", async () => {
    await expect(exportPdf?.({ ...target, isCurrent: () => false })).rejects.toThrow(
      "HTML source changed during PDF export",
    );

    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.updateScientGeneratedPdf).not.toHaveBeenCalled();
  });

  it("does not present a revision whose source lease expires after publication", async () => {
    const isCurrent = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    await expect(exportPdf?.({ ...target, isCurrent })).rejects.toThrow(
      "HTML source changed before the PDF could be presented",
    );

    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.updateScientGeneratedPdf).not.toHaveBeenCalled();
    expect(mocks.recordExport).not.toHaveBeenCalled();
  });
});
