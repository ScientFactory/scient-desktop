// @effect-diagnostics nodeBuiltinImport:off -- static audit for the inherited viewer seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

describe("Scient file auxiliary surface seam", () => {
  it("keeps MATLAB and execution behavior out of the inherited file viewer", () => {
    const source = NodeFS.readFileSync(
      new URL("../../components/files/FilePreviewPanel.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("ScientFileAuxiliarySurface");
    expect(source.match(/<ScientFileAuxiliarySurface/gu)).toHaveLength(1);
    expect(source).not.toMatch(/matlab|-batch|AnalysisRunFilePanel/iu);
  });
});
