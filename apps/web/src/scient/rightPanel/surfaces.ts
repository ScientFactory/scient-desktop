import {
  isPreviewStaticImageSurfaceDescriptor,
  type PreviewStaticImageSurfaceDescriptor,
} from "~/previewStaticImageSurface";

export type ScientRightPanelSurface =
  | { readonly id: "scient:sources"; readonly kind: "scient"; readonly module: "sources" }
  | {
      readonly id: `scient:source-pdf:${string}`;
      readonly kind: "scient";
      readonly module: "source-pdf";
      readonly attachmentId: string;
      readonly fileName: string;
    }
  | {
      readonly id: `scient:artifact:${string}`;
      readonly kind: "scient";
      readonly module: "artifact";
      readonly artifact: PreviewStaticImageSurfaceDescriptor;
    };

export function scientSourcesSurface(): Extract<ScientRightPanelSurface, { module: "sources" }> {
  return { id: "scient:sources", kind: "scient", module: "sources" };
}

export function scientSourcePdfSurface(input: {
  readonly attachmentId: string;
  readonly fileName: string;
}): Extract<ScientRightPanelSurface, { module: "source-pdf" }> {
  return {
    id: `scient:source-pdf:${encodeURIComponent(input.attachmentId)}`,
    kind: "scient",
    module: "source-pdf",
    attachmentId: input.attachmentId,
    fileName: input.fileName,
  };
}

export function scientArtifactSurfaceId(
  artifact: PreviewStaticImageSurfaceDescriptor,
): `scient:artifact:${string}` {
  return `scient:artifact:${artifact.surfaceId}`;
}

export function scientArtifactSurface(
  artifact: PreviewStaticImageSurfaceDescriptor,
): Extract<ScientRightPanelSurface, { module: "artifact" }> {
  return {
    id: scientArtifactSurfaceId(artifact),
    kind: "scient",
    module: "artifact",
    artifact,
  };
}

export function normalizeScientRightPanelSurface(value: unknown): ScientRightPanelSurface | null {
  if (typeof value !== "object" || value === null) return null;
  const surface = value as Record<string, unknown>;
  if (surface.kind !== "scient") return null;
  if (surface.id === "scient:sources" && surface.module === "sources") {
    return scientSourcesSurface();
  }
  if (
    surface.module === "source-pdf" &&
    typeof surface.attachmentId === "string" &&
    surface.attachmentId.length > 0 &&
    typeof surface.fileName === "string" &&
    surface.fileName.length > 0
  ) {
    return scientSourcePdfSurface({
      attachmentId: surface.attachmentId,
      fileName: surface.fileName,
    });
  }
  if (
    surface.module === "artifact" &&
    isPreviewStaticImageSurfaceDescriptor(surface.artifact)
  ) {
    return scientArtifactSurface(surface.artifact);
  }
  return null;
}

export function scientRightPanelSurfaceTitle(surface: ScientRightPanelSurface): string {
  switch (surface.module) {
    case "sources":
      return "Sources";
    case "source-pdf":
      return surface.fileName;
    case "artifact":
      return surface.artifact.label;
  }
}
