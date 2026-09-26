import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export const MIN_VISUAL_ZOOM = 0.25;
export const MAX_VISUAL_ZOOM = 4;

/** Chromium trackpad pinches arrive as Ctrl+wheel, just as in our PDF reader. */
export function useLatexPinchZoom(
  scrollRef: RefObject<HTMLDivElement | null>,
  zoom: number,
  onZoom: (zoom: number) => void,
) {
  const latest = useRef({ zoom, onZoom });
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  useLayoutEffect(() => {
    latest.current = { zoom, onZoom };
    const point = anchor.current;
    anchor.current = null;
    const scroll = scrollRef.current;
    const stage = scroll?.querySelector<HTMLElement>(".scient-latex-page-stage");
    if (!point || !scroll || !stage) return;
    // Account for both the scale and the paper's centered margin changing.
    const bounds = stage.getBoundingClientRect();
    scroll.scrollLeft += bounds.left + point.x * zoom - point.clientX;
    scroll.scrollTop += bounds.top + point.y * zoom - point.clientY;
  }, [zoom, onZoom, scrollRef]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let frame = 0;
    let factor = 1;
    let clientX = 0;
    let clientY = 0;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const pixels =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroll.clientHeight : 1);
      factor *= Math.exp(Math.max(-0.5, Math.min(0.5, -pixels * 0.01)));
      clientX = event.clientX;
      clientY = event.clientY;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const current = latest.current.zoom;
        // Fit width can sit outside the manual range; enter it without a jump.
        const next = Math.max(
          Math.min(MIN_VISUAL_ZOOM, current),
          Math.min(Math.max(MAX_VISUAL_ZOOM, current), current * factor),
        );
        factor = 1;
        if (next === current) return;
        const stage = scroll.querySelector<HTMLElement>(".scient-latex-page-stage");
        if (!stage) return;
        const bounds = stage.getBoundingClientRect();
        anchor.current = {
          x: (clientX - bounds.left) / current,
          y: (clientY - bounds.top) / current,
          clientX,
          clientY,
        };
        latest.current.onZoom(next);
      });
    };
    // Capture before nested math fields handle their own wheel events.
    scroll.addEventListener("wheel", wheel, { passive: false, capture: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      anchor.current = null;
      scroll.removeEventListener("wheel", wheel, true);
    };
  }, [scrollRef]);
}
