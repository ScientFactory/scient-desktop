// @effect-diagnostics nodeBuiltinImport:off -- static audit for the inherited viewer seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

describe("Scient file surface seams", () => {
  it("keeps additive Scient behavior mounted without leaking runtime logic into the viewer", () => {
    const source = NodeFS.readFileSync(
      new URL("../../components/files/FilePreviewPanel.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("ScientFileAuxiliarySurface");
    expect(source).toContain("ScientComputeFileSurface");
    expect(source.match(/<ScientComputeFileSurface/gu)).toHaveLength(1);
    expect(source.match(/useWorkspaceFileRefresh\(/gu)).toHaveLength(1);
    expect(source).not.toMatch(/-batch|AnalysisRunFilePanel/iu);
    expect(source).not.toContain("matlabOneShotVisible");
  });

  it("places batch in the same Results surface without another execution panel", () => {
    const auxiliary = NodeFS.readFileSync(
      new URL("../compute/ScientComputeFileSurface.tsx", import.meta.url),
      "utf8",
    );
    expect(auxiliary).toContain("showingBatch");
    expect(auxiliary).toContain("<ComputeBatchResults");
    expect(auxiliary).not.toContain("AnalysisRunFilePanel");
  });

  it("keeps Python execution controls in the Scient-owned file surface", () => {
    const surface = NodeFS.readFileSync(
      new URL("../compute/ScientComputeFileSurface.tsx", import.meta.url),
      "utf8",
    );
    const results = NodeFS.readFileSync(
      new URL("../compute/ComputePanel.tsx", import.meta.url),
      "utf8",
    );
    const output = NodeFS.readFileSync(
      new URL("../compute/ComputeOutputView.tsx", import.meta.url),
      "utf8",
    );
    const artifactActions = NodeFS.readFileSync(
      new URL("../artifacts/staticArtifactViewerActions.ts", import.meta.url),
      "utf8",
    );
    const figure = NodeFS.readFileSync(
      new URL("../compute/ComputeFigure.tsx", import.meta.url),
      "utf8",
    );

    expect(surface).toContain("ComputeFileActions");
    expect(surface).toContain("COMPUTE_FILE_VIEWS");
    expect(surface).toContain("ComputePanel");
    expect(results).not.toMatch(/<Textarea|Run code in this session/gu);
    expect(results).not.toMatch(/Code that ran|request\.code|revision\.slice/gu);
    expect(results).toContain("mergeComputeOutputs");
    expect(results).toContain("Interrupt running code and keep session state");
    expect(results).toContain("Restart session");
    expect(results).toContain("Stop session");
    expect(results).not.toContain("<Pause");
    expect(results).toContain('aria-label="Compute session history"');
    expect(results).toContain("MenuRadioGroup");
    expect(results).toContain('role="tablist"');
    expect(results).toContain('aria-label="Compute view"');
    expect(results).not.toContain("setVariablesOpen");
    expect(results).not.toContain("showVariablesTab");
    expect(output).toContain("<ComputeFigure");
    expect(figure).toContain("useAssetUrlState");
    expect(figure).toContain("<img");
    expect(figure).toContain("ScientImageActionMenu");
    expect(figure).toContain("copyStaticImage");
    expect(figure).toContain("downloadStaticImage");
    expect(figure).toContain("openStaticArtifactInPanel");
    expect(figure).toContain("toggleStaticArtifactFloating");
    expect(artifactActions).toContain("openScientArtifact");
  });
});
