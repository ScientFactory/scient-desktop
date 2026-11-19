// @effect-diagnostics nodeBuiltinImport:off -- static audit for the inherited viewer seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

describe("Scient file surface seams", () => {
  // regression: eed0733208 feat(compute): implement Phase 4 scientific workflow
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
    const controls = NodeFS.readFileSync(
      new URL("../compute/ComputeSessionControls.tsx", import.meta.url),
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
    expect(controls).toContain("Interrupt running code and keep session state");
    expect(controls).toContain("Restart session");
    expect(controls).toContain("Stop session");
    expect(results).not.toContain("<Pause");
    expect(results).toContain('aria-label="All sessions"');
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

  it("routes inherited TIFF decoding to Scient's range-reading decoder", () => {
    const decoder = NodeFS.readFileSync(
      new URL("../../components/files/decodeImagePreview.ts", import.meta.url),
      "utf8",
    );
    const viewer = NodeFS.readFileSync(
      new URL("../../components/files/PreviewImageContent.tsx", import.meta.url),
      "utf8",
    );
    expect(decoder).toMatch(/if \(!heif\) return await decodeScientTiffPreview\(src, signal\);/u);
    expect(viewer).toContain("useTiffPreview({");
    expect(viewer).toContain("<TiffPreviewSummary");
  });
});
