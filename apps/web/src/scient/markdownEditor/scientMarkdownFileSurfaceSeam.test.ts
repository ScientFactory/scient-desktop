// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited file-panel seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const panelSource = NodeFS.readFileSync(
  new URL("../../components/files/FilePreviewPanel.tsx", import.meta.url),
  "utf8",
);
const surfaceSource = NodeFS.readFileSync(
  new URL("./ScientMarkdownFileSurface.tsx", import.meta.url),
  "utf8",
);
const browserSource = NodeFS.readFileSync(
  new URL("../../components/files/FileBrowserPanel.tsx", import.meta.url),
  "utf8",
);

describe("Scient Markdown file-preview seam", () => {
  it("lazily mounts exactly one owned editor and removes the old ChatMarkdown preview path", () => {
    expect(panelSource).toContain('import("~/scient/markdownEditor/ScientMarkdownFileSurface")');
    expect(panelSource.match(/<ScientMarkdownFileSurface\b/gu)).toHaveLength(1);
    expect(panelSource.match(/<ScientMarkdownSaveStatus\b/gu)).toHaveLength(1);
    expect(panelSource).not.toContain("RenderedMarkdownSurface");
    expect(panelSource).not.toContain("resolveMarkdownTaskPreviewUpdate");
  });

  it("keeps parsing, editor state, and persistence policy out of the inherited panel", () => {
    expect(panelSource).not.toMatch(/ProseMirror|CodeMirror|MarkdownSaveQueue|MarkdownParser/gu);
    expect(surfaceSource).toContain("projectEnvironment.writeFile");
    expect(surfaceSource).toContain("expectedRevision: intent.expectedRevision");
    expect(surfaceSource).toContain("confirmProjectFileQueryData(");
  });

  it("carries the existing conflict-resolution and line-reveal seams into the owned editor", () => {
    for (const prop of [
      "saveResolution={",
      "onSaveResolutionApplied={handleSaveResolutionApplied}",
      "revealLine={revealLine}",
      "revealRequestId={revealRequestId}",
    ]) {
      expect(panelSource).toContain(prop);
    }
  });

  it("limits workspace lifecycle UI to one owned create and rename mount", () => {
    expect(browserSource.match(/<ScientMarkdownCreateButton\b/gu)).toHaveLength(1);
    expect(panelSource.match(/<ScientMarkdownRenameButton\b/gu)).toHaveLength(1);
    expect(browserSource).not.toContain("createOnly: true");
    expect(panelSource).not.toContain("projects.renameFile");
  });
});
