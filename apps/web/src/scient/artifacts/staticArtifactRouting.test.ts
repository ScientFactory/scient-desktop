// @effect-diagnostics nodeBuiltinImport:off -- static ownership audit for the viewer boundary.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

const readSource = (relativePath: string) =>
  NodeFS.readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("direct static artifact routing", () => {
  it("routes static images before browser-session preparation", () => {
    const stripSource = readSource("../analysis/AnalysisArtifactStrip.tsx");
    const staticBranch = stripSource.indexOf("if (staticArtifact)");
    const browserOpen = stripSource.indexOf("const result = await openPreview", staticBranch);
    const browserPreparation = stripSource.indexOf(
      "if (!isPreviewSupportedInRuntime())",
      staticBranch,
    );

    expect(staticBranch).toBeGreaterThan(-1);
    expect(browserOpen).toBeGreaterThan(staticBranch);
    expect(browserPreparation).toBeGreaterThan(staticBranch);
    const directBranch = stripSource.slice(staticBranch, browserPreparation);
    expect(directBranch).toContain("openScientArtifact");
    expect(directBranch).toContain("openArtifact");
    expect(directBranch).not.toContain("createUrl(");
  });

  it("keeps the direct image renderers independent of browser sessions", () => {
    const panelSource = readSource("./ScientArtifactPreview.tsx");
    const assetImageSource = readSource("../../components/preview/StaticAssetImageSurface.tsx");
    const directSources = `${panelSource}\n${assetImageSource}`;

    expect(directSources).toContain("StaticAssetImageSurface");
    expect(directSources).toContain("useAssetUrlState");
    expect(directSources).not.toMatch(/BrowserSurfaceSlot|previewEnvironment|openPreviewSession/gu);
  });
});
