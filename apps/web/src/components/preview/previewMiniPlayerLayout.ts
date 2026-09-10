import type { PreviewViewportSetting } from "@t3tools/contracts";

import type { BrowserSurfaceContentPresentation } from "~/browser/browserSurfaceStore";
import {
  resolveFittedBrowserViewport,
  type BrowserViewportResizeDirection,
} from "~/browser/browserViewportLayout";
import type { PreviewMiniPlayerPosition, PreviewMiniPlayerSize } from "~/previewMiniPlayerStore";

export const PREVIEW_MINI_PLAYER_EDGE_GAP = 12;
// The mini-player shell straddles this webview at 47 and 49; dialogs begin at 50.
export const PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX = 48;
export const PREVIEW_MINI_PLAYER_DEFAULT_SIZE = { width: 400, height: 260 } as const;
// A fresh player is the largest box at the source aspect ratio that fits here.
const PREVIEW_MINI_PLAYER_DEFAULT_BOX = { width: 320, height: 320 } as const;
const PREVIEW_MINI_PLAYER_MIN_SIZE = { width: 240, height: 150 } as const;
export const PREVIEW_MINI_PLAYER_DEFAULT_TOP = 72;

export type PreviewMiniPlayerResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export interface PreviewMiniPlayerRect {
  readonly position: PreviewMiniPlayerPosition;
  readonly size: PreviewMiniPlayerSize;
}

export interface PreviewMiniPlayerFrame extends PreviewMiniPlayerPosition, PreviewMiniPlayerSize {}

/**
 * The rendered size of what the floating player mirrors: the device viewport
 * when one is set, otherwise the size the webview had when it was floated
 * (`fittedSourceContent`), which the hosted webview keeps as its CSS viewport.
 */
export function resolvePreviewMiniPlayerSourceSize(
  viewport: PreviewViewportSetting,
  fittedSourceContent: BrowserSurfaceContentPresentation | null,
  zoomFactor: number,
): PreviewMiniPlayerSize {
  const normalizedZoomFactor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const fitted = resolveFittedBrowserViewport(viewport, fittedSourceContent, normalizedZoomFactor);
  return {
    width: fitted.width * normalizedZoomFactor,
    height: fitted.height * normalizedZoomFactor,
  };
}

const availableArea = (
  container: PreviewMiniPlayerSize,
  bottomInset: number,
): PreviewMiniPlayerSize => ({
  width: container.width - PREVIEW_MINI_PLAYER_EDGE_GAP * 2,
  height: container.height - Math.max(0, bottomInset) - PREVIEW_MINI_PLAYER_EDGE_GAP * 2,
});

/**
 * Width is the player's only free dimension; height always follows the source
 * aspect ratio so the webview fills the box without letterboxing. The player
 * never grows past the source's own size (the guest keeps its CSS viewport, so
 * going bigger would only upscale), and a tight container wins over the minimum.
 */
function fitPreviewMiniPlayerWidth(
  desiredWidth: number,
  source: PreviewMiniPlayerSize,
  max: PreviewMiniPlayerSize,
): PreviewMiniPlayerSize {
  const aspectRatio = source.width / source.height;
  const width = Math.min(
    Math.max(
      desiredWidth,
      PREVIEW_MINI_PLAYER_MIN_SIZE.width,
      PREVIEW_MINI_PLAYER_MIN_SIZE.height * aspectRatio,
    ),
    source.width,
    Math.max(1, max.width),
    Math.max(1, max.height * aspectRatio),
  );
  return { width: Math.round(width), height: Math.round(width / aspectRatio) };
}

function defaultPreviewMiniPlayerWidth(source: PreviewMiniPlayerSize): number {
  return Math.min(
    PREVIEW_MINI_PLAYER_DEFAULT_BOX.width,
    (PREVIEW_MINI_PLAYER_DEFAULT_BOX.height * source.width) / source.height,
  );
}

/** Static artifacts keep independent width and height; browser surfaces use their source ratio. */
export function clampPreviewMiniPlayerSize(
  size: PreviewMiniPlayerSize,
  container: PreviewMiniPlayerSize,
  bottomInset = 0,
): PreviewMiniPlayerSize {
  const max = availableArea(container, bottomInset);
  return {
    width: Math.round(
      Math.min(Math.max(PREVIEW_MINI_PLAYER_MIN_SIZE.width, size.width), Math.max(1, max.width)),
    ),
    height: Math.round(
      Math.min(Math.max(PREVIEW_MINI_PLAYER_MIN_SIZE.height, size.height), Math.max(1, max.height)),
    ),
  };
}

