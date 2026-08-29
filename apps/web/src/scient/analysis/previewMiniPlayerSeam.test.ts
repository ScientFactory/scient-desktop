// @effect-diagnostics nodeBuiltinImport:off -- static audit for the inherited preview seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

const readSource = (relativePath: string) =>
  NodeFS.readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("analysis preview mini-player seam", () => {
  it("keeps the shared floating preview generic while preserving its reusable chrome", () => {
    const componentSource = readSource("../../components/preview/ThreadPreviewMiniPlayer.tsx");
    const imageSurfaceSource = readSource("../../components/preview/PreviewImageSurface.tsx");
    const assetImageSurfaceSource = readSource(
      "../../components/preview/StaticAssetImageSurface.tsx",
    );
    const layoutSource = readSource("../../components/preview/previewMiniPlayerLayout.ts");
    const storeSource = readSource("../../previewMiniPlayerStore.ts");
    const descriptorSource = readSource("../../previewStaticImageSurface.ts");
    const sharedSources = [
      componentSource,
      imageSurfaceSource,
      assetImageSurfaceSource,
      layoutSource,
      storeSource,
      descriptorSource,
    ].join("\n");

    expect(sharedSources).not.toMatch(
      /~\/scient\/|@scientfactory\/analysis|matlab|AnalysisArtifact|figure-\d/iu,
    );
    expect(componentSource.match(/<BrowserSurfaceSlot/gu)).toHaveLength(1);
    expect(componentSource.match(/<StaticAssetImageSurface/gu)).toHaveLength(1);
    expect(componentSource.match(/aria-label="Open preview in right panel"/gu)).toHaveLength(1);
    expect(componentSource).toContain('className="pointer-events-none fixed z-[45] select-none"');
    expect(componentSource.match(/<PictureInPicture2/gu)).toHaveLength(1);
    expect(storeSource).toContain('kind: "browser"');
    expect(storeSource).toContain('kind: "static-artifact"');
    expect(componentSource).toContain('content.kind === "static-artifact"');
    expect(layoutSource).toContain("PreviewMiniPlayerResizeDirection");
  });
});
