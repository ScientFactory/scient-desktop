// @effect-diagnostics nodeBuiltinImport:off -- static audit for inherited UI seams.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

const readSource = (relativePath: string): string =>
  NodeFS.readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("Scient split seams", () => {
  // regression: dff1da7e13 fix(web): align LaTeX split interaction
  it("keeps inherited UI independent while aligning separator chrome", () => {
    const separator = readSource("./ResizeSeparator.tsx");
    const rightPanelHandle = readSource("../../components/preview/RightPanelResizeHandle.tsx");

    expect(separator).not.toMatch(/~\/scient\//u);
    expect(rightPanelHandle).not.toMatch(/~\/scient\//u);
    expect(rightPanelHandle).not.toContain("ResizeSeparator");
    for (const visualToken of [
      "cursor-platform-col-resize",
      "inset-y-0 left-1/2 w-px",
      "group-hover:bg-border",
      "group-active:bg-primary/60",
    ]) {
      expect(separator).toContain(visualToken);
      expect(rightPanelHandle).toContain(visualToken);
    }
    expect(separator).toContain("cursor-platform-row-resize");
    expect(separator).toContain("inset-x-0 top-1/2 h-px");
    expect(separator).not.toContain("-translate-x-1/2");
    expect(separator).not.toContain("-translate-y-1/2");
    expect(rightPanelHandle).not.toContain("-translate-x-1/2");
  });

  // regression: 017821d992 fix(web): improve platform cursor behavior (#301)
  it("preserves barred resize cursors except on Windows", () => {
    // The app stylesheet and the Scient stylesheet it imports for these cursors.
    const appStyles = [
      readSource("../../index.css"),
      readSource("../presentation/scient-platform-cursors.css"),
    ].join("\n");

    expect(appStyles).toMatch(/\.cursor-platform-col-resize\s*\{\s*cursor: col-resize;/u);
    expect(appStyles).toMatch(/\.cursor-platform-row-resize\s*\{\s*cursor: row-resize;/u);
    expect(appStyles).toMatch(
      /\.electron-windows \.cursor-platform-col-resize\s*\{\s*cursor: ew-resize;/u,
    );
    expect(appStyles).toMatch(
      /\.electron-windows \.cursor-platform-row-resize\s*\{\s*cursor: ns-resize;/u,
    );
  });

  // regression: 017821d992 fix(web): improve platform cursor behavior (#301)
  it("uses platform-aware cursors for the complete split drag", () => {
    const split = readSource("./useScientSplit.ts");

    expect(split).toContain("resizeCursorForPlatform(");
    expect(split).toContain('axis === "y" ? "vertical" : "horizontal"');
  });

  // regression: dff1da7e13 fix(web): align LaTeX split interaction
  it("keeps the LaTeX split on the shared Scient-owned behavior", () => {
    const surface = readSource("../latex/ScientLatexSurface.tsx");

    expect(surface).toContain("useScientSplit");
    expect(surface).toContain("ResizeSeparator");
    expect(surface).toContain("LATEX_SPLIT_RATIO_STORAGE_KEY");
    expect(surface).not.toContain("RightPanelResizeHandle");
    expect(surface).not.toContain("scient-latex-divider");
  });

  // regression: eed0733208 feat(compute): implement Phase 4 scientific workflow
  it("shares fractional behavior between Python and LaTeX without sharing their storage", () => {
    const python = readSource("../compute/ScientComputeFileSurface.tsx");
    const latex = readSource("../latex/ScientLatexSurface.tsx");

    expect(python).toContain("useScientSplit");
    expect(latex).toContain("useScientSplit");
    expect(python).toContain("COMPUTE_FILE_SPLIT_STORAGE_KEY");
    expect(latex).toContain("LATEX_SPLIT_RATIO_STORAGE_KEY");
    expect(python).not.toContain("RightPanelResizeHandle");
    expect(latex).not.toContain("scient-latex-divider");
  });

  // regression: 3af6b42581 feat(compute): add stacked results layout
  it("wires the Python stacked layout through the shared split behavior", () => {
    const python = readSource("../compute/ScientComputeFileSurface.tsx");

    expect(python).toContain('splitLayout === "stacked" ? "y" : "x"');
    expect(python).toContain('isStacked ? "flex-col" : "flex-row"');
    expect(python).toContain('orientation={isStacked ? "horizontal" : "vertical"}');
    expect(python).toContain('isStacked ? "border-t border-border" : "border-l border-border"');
    expect(python).toContain('isStacked ? "inset-x-0 -top-1" : "inset-y-0 -left-1"');
    expect(python).toContain("COMPUTE_FILE_SPLIT_LAYOUT_STORAGE_KEY");
  });
});
