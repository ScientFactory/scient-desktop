import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type SetStateAction,
  useLayoutEffect,
} from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import type { BrowserViewportResizeDirection } from "~/browser/browserViewportLayout";
import {
  type PreviewMiniPlayerPosition,
  type PreviewMiniPlayerSize,
  type PreviewMiniPlayerState,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";
import { observeResize } from "~/lib/observeResize";

import {
  clampPreviewMiniPlayerPosition,
  clampPreviewMiniPlayerSize,
  PREVIEW_MINI_PLAYER_DEFAULT_SIZE,
  type PreviewMiniPlayerFrame,
  type PreviewMiniPlayerObstacles,
  type PreviewMiniPlayerResizeDirection,
  resizePreviewMiniPlayer,
  resizePreviewMiniPlayerRect,
  resolvePreviewMiniPlayerDefaultPosition,
  resolvePreviewMiniPlayerFrame,
} from "./previewMiniPlayerLayout";
import { StaticImageCopyButton, StaticImageDownloadButton } from "./StaticImageActionButtons";

/*
 * Scient additions to the floating preview: a player that lays itself out
 * beside the docked composer, free-sized players, keyboard moves and resizes,
 * and the copy and download actions of a floating image.
 */

export interface Layout {
  readonly container: PreviewMiniPlayerSize;
  readonly obstacles: PreviewMiniPlayerObstacles;
}

const sameLayout = (a: Layout, b: Layout) =>
  a.container.width === b.container.width &&
  a.container.height === b.container.height &&
  (a.obstacles.composer === b.obstacles.composer ||
    (a.obstacles.composer !== null &&
      b.obstacles.composer !== null &&
      a.obstacles.composer.left === b.obstacles.composer.left &&
      a.obstacles.composer.right === b.obstacles.composer.right &&
      a.obstacles.composer.height === b.obstacles.composer.height));

/**
 * Measures the chat column and the composer in the column's coordinates. The
 * composer's columns come from its centered stack, not the full-width overlay,
 * so the margins beside it stay open to the player.
 */
function measureLayout(container: HTMLElement, composerOverlay: HTMLElement | null): Layout {
  const containerRect = container.getBoundingClientRect();
  const stackRect = composerOverlay
    ?.querySelector('[data-chat-composer-stack="true"]')
    ?.getBoundingClientRect();
  const overlayRect = composerOverlay?.getBoundingClientRect();
  return {
    container: { width: container.clientWidth, height: container.clientHeight },
    obstacles: {
      detailsCard: null,
      composer:
        overlayRect && stackRect && overlayRect.height > 0
          ? {
              left: Math.floor(stackRect.left - containerRect.left),
              right: Math.ceil(stackRect.right - containerRect.left),
              height: Math.ceil(overlayRect.height),
            }
          : null,
    },
  };
}

const MINI_PLAYER_RESIZE_DIRECTION: Record<
  BrowserViewportResizeDirection,
  PreviewMiniPlayerResizeDirection
> = {
  north: "n",
  northeast: "ne",
  east: "e",
  southeast: "se",
  south: "s",
  southwest: "sw",
  west: "w",
  northwest: "nw",
};

export function FloatingStaticArtifactActions(props: {
  readonly artifact: PreviewStaticImageSurfaceDescriptor;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
}) {
  const asset = useAssetUrlState(props.environmentId, props.artifact.resource);
  const assetUrl = asset._tag === "Success" ? asset.url : null;

  return (
    <>
      <StaticImageCopyButton assetUrl={assetUrl} threadRef={props.threadRef} />
      <StaticImageDownloadButton
        assetUrl={assetUrl}
        fileName={props.artifact.fileName}
        threadRef={props.threadRef}
      />
    </>
  );
}

/** Measures a player the chat canvas does not place, and the docked composer beside it. */
export function useMiniPlayerMeasuredLayout(
  containerRef: RefObject<HTMLDivElement | null>,
  composerOverlayElement: HTMLElement | null | undefined,
  canvasFrame: PreviewMiniPlayerFrame | null,
  setLayout: Dispatch<SetStateAction<Layout | null>>,
): void {
  // The composer grows on its own (drafts, banners), so it is observed alongside the column.
  useLayoutEffect(() => {
    if (canvasFrame) return;
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const next = measureLayout(element, composerOverlayElement ?? null);
      setLayout((current) => (current && sameLayout(current, next) ? current : next));
    };
    measure();
    return observeResize(
      composerOverlayElement ? [element, composerOverlayElement] : element,
      measure,
    );
  }, [composerOverlayElement, canvasFrame, containerRef, setLayout]);
}

