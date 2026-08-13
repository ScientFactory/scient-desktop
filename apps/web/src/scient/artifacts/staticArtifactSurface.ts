import type {
  AnalysisArtifact,
  AnalysisArtifactRepresentation,
  AnalysisRunSnapshot,
  AnalysisRunSummary,
} from "@t3tools/contracts";

import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";

type AnalysisRun = AnalysisRunSnapshot | AnalysisRunSummary;

export function staticArtifactSurfaceId(input: {
  readonly projectId: string;
  readonly sourcePath: string;
  readonly artifactId: string;
}): string {
  return [input.projectId, input.sourcePath, input.artifactId].map(encodeURIComponent).join(":");
}

export function createStaticArtifactSurfaceDescriptor(
  run: AnalysisRun,
  artifact: AnalysisArtifact,
  representation: AnalysisArtifactRepresentation,
): PreviewStaticImageSurfaceDescriptor | null {
  if (representation.mediaType !== "image/png" && representation.mediaType !== "image/svg+xml") {
    return null;
  }
  const resource = {
    _tag: "analysis-artifact",
    projectId: run.projectId,
    runId: run.receipt.runId,
    artifactId: artifact.artifactId,
    representationId: representation.representationId,
  } as const;
  return {
    surfaceId: staticArtifactSurfaceId({
      projectId: run.projectId,
      sourcePath: run.source.relativePath,
      artifactId: artifact.artifactId,
    }),
    label: artifact.label,
    fileName: representation.fileName,
    mediaType: representation.mediaType,
    sourcePath: run.source.relativePath,
    resource,
  };
}
