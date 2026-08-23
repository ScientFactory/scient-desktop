// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited Browser export mounts.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const read = (relativePath: string) =>
  NodeFS.readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("browser PDF export seams", () => {
  it("keeps browser export orchestration in Scient-owned modules", () => {
    const previewView = read("../../components/preview/PreviewView.tsx");
    const previewChrome = read("../../components/preview/PreviewChromeRow.tsx");
    const action = read("./ScientPreviewExportActions.tsx");
    const exportHook = read("../documentExport/useBrowserPdfExport.ts");

    expect(previewView).toContain("<ScientPreviewExportActions");
    expect(previewView).toContain("trailingActions={");
    expect(previewView).not.toMatch(/Encoding|LogicalDocumentKey|publishBrowserPdfExport/gu);
    expect(previewChrome).not.toMatch(
      /Export PDF|FileDown|onExportPdf|exportingPdf|contentActions/gu,
    );
    expect(action).toContain("useBrowserPdfExport()");
    expect(action).toContain("Open PDF");
    expect(action).toContain("Save PDF…");
    expect(action).toContain("usePdfSaveCopy(");
    expect(exportHook).toContain("bridge.exportPdf(");
    expect(exportHook).toContain("browserPdfExportEnvironment.publish");
  });

  it("keeps server publication behind one inherited RPC mount", () => {
    const ws = read("../../../../server/src/ws.ts");
    const publication = read(
      "../../../../server/src/scient/documentArtifacts/BrowserPdfExportPublication.ts",
    );

    expect(ws).toContain("publishBrowserPdfExport(generatedDocuments, input)");
    expect(ws).not.toMatch(/decodeBase64Url|BROWSER_PDF_EXPORT_MAX_BYTES|validationContext/gu);
    expect(publication).toMatch(/generatedDocuments\s*\.\s*publishPdf\(\{/u);
    expect(publication).toContain('validationProfile: "browser-export"');
  });

  it("keeps rendering and Save Copy implementation outside inherited desktop services", () => {
    const manager = read("../../../../desktop/src/preview/Manager.ts");
    const electronDialog = read("../../../../desktop/src/electron/ElectronDialog.ts");
    const rendererUrl = new URL(
      "../../../../desktop/src/scient/documentExport/BrowserPdfRenderer.ts",
      import.meta.url,
    );
    const oldRendererUrl = new URL(
      "../../../../desktop/src/preview/BrowserPdfRenderer.ts",
      import.meta.url,
    );

    expect(manager).toContain("../scient/documentExport/BrowserPdfRenderer.ts");
    expect(manager).not.toMatch(/PAGINATION_CSS|wc\.printToPDF|waitForReadiness/gu);
    expect(electronDialog).not.toMatch(/saveFile|showSaveDialog/gu);
    expect(NodeFS.existsSync(rendererUrl)).toBe(true);
    expect(NodeFS.existsSync(oldRendererUrl)).toBe(false);
  });

  it("keeps browser fallback bytes out of the inherited local API facade", () => {
    const localApi = read("../../localApi.ts");
    const fallback = read("../documentArtifacts/browserAssetCopy.ts");

    expect(localApi).toContain("saveAssetCopyInBrowser(request)");
    expect(localApi).not.toMatch(/createObjectURL|response\.blob|document\.createElement/gu);
    expect(fallback).toContain("URL.createObjectURL(await response.blob())");
  });

  it("shares native Save Copy and reveal presentation across browser and reader entry points", () => {
    const action = read("./ScientPreviewExportActions.tsx");
    const reader = read("./ScientPdfReader.tsx");
    const notification = read("./pdfSaveCopyNotification.ts");

    expect(action).toContain("announcePdfSaveCopyResult(saveResult");
    expect(reader).toContain("announcePdfSaveCopyResult(result)");
    expect(notification).toContain("documents.revealSavedAsset");
    expect(notification).toContain("revealSavedAsset(result.path)");
  });
});