export function clampPreviewMiniPlayerPosition(
  position: PreviewMiniPlayerPosition,
  container: PreviewMiniPlayerSize,
  player: PreviewMiniPlayerSize,
  bottomInset = 0,
): PreviewMiniPlayerPosition {
  const reservedBottomSpace = Math.max(0, bottomInset);
  const maxX = Math.max(
    PREVIEW_MINI_PLAYER_EDGE_GAP,
    container.width - player.width - PREVIEW_MINI_PLAYER_EDGE_GAP,
  );
  const maxY = Math.max(
    PREVIEW_MINI_PLAYER_EDGE_GAP,
    container.height - reservedBottomSpace - player.height - PREVIEW_MINI_PLAYER_EDGE_GAP,
  );
  return {
    x: Math.min(Math.max(position.x, PREVIEW_MINI_PLAYER_EDGE_GAP), maxX),
    y: Math.min(Math.max(position.y, PREVIEW_MINI_PLAYER_EDGE_GAP), maxY),
  };
}

export function resolvePreviewMiniPlayerDefaultPosition(
  container: PreviewMiniPlayerSize,
  player: PreviewMiniPlayerSize,
): PreviewMiniPlayerPosition {
  return clampPreviewMiniPlayerPosition(
    {
      x: Math.round((container.width - player.width) / 2),
      y: PREVIEW_MINI_PLAYER_DEFAULT_TOP,
    },
    container,
    player,
  );
}

/** Move the player by one keyboard step without leaving the viewport. */
export function keyboardNudgePreviewMiniPlayerPosition(
  position: PreviewMiniPlayerPosition,
  direction: "left" | "right" | "up" | "down",
  step: number,
  container: PreviewMiniPlayerSize,
  player: PreviewMiniPlayerSize,
): PreviewMiniPlayerPosition {
  const offsets = {
    left: { x: -step, y: 0 },
    right: { x: step, y: 0 },
    up: { x: 0, y: -step },
    down: { x: 0, y: step },
  } as const;
  const offset = offsets[direction];
  return clampPreviewMiniPlayerPosition(
    { x: position.x + offset.x, y: position.y + offset.y },
    container,
    player,
  );
}

/**
 * Move the edge owned by a focused resize handle in the arrow's screen
 * direction. A handle ignores arrows on axes it does not control.
 */
export function keyboardResizePreviewMiniPlayerFromHandle(
  rect: PreviewMiniPlayerRect,
  handleDirection: PreviewMiniPlayerResizeDirection,
  key: "left" | "right" | "up" | "down",
  step: number,
  container: PreviewMiniPlayerSize,
): PreviewMiniPlayerRect | null {
  const horizontalEdge = handleDirection.includes("w")
    ? "w"
    : handleDirection.includes("e")
      ? "e"
      : null;
  const verticalEdge = handleDirection.includes("n")
    ? "n"
    : handleDirection.includes("s")
      ? "s"
      : null;

  if (key === "left" || key === "right") {
    if (horizontalEdge === null) return null;
    return resizePreviewMiniPlayerRect({
      rect,
      direction: horizontalEdge,
      delta: { x: key === "left" ? -step : step, y: 0 },
      container,
    });
  }

  if (verticalEdge === null) return null;
  return resizePreviewMiniPlayerRect({
    rect,
    direction: verticalEdge,
    delta: { x: 0, y: key === "up" ? -step : step },
    container,
  });
}

/** Resize one edge or corner while keeping the opposite edges anchored. */
export function resizePreviewMiniPlayerRect(input: {
  readonly rect: PreviewMiniPlayerRect;
  readonly direction: PreviewMiniPlayerResizeDirection;
  readonly delta: PreviewMiniPlayerPosition;
  readonly container: PreviewMiniPlayerSize;
  readonly bottomInset?: number;
}): PreviewMiniPlayerRect {
  const leftBound = PREVIEW_MINI_PLAYER_EDGE_GAP;
  const topBound = PREVIEW_MINI_PLAYER_EDGE_GAP;
  const rightBound = Math.max(leftBound + 1, input.container.width - PREVIEW_MINI_PLAYER_EDGE_GAP);
  const bottomBound = Math.max(
    topBound + 1,
    input.container.height - Math.max(0, input.bottomInset ?? 0) - PREVIEW_MINI_PLAYER_EDGE_GAP,
  );
  const availableWidth = rightBound - leftBound;
  const availableHeight = bottomBound - topBound;
  const minWidth = Math.min(PREVIEW_MINI_PLAYER_MIN_SIZE.width, availableWidth);
  const minHeight = Math.min(PREVIEW_MINI_PLAYER_MIN_SIZE.height, availableHeight);
  const startLeft = input.rect.position.x;
  const startTop = input.rect.position.y;
  const startRight = startLeft + input.rect.size.width;
  const startBottom = startTop + input.rect.size.height;
  let left = startLeft;
  let right = startRight;
  let top = startTop;
  let bottom = startBottom;

  if (input.direction.includes("w")) {
    left = Math.min(Math.max(startLeft + input.delta.x, leftBound), startRight - minWidth);
  } else if (input.direction.includes("e")) {
    right = Math.max(Math.min(startRight + input.delta.x, rightBound), startLeft + minWidth);
  }

  if (input.direction.includes("n")) {
    top = Math.min(Math.max(startTop + input.delta.y, topBound), startBottom - minHeight);
  } else if (input.direction.includes("s")) {
    bottom = Math.max(Math.min(startBottom + input.delta.y, bottomBound), startTop + minHeight);
  }

  return {
    position: { x: Math.round(left), y: Math.round(top) },
    size: { width: Math.round(right - left), height: Math.round(bottom - top) },
  };
}

