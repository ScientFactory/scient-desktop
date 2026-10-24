// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited Browser export mounts.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const read = (relativePath: string) =>
  NodeFS.readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("browser PDF export seams", () => {
  it("keeps browser export orchestration out of the inherited preview chrome", () => {
    const previewView = read("../../components/preview/PreviewView.tsx");
    const previewChrome = read("../../components/preview/PreviewChromeRow.tsx");

    expect(previewView).toContain("<ScientPreviewExportActions");
    expect(previewView).not.toMatch(/Encoding|LogicalDocumentKey|publishBrowserPdfExport/gu);
    expect(previewChrome).not.toMatch(
      /Export PDF|FileDown|onExportPdf|exportingPdf|contentActions/gu,
    );
  });

  it("keeps server publication behind one inherited RPC mount", () => {
    const ws = [
      read("../../../../server/src/ws.ts"),
      read("../../../../server/src/scient/documentExport/DocumentPdfRpcHandlers.ts"),
    ].join("\n");

    expect(ws).toContain("publishBrowserPdfExport(generatedDocuments, input)");
    expect(ws).not.toMatch(/decodeBase64Url|BROWSER_PDF_EXPORT_MAX_BYTES|validationContext/gu);
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
    expect(manager).toContain("render: controlledDocumentPdfRenderer");
    expect(manager).not.toMatch(/PAGINATION_CSS|wc\.printToPDF|waitForReadiness/gu);
    expect(electronDialog).not.toMatch(/saveFile|showSaveDialog/gu);
    expect(NodeFS.existsSync(rendererUrl)).toBe(true);
    expect(NodeFS.existsSync(oldRendererUrl)).toBe(false);
  });

  it("keeps browser fallback bytes out of the inherited local API facade", () => {
    const localApi = read("../../localApi.ts");

    expect(localApi).toContain("saveAssetCopyInBrowser(request)");
    expect(localApi).not.toMatch(/createObjectURL|response\.blob|document\.createElement/gu);
  });
});
