// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited document PDF export mounts.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const read = (relativePath: string) =>
  NodeFS.readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("document PDF export seams", () => {
  it("keeps the desktop host mount narrow and ahead of browser session work", () => {
    const host = read("./documentHost.tsx");
    expect(host).toContain('case "documentPagePdfRender"');
    expect(host).toContain("renderDocumentPagePdfForHost(httpBaseUrl, request.input)");
    expect(host).not.toContain("needsPreviewAutomationSessionSync");
    expect(host).not.toContain("renderDocumentPagePdf!(");
  });

  it("keeps capture, validation, and publication out of the inherited server files", () => {
    const ws = [
      read("../../../../server/src/ws.ts"),
      read("../../../../server/src/scient/documentExport/DocumentPdfRpcHandlers.ts"),
    ].join("\n");
    expect(ws).toContain("prepareMarkdownPdf(input)");
    expect(ws).toContain("publishCapturedDocumentPdf(input)");
    expect(ws).not.toMatch(/scientDocumentReadinessRejection|writeDocumentCapture|DocumentBundle/u);
  });

  it("serves the document page as its own entry, not through the app shell", () => {
    const viteConfig = read("../../../vite.config.ts");
    const entry = read("../../../scient-document.html");
    expect(viteConfig).toContain('"scient-document"');
    expect(entry).toContain("/src/scient/documentPage/main.tsx");
    expect(entry).not.toContain("bootstrap");
  });

  it("keeps the renderer in Scient-owned desktop modules with one IPC mount", () => {
    const handlers = read("../../../../desktop/src/ipc/DesktopIpcHandlers.ts");
    const manager = read("../../../../desktop/src/preview/Manager.ts");
    expect(handlers).toContain("yield* ipc.handle(renderDocumentPagePdf);");
    expect(manager).not.toContain("DocumentPagePdfRenderer");
    expect(
      NodeFS.existsSync(
        new URL(
          "../../../../desktop/src/scient/documentExport/DocumentPagePdfRenderer.ts",
          import.meta.url,
        ),
      ),
    ).toBe(true);
  });
});
