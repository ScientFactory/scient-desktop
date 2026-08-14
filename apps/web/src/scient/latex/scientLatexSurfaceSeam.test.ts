// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited file-panel seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const panelSource = NodeFS.readFileSync(
  new URL("../../components/files/FilePreviewPanel.tsx", import.meta.url),
  "utf8",
);
const surfaceSource = NodeFS.readFileSync(
  new URL("./ScientLatexSurface.tsx", import.meta.url),
  "utf8",
);

function mountedPropNames(): ReadonlyArray<string> {
  const mount = panelSource.match(/<ScientLatexSurface\b([\s\S]*?)\/>/u);
  if (!mount?.[1]) throw new Error("FilePreviewPanel no longer mounts ScientLatexSurface.");
  return [...mount[1].matchAll(/(\w+)=\{/gu)]
    .map((match) => match[1] ?? "")
    .filter((name) => name !== "key");
}

function declaredPropNames(): ReadonlyArray<string> {
  const declaration = surfaceSource.match(/interface ScientLatexSurfaceProps \{([\s\S]*?)\n\}/u);
  if (!declaration?.[1]) throw new Error("ScientLatexSurface no longer declares its props.");
  return [...declaration[1].matchAll(/readonly (\w+):/gu)].map((match) => match[1] ?? "");
}

describe("Scient LaTeX file-preview seam", () => {
  it("lazily mounts the surface for LaTeX paths only", () => {
    expect(panelSource).toContain('import("~/scient/latex/ScientLatexSurface")');
    expect(panelSource).toContain("default: module.ScientLatexSurface,");
    expect(panelSource).toContain("isLatexPreviewFile(relativePath)");
    expect(panelSource.match(/<ScientLatexSurface\b/gu)).toHaveLength(1);
  });

  it("passes exactly the props the surface declares", () => {
    expect([...mountedPropNames()].sort()).toEqual([...declaredPropNames()].sort());
  });

  it("hands the surface the save bindings the panel's own editor mount gets", () => {
    // Without these the surface's editor cannot resolve a revision conflict:
    // the coordinator refuses to advance and the panel's reload notice buttons
    // have nothing to act on.
    expect(mountedPropNames()).toEqual(
      expect.arrayContaining([
        "revision",
        "saveResolution",
        "onSaveConfirmed",
        "onSaveFailure",
        "onSaveResolutionApplied",
      ]),
    );
  });

  it("reuses the panel's editable surface instead of forking it", () => {
    expect(panelSource).toMatch(/^export function EditableFileSurface\(/mu);
    expect(surfaceSource).toMatch(
      /import \{ EditableFileSurface \} from "~\/components\/files\/FilePreviewPanel"/u,
    );
    // The forked copy carried its own editor, save coordinator, and comment
    // wiring. Any of them reappearing here is that fork growing back.
    expect(surfaceSource).not.toMatch(/new FileSaveCoordinator/u);
    expect(surfaceSource).not.toMatch(/new Editor</u);
    expect(surfaceSource).not.toMatch(/useProjectFileQuery/u);
  });

  it("keeps the LaTeX surface off the chat markdown pipeline", () => {
    expect(surfaceSource).not.toMatch(/ChatMarkdown/u);
    expect(surfaceSource).not.toMatch(/from "~\/components\/ChatMarkdown"/u);
  });

  it("exports only the Scient-owned surface", () => {
    const exported = [...surfaceSource.matchAll(/^export (?:function|const|class) (\w+)/gmu)].map(
      (match) => match[1],
    );
    expect(exported).toEqual(["ScientLatexSurface"]);
    expect(surfaceSource).not.toMatch(/^export default/mu);
    expect(surfaceSource).not.toMatch(/^export \{/mu);
  });
});
