// @effect-diagnostics nodeBuiltinImport:off -- static audit for the inherited preview seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

const readSource = (relativePath: string) =>
  NodeFS.readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("analysis preview mini-player seam", () => {
  it("keeps the shared floating preview free of Scient analysis code", () => {
    // The inherited player and the Scient parts its marked lines call.
    const componentSource = [
      readSource("../../components/preview/ThreadPreviewMiniPlayer.tsx"),
      readSource("../../components/preview/ScientMiniPlayerParts.tsx"),
    ].join("\n");
    const imageSurfaceSource = readSource("../../components/preview/PreviewImageSurface.tsx");
    const assetImageSurfaceSource = readSource(
      "../../components/preview/StaticAssetImageSurface.tsx",
    );
    const layoutSource = readSource("../../components/preview/previewMiniPlayerLayout.ts");
    // The inherited store and the Scient artifact reducers its marked lines call.
    const storeSource = [
      readSource("../../previewMiniPlayerStore.ts"),
      readSource("../../scientPreviewMiniPlayerArtifacts.ts"),
    ].join("\n");
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
  });
});
