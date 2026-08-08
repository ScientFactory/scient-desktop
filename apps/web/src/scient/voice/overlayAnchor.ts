// Measures the on-screen rect of the composer form so our recording overlay can
// cover it (via a fixed-position portal) WITHOUT editing any T3 composer markup.
// The rect is re-measured on layout changes (ResizeObserver) and on window
// resize/scroll while active; it is null when inactive.

import { type RefObject, useLayoutEffect, useState } from "react";

export interface AnchorRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Track the bounding rect of the nearest ancestor matching `selector` (default
 * the composer `form`) relative to `anchorRef`. Returns null while `active` is
 * false or the ancestor can't be found.
 */
export function useAnchoredRect(
  active: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  selector = "form",
): AnchorRect | null {
  const [rect, setRect] = useState<AnchorRect | null>(null);

  useLayoutEffect(() => {
    if (!active) {
      setRect(null);
      return;
    }
    const anchor = anchorRef.current?.closest(selector);
    if (!(anchor instanceof HTMLElement)) {
      return;
    }
    const update = (): void => {
      const box = anchor.getBoundingClientRect();
      setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [active, anchorRef, selector]);

  return rect;
}
