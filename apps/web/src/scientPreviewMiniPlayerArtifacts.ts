// SCIENT-OWNED: static artifact images in the floating preview player.
// previewMiniPlayerStore.ts calls these reducers from short marked lines.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type {
  PreviewMiniPlayerContent,
  PreviewMiniPlayerPosition,
  PreviewMiniPlayerState,
} from "./previewMiniPlayerStore";
import {
  previewStaticImageDescriptorKey,
  type PreviewStaticImageSurfaceDescriptor,
} from "./previewStaticImageSurface";

interface PreviewMiniPlayerThreads {
  readonly byThreadKey: Record<string, PreviewMiniPlayerState>;
}

function artifactContent(artifact: PreviewStaticImageSurfaceDescriptor): PreviewMiniPlayerContent {
  return { kind: "static-artifact", id: artifact.surfaceId, artifact };
}

function artifactEquals(
  left: PreviewStaticImageSurfaceDescriptor,
  right: PreviewStaticImageSurfaceDescriptor,
): boolean {
  return previewStaticImageDescriptorKey(left) === previewStaticImageDescriptorKey(right);
}

export function openContent(
  current: PreviewMiniPlayerState | undefined,
  content: PreviewMiniPlayerContent,
  position: PreviewMiniPlayerPosition | undefined,
): PreviewMiniPlayerState {
  return {
    content,
    position: position ?? current?.position ?? null,
    size: current?.size ?? null,
    lastInteraction: current?.lastInteraction ?? "drag",
  };
}

/** Returns `state` itself when nothing changes, so the store skips the update. */
export function openPreviewArtifact<S extends PreviewMiniPlayerThreads>(
  state: S,
  ref: ScopedThreadRef,
  artifact: PreviewStaticImageSurfaceDescriptor,
  position: PreviewMiniPlayerPosition | undefined,
): S | PreviewMiniPlayerThreads {
  const threadKey = scopedThreadKey(ref);
  const current = state.byThreadKey[threadKey];
  const nextPosition = position ?? current?.position ?? null;
  if (
    current?.content.kind === "static-artifact" &&
    artifactEquals(current.content.artifact, artifact) &&
    current.position?.x === nextPosition?.x &&
    current.position?.y === nextPosition?.y
  ) {
    return state;
  }
  return {
    byThreadKey: {
      ...state.byThreadKey,
      [threadKey]: openContent(current, artifactContent(artifact), position),
    },
  };
}

/** Returns `state` itself when nothing changes, so the store skips the update. */
export function updatePreviewArtifact<S extends PreviewMiniPlayerThreads>(
  state: S,
  ref: ScopedThreadRef,
  artifact: PreviewStaticImageSurfaceDescriptor,
): S | PreviewMiniPlayerThreads {
  const threadKey = scopedThreadKey(ref);
  const current = state.byThreadKey[threadKey];
  if (
    current?.content.kind !== "static-artifact" ||
    current.content.artifact.surfaceId !== artifact.surfaceId ||
    artifactEquals(current.content.artifact, artifact)
  ) {
    return state;
  }
  return {
    byThreadKey: {
      ...state.byThreadKey,
      [threadKey]: { ...current, content: artifactContent(artifact) },
    },
  };
}
