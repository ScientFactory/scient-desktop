import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ButtonHTMLAttributes, MouseEventHandler, ReactElement, ReactNode } from "react";
import { cloneElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  menuClicks: {} as Record<string, MouseEventHandler<HTMLButtonElement> | undefined>,
  announceSave: vi.fn(),
  exportPdf: vi.fn(),
  openScient: vi.fn(),
  publish: vi.fn(),
  savePdfCopy: vi.fn(),
  toastAdd: vi.fn(),
  updateScientGeneratedPdf: vi.fn(),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { exportPdf: mocks.exportPdf },
}));

vi.mock("~/components/ui/button", () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));

vi.mock("~/components/ui/menu", () => ({
  Menu: (props: { children: ReactNode }) => <div>{props.children}</div>,
  MenuTrigger: (props: { children?: ReactNode; render: ReactElement }) =>
    cloneElement(props.render, {}, props.children),
  MenuPopup: (props: { children: ReactNode }) => <div>{props.children}</div>,
  MenuItem: (
    props: ButtonHTMLAttributes<HTMLButtonElement> & { "data-export-action"?: string },
  ) => {
    const action = props["data-export-action"];
    if (action) mocks.menuClicks[action] = props.onClick ?? undefined;
    return <button {...props} />;
  },
}));

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.toastAdd } }));
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
vi.mock("../presentation/ScientTooltip", () => ({
  ScientTooltip: (props: { children: ReactElement }) => props.children,
}));
vi.mock("../rightPanel/surfaces", () => ({
  scientGeneratedPdfSurface: (source: unknown) => ({ module: "generated-pdf", source }),
}));
vi.mock("./pdfSaveCopyNotification", () => ({
  announcePdfSaveCopyResult: mocks.announceSave,
}));
vi.mock("./usePdfSaveCopy", () => ({ usePdfSaveCopy: () => mocks.savePdfCopy }));

import { ScientPreviewExportActions } from "./ScientPreviewExportActions";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;

const generatedSource = {
  _tag: "generated-pdf" as const,
  authority: "environment-1",
  logicalDocumentKey: "browser-export:published",
  title: "Live report",
  fileName: "Live report.pdf",
  capabilities: { canSaveCopy: true, canRevealSource: false },
  artifactId: "artifact-1",
  revisionId: "revision-1",
  bindingGeneration: 1,
  bindingStatus: "current" as const,
  staleReason: null,
  pageCount: 2,
};

describe("ScientPreviewExportActions", () => {
  beforeEach(() => {
    mocks.menuClicks = {};
    mocks.announceSave.mockReset();
    mocks.exportPdf.mockReset();
    mocks.openScient.mockReset();
    mocks.publish.mockReset();
    mocks.savePdfCopy.mockReset();
    mocks.toastAdd.mockReset();
    mocks.updateScientGeneratedPdf.mockReset();
  });

  it("publishes the exact live page and opens the generated PDF", async () => {
    mocks.exportPdf.mockResolvedValue({
      data: new Uint8Array([37, 80, 68, 70]),
      sourceUrl:
        "http://127.0.0.1:16491/api/assets/renewable-token/live-report.html?secret=value#page",
      title: "Live report",
      profile: "document-layout",
      media: "print",
      warnings: [],
      sourceSignals: {
        bodyTextLength: 120,
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

    renderToStaticMarkup(
      <ScientPreviewExportActions
        disabled={false}
        pageUrl="http://example.com/report"
        tabId="tab-1"
        runtimeTabId="runtime-tab-1"
        threadRef={threadRef}
      />,
    );
    mocks.menuClicks.open?.({} as never);
    mocks.menuClicks.open?.({} as never);

    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledOnce());
    expect(mocks.exportPdf).toHaveBeenCalledOnce();
    expect(mocks.exportPdf).toHaveBeenCalledWith("runtime-tab-1");
    expect(mocks.publish).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: expect.objectContaining({
        operationId: "browser-export-operation-1",
        producerId: "browser.export",
        sourceUrl: "http://127.0.0.1:16491/api/assets/%3Csigned%3E/live-report.html",
        title: "Live report",
      }),
    });
    expect(mocks.openScient).toHaveBeenCalledWith(threadRef, {
      module: "generated-pdf",
      source: generatedSource,
    });
    expect(mocks.toastAdd).toHaveBeenCalledWith({
      type: "success",
      title: "PDF exported",
      data: { compact: true, dismissAfterVisibleMs: 2_500 },
    });
  });

  it("saves through the existing PDF copy flow without opening the reader", async () => {
    mocks.exportPdf.mockResolvedValue({
      data: new Uint8Array([37, 80, 68, 70]),
      sourceUrl: "http://example.com/report",
      title: "Live report",
      profile: "document-layout",
      media: "print",
      warnings: ["Canvas content was flattened"],
      sourceSignals: {
        bodyTextLength: 120,
        imageCount: 0,
        brokenImageCount: 0,
        canvasCount: 1,
        videoCount: 0,
        iframeCount: 0,
        scrollWidth: 800,
        scrollHeight: 1_200,
      },
    });
    mocks.publish.mockResolvedValue({
      _tag: "Success",
      value: {
        source: generatedSource,
        receipt: { warnings: ["Canvas content was flattened"] },
      },
    });
    const saveResult = { _tag: "saved" as const, path: "/tmp/Live report.pdf" };
    mocks.savePdfCopy.mockResolvedValue(saveResult);

    renderToStaticMarkup(
      <ScientPreviewExportActions
        disabled={false}
        pageUrl="http://example.com/report"
        tabId="tab-1"
        runtimeTabId="runtime-tab-1"
        threadRef={threadRef}
      />,
    );
    mocks.menuClicks.save?.({} as never);

    await vi.waitFor(() => expect(mocks.savePdfCopy).toHaveBeenCalledWith(generatedSource));
    expect(mocks.openScient).not.toHaveBeenCalled();
    expect(mocks.updateScientGeneratedPdf).toHaveBeenCalledWith(
      threadRef,
      expect.objectContaining({ source: generatedSource }),
    );
    expect(mocks.announceSave).toHaveBeenCalledWith(saveResult, {
      warnings: ["Canvas content was flattened"],
    });
  });

  it("keeps the chrome action disabled when the browser surface is unavailable", () => {
    const markup = renderToStaticMarkup(
      <ScientPreviewExportActions
        disabled
        pageUrl="http://example.com/report"
        tabId="tab-1"
        runtimeTabId="runtime-tab-1"
        threadRef={threadRef}
      />,
    );

    expect(markup).toContain('aria-label="Export PDF"');
    expect(markup).toContain("disabled");
  });

  it("reports renderer failures without opening a document surface", async () => {
    mocks.exportPdf.mockRejectedValue(new Error("Chromium could not print the page."));

    renderToStaticMarkup(
      <ScientPreviewExportActions
        disabled={false}
        pageUrl="http://example.com/report"
        tabId="tab-1"
        runtimeTabId="runtime-tab-1"
        threadRef={threadRef}
      />,
    );
    mocks.menuClicks.open?.({} as never);

    await vi.waitFor(() =>
      expect(mocks.toastAdd).toHaveBeenCalledWith({
        type: "error",
        title: "Unable to export PDF",
        description: "Chromium could not print the page.",
      }),
    );
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.openScient).not.toHaveBeenCalled();
  });
});