/**
 * Resolves the on-screen frame from the stored width and position. Clamping
 * happens here on every layout pass instead of being written back to the
 * store, so a temporarily narrow container never destroys the user's chosen
 * width. A player without a position sits in the top-right corner.
 */
export function resolvePreviewMiniPlayerFrame(input: {
  readonly width: number | null;
  readonly position: PreviewMiniPlayerPosition | null;
  readonly source: PreviewMiniPlayerSize;
  readonly container: PreviewMiniPlayerSize;
  readonly bottomInset?: number;
}): PreviewMiniPlayerFrame {
  const { width, position, source, container, bottomInset = 0 } = input;
  const size = fitPreviewMiniPlayerWidth(
    width ?? defaultPreviewMiniPlayerWidth(source),
    source,
    availableArea(container, bottomInset),
  );
  const anchored = position ?? {
    x: container.width - PREVIEW_MINI_PLAYER_EDGE_GAP - size.width,
    y: PREVIEW_MINI_PLAYER_EDGE_GAP,
  };
  return { ...clampPreviewMiniPlayerPosition(anchored, container, size, bottomInset), ...size };
}

/**
 * Resizes from any edge or corner while holding the aspect ratio. The edge
 * opposite the dragged one stays anchored, so growth stops at the container
 * on that axis and the pointer keeps tracking the grabbed edge. On a plain edge
 * drag the perpendicular axis may use the whole container, and the player
 * shifts as needed to stay inside.
 */
export function resizePreviewMiniPlayer(input: {
  readonly start: PreviewMiniPlayerFrame;
  readonly direction: BrowserViewportResizeDirection;
  readonly delta: PreviewMiniPlayerPosition;
  readonly source: PreviewMiniPlayerSize;
  readonly container: PreviewMiniPlayerSize;
  readonly bottomInset?: number;
}): PreviewMiniPlayerFrame {
  const { start, direction, delta, source, container, bottomInset = 0 } = input;
  const east = direction.includes("east");
  const west = direction.includes("west");
  const north = direction.includes("north");
  const south = direction.includes("south");
  const available = availableArea(container, bottomInset);
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const max = {
    width: west
      ? right - PREVIEW_MINI_PLAYER_EDGE_GAP
      : east
        ? container.width - PREVIEW_MINI_PLAYER_EDGE_GAP - start.x
        : available.width,
    height: north
      ? bottom - PREVIEW_MINI_PLAYER_EDGE_GAP
      : south
        ? container.height - Math.max(0, bottomInset) - PREVIEW_MINI_PLAYER_EDGE_GAP - start.y
        : available.height,
  };
  const desiredWidth = start.width + (east ? delta.x : west ? -delta.x : 0);
  const desiredHeight = start.height + (south ? delta.y : north ? -delta.y : 0);
  const horizontal = east || west;
  const vertical = north || south;
  const widthLeads =
    horizontal && !vertical
      ? true
      : vertical && !horizontal
        ? false
        : Math.abs(desiredWidth - start.width) / start.width >=
          Math.abs(desiredHeight - start.height) / start.height;
  const size = fitPreviewMiniPlayerWidth(
    widthLeads ? desiredWidth : (desiredHeight * source.width) / source.height,
    source,
    max,
  );
  const position = clampPreviewMiniPlayerPosition(
    { x: west ? right - size.width : start.x, y: north ? bottom - size.height : start.y },
    container,
    size,
    bottomInset,
  );
  return { ...position, ...size };
}