/** The frame of a player: the canvas's, a free-sized one, or one fitted to its source. */
export function resolveMiniPlayerShellFrame({
  canvasFrame,
  container,
  obstacles,
  freeSize,
  miniPlayer,
  sourceSize,
}: {
  readonly canvasFrame: PreviewMiniPlayerFrame | null;
  readonly container: PreviewMiniPlayerSize | null;
  readonly obstacles: PreviewMiniPlayerObstacles | null;
  readonly freeSize: boolean;
  readonly miniPlayer: PreviewMiniPlayerState;
  readonly sourceSize: PreviewMiniPlayerSize;
}): PreviewMiniPlayerFrame | null {
  const freeFrameSize =
    !canvasFrame && container
      ? clampPreviewMiniPlayerSize(miniPlayer.size ?? PREVIEW_MINI_PLAYER_DEFAULT_SIZE, container)
      : null;
  return (
    canvasFrame ??
    (container && obstacles
      ? freeSize && freeFrameSize
        ? {
            ...clampPreviewMiniPlayerPosition(
              miniPlayer.position ??
                resolvePreviewMiniPlayerDefaultPosition(container, freeFrameSize),
              container,
              freeFrameSize,
            ),
            ...freeFrameSize,
          }
        : resolvePreviewMiniPlayerFrame({
            width: miniPlayer.size?.width ?? null,
            position: miniPlayer.position,
            source: sourceSize,
            container,
            obstacles,
          })
      : null)
  );
}

/** Resizes a player from one edge: freely, or keeping its source's ratio. */
export function miniPlayerResizer({
  container,
  obstacles,
  freeSize,
  sourceSize,
  threadRef,
  contentId,
}: {
  readonly container: PreviewMiniPlayerSize | null;
  readonly obstacles: PreviewMiniPlayerObstacles | null;
  readonly freeSize: boolean;
  readonly sourceSize: PreviewMiniPlayerSize;
  readonly threadRef: ScopedThreadRef;
  readonly contentId: string;
}) {
  return (
    start: PreviewMiniPlayerFrame,
    direction: BrowserViewportResizeDirection,
    delta: PreviewMiniPlayerPosition,
  ) => {
    if (!container || !obstacles) return;
    const next = freeSize
      ? resizePreviewMiniPlayerRect({
          rect: {
            position: { x: start.x, y: start.y },
            size: { width: start.width, height: start.height },
          },
          direction: MINI_PLAYER_RESIZE_DIRECTION[direction],
          delta,
          container,
        })
      : (() => {
          const resized = resizePreviewMiniPlayer({
            start,
            direction,
            delta,
            source: sourceSize,
            container,
            obstacles,
          });
          return {
            position: { x: resized.x, y: resized.y },
            size: { width: resized.width, height: resized.height },
          };
        })();
    usePreviewMiniPlayerStore.getState().setRect(threadRef, contentId, next);
  };
}

/** Arrow keys move the player from its pill, or resize it from a focused edge. */
export function miniPlayerKeyDownHandler({
  frame,
  container,
  obstacles,
  resizeFrom,
  threadRef,
  contentId,
}: {
  readonly frame: PreviewMiniPlayerFrame | null;
  readonly container: PreviewMiniPlayerSize | null;
  readonly obstacles: PreviewMiniPlayerObstacles | null;
  readonly resizeFrom: ReturnType<typeof miniPlayerResizer>;
  readonly threadRef: ScopedThreadRef;
  readonly contentId: string;
}) {
  return (
    event: ReactKeyboardEvent<HTMLElement>,
    direction: BrowserViewportResizeDirection | null,
  ) => {
    if (!frame || !container || !obstacles) return;
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    if (!horizontal && !vertical) return;
    if (
      direction &&
      ((horizontal && !/east|west/.test(direction)) || (vertical && !/north|south/.test(direction)))
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = direction ? (event.shiftKey ? 60 : 12) : event.shiftKey ? 80 : 8;
    const delta = {
      x: horizontal ? (event.key === "ArrowLeft" ? -step : step) : 0,
      y: vertical ? (event.key === "ArrowUp" ? -step : step) : 0,
    };
    if (direction) {
      resizeFrom(
        frame,
        horizontal
          ? direction.includes("west")
            ? "west"
            : "east"
          : direction.includes("north")
            ? "north"
            : "south",
        delta,
      );
      return;
    }
    usePreviewMiniPlayerStore
      .getState()
      .move(
        threadRef,
        contentId,
        clampPreviewMiniPlayerPosition(
          { x: frame.x + delta.x, y: frame.y + delta.y },
          container,
          frame,
          obstacles,
        ),
      );
  };
}
