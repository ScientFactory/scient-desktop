// @effect-diagnostics nodeBuiltinImport:off -- static audit for inherited UI seams.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

const readSource = (relativePath: string): string =>
  NodeFS.readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("Scient split seams", () => {
  it("keeps the inherited resize handle and the Scient separator independent", () => {
    const separator = readSource("./ResizeSeparator.tsx");
    const rightPanelHandle = readSource("../../components/preview/RightPanelResizeHandle.tsx");

    expect(separator).not.toMatch(/~\/scient\//u);
    expect(rightPanelHandle).not.toMatch(/~\/scient\//u);
    expect(rightPanelHandle).not.toContain("ResizeSeparator");
  });

  it("keeps the Python and LaTeX splits on the shared Scient-owned behavior", () => {
    const python = readSource("../compute/ScientComputeFileSurface.tsx");
    const latex = readSource("../latex/ScientLatexSurface.tsx");

    for (const surface of [python, latex]) {
      expect(surface).toContain("useScientSplit");
      expect(surface).not.toContain("RightPanelResizeHandle");
    }
    expect(latex).toContain("ResizeSeparator");
    expect(latex).not.toContain("scient-latex-divider");
  });
});
