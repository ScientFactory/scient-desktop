// @effect-diagnostics globalTimers:off globalDate:off - Electron callbacks and an isolated preload, outside any Effect runtime.
import type { WebContents } from "electron";

export const PINCH_ZOOM_CHANNEL = "preview:pinch-zoom";
// A busy page reports a pinch's last frames after main sees it end.
const PINCH_SETTLE_MS = 500;
// Smaller pinch steps wait until they add up to a zoom change main does not ignore as a no-op.
const MIN_PINCH_DELTA_Y = 0.5;
const ZOOM_SNAP = 0.001;
const DOM_DELTA_PIXEL = 0;

/**
 * Chromium hands a trackpad pinch to the page as ctrl+wheel events, each `deltaY` being
 * -100·ln(scale). A page that cancels them keeps the gesture, as in Chrome. Deltas are summed
 * per frame so main relays out the page at most once a frame.
 */
export function reportPinchWheel(target: Window, send: (deltaY: number) => void): void {
  let pendingDeltaY = 0;
  let flushScheduled = false;
  const flush = (): void => {
    flushScheduled = false;
    const deltaY = pendingDeltaY;
    pendingDeltaY = 0;
    if (deltaY !== 0) send(deltaY);
  };
  target.addEventListener(
    "wheel",
    (event) => {
      if (!event.isTrusted || !event.ctrlKey || event.deltaMode !== DOM_DELTA_PIXEL) return;
      // The task delay lets every page listener cancel first.
      target.setTimeout(() => {
        if (event.defaultPrevented) return;
        pendingDeltaY += event.deltaY;
        if (flushScheduled) return;
        flushScheduled = true;
        target.requestAnimationFrame(flush);
      }, 0);
    },
    { capture: true, passive: true },
  );
}

/** The tab zoom a pinch of `deltaY` leads to, within the tab's zoom steps and onto one it reaches. */
export function pinchZoomFactor(
  current: number,
  deltaY: number,
  levels: ReadonlyArray<number>,
): number {
  const next = Math.min(levels.at(-1)!, Math.max(levels[0]!, current * Math.exp(-deltaY / 100)));
  return levels.find((level) => Math.abs(level - next) < ZOOM_SNAP) ?? next;
}

interface PinchZoomActions {
  readonly pinch: (deltaY: number) => void;
  /** Ctrl+mouse wheel; Chromium raises `zoom-changed` for it everywhere but macOS. */
  readonly step: (direction: "in" | "out") => void;
}

/**
 * Zooms a preview guest from the trackpad pinch the guest reports, only during a pinch gesture
 * and as it settles, so ctrl+scroll does not zoom (as in Chrome). The guest's visual zoom stays off:
 * Chromium applies a guest's visual zoom to the app page that embeds it.
 */
export function watchPinchZoom(
  guest: Pick<WebContents, "on" | "off" | "ipc">,
  actions: PinchZoomActions,
  now: () => number = Date.now,
): () => void {
  let pinching = false;
  let pinchEndedAt = Number.NEGATIVE_INFINITY;
  let pendingDeltaY = 0;
  const inPinch = () => pinching || now() - pinchEndedAt <= PINCH_SETTLE_MS;
  const inputEvent = (_event: unknown, input: Electron.InputEvent): void => {
    if (input.type === "gesturePinchBegin") {
      pinching = true;
      pendingDeltaY = 0;
    } else if (input.type === "gesturePinchEnd") {
      pinching = false;
      pinchEndedAt = now();
    } else if (!pinching && (input.type === "mouseWheel" || input.type === "gestureScrollBegin")) {
      // New wheel input after a pinch is not part of it.
      pinchEndedAt = Number.NEGATIVE_INFINITY;
    }
  };
  const pinchReported = (_event: unknown, deltaY?: unknown): void => {
    if (!inPinch() || typeof deltaY !== "number" || !Number.isFinite(deltaY)) return;
    pendingDeltaY += deltaY;
    if (Math.abs(pendingDeltaY) < MIN_PINCH_DELTA_Y) return;
    actions.pinch(pendingDeltaY);
    pendingDeltaY = 0;
  };
  const zoomChanged = (_event: unknown, direction: unknown): void => {
    if (!inPinch() && (direction === "in" || direction === "out")) actions.step(direction);
  };
  guest.on("input-event", inputEvent);
  guest.on("zoom-changed", zoomChanged);
  guest.ipc.on(PINCH_ZOOM_CHANNEL, pinchReported);
  return () => {
    guest.off("input-event", inputEvent);
    guest.off("zoom-changed", zoomChanged);
    guest.ipc.off(PINCH_ZOOM_CHANNEL, pinchReported);
  };
}
