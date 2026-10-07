import type { ScopedThreadRef } from "@t3tools/contracts";
import { lazy, Suspense, useMemo } from "react";

import type { PreviewMiniPlayerState } from "~/previewMiniPlayerStore";
import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";
import type { RightPanelSurface } from "~/rightPanelStore";

const ComputeFigureFollower = lazy(() =>
  import("./ComputeFigureFollower").then((module) => ({
    default: module.ComputeFigureFollower,
  })),
);

/** The static figures open in the right panel or the floating preview, once each. */
export function useOpenStaticArtifacts(
  surfaces: ReadonlyArray<RightPanelSurface>,
  activePreviewMiniPlayer: PreviewMiniPlayerState | null,
): ReadonlyArray<PreviewStaticImageSurfaceDescriptor> {
  return useMemo(() => {
    const bySurfaceId = new Map<string, PreviewStaticImageSurfaceDescriptor>();
    for (const surface of surfaces) {
      if (surface.kind === "scient" && surface.module === "artifact") {
        bySurfaceId.set(surface.artifact.surfaceId, surface.artifact);
      }
    }
    if (activePreviewMiniPlayer?.content.kind === "static-artifact") {
      const artifact = activePreviewMiniPlayer.content.artifact;
      bySurfaceId.set(artifact.surfaceId, artifact);
    }
    return [...bySurfaceId.values()];
  }, [activePreviewMiniPlayer, surfaces]);
}

/** Keeps open compute figures current while the thread's workspace is known. */
export function ScientComputeFigureFollower(input: {
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeWorkspaceRoot: string | undefined;
  readonly openStaticArtifacts: ReadonlyArray<PreviewStaticImageSurfaceDescriptor>;
}) {
  const { activeThreadRef, activeWorkspaceRoot, openStaticArtifacts } = input;
  return activeThreadRef && activeWorkspaceRoot && openStaticArtifacts.length > 0 ? (
    <Suspense fallback={null}>
      <ComputeFigureFollower
        artifacts={openStaticArtifacts}
        cwd={activeWorkspaceRoot}
        environmentId={activeThreadRef.environmentId}
        threadRef={activeThreadRef}
      />
    </Suspense>
  ) : null;
}
