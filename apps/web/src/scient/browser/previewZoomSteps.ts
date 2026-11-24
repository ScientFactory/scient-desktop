import {
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  PREVIEW_ZOOM_LEVELS,
  type PreviewZoomFactor,
} from "@t3tools/contracts";

/**
 * The zoom step a key press moves to from `current`, which a pinch can leave between steps:
 * in or out goes to the next step beyond it, and 0 resets.
 */
export function stepPreviewZoom(current: number, direction: -1 | 0 | 1): PreviewZoomFactor {
  if (direction === 0) return DEFAULT_PREVIEW_ZOOM_FACTOR;
  const levels = direction === 1 ? PREVIEW_ZOOM_LEVELS : [...PREVIEW_ZOOM_LEVELS].reverse();
  const beyond = levels.find((level) =>
    direction === 1 ? level > current + 0.001 : level < current - 0.001,
  );
  return beyond ?? levels.at(-1)!;
}
