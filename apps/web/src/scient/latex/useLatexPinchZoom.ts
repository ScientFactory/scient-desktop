import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { normalizePdfZoom } from "../pdf/pdfReaderModel";

/** Chromium trackpad pinches arrive as Ctrl+wheel, just as in our PDF reader. */
export function useLatexPinchZoom(
  scrollRef: RefObject<HTMLDivElement | null>,
  zoom: number,
  onZoom: (zoom: number) => void,
) {
  const latest = useRef({ zoom, onZoom });
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const changeZoom = useCallback(
    (scale: number, apply?: () => void) => {
      const current = latest.current.zoom;
      const next = apply ? scale : normalizePdfZoom(scale);
      const scroll = scrollRef.current;
      const stage = scroll?.querySelector<HTMLElement>(".scient-latex-page-stage");
      if (scroll && stage && current > 0 && next !== current) {
        const bounds = stage.getBoundingClientRect();
        const viewport = scroll.getBoundingClientRect();
        // Like PDF.js's toolbar zoom, retain the visible document location.
        const clientX = Math.max(bounds.left, viewport.left + scroll.clientLeft);
        const clientY = Math.max(bounds.top, viewport.top + scroll.clientTop);
        anchor.current = {
          x: (clientX - bounds.left) / current,
          y: (clientY - bounds.top) / current,
          clientX,
          clientY,
        };
      }
      if (apply) apply();
      else latest.current.onZoom(next);
    },
    [scrollRef],
  );
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
      factor *= Math.exp(Math.max(-0.5, Math.min(0.5, -event.deltaY * 0.01)));
      clientX = event.clientX;
      clientY = event.clientY;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const current = latest.current.zoom;
        const next = normalizePdfZoom(current * factor);
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
  return changeZoom;
}
