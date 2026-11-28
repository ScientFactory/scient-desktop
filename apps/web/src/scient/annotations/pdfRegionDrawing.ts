import type { ScientPdfRegionAnchor } from "@t3tools/contracts";

import { pdfPageGeometry, pdfPageView } from "../pdf/anchors/pdfTextLayer";
import type { ScientPdfRuntime } from "../pdf/pdfRuntime";
import { pdfRegionFromPageFractions, type PageFraction } from "./pdfRegionGeometry";

/** Smaller drags, in CSS pixels, are taken as a stray click, not a box. */
const MIN_DRAG = 6;

export interface PdfRegionDrawingHandlers {
  readonly onDrawn: (anchor: ScientPdfRegionAnchor, bounds: DOMRect) => void;
  readonly onCancel: () => void;
}

/**
 * Lets one box be dragged out on a page of the reader. The drag never starts a text selection,
 * and needs no text on the page, so a scan can be marked before its words are recognized.
 * Escape cancels. Returns the cleanup.
 */
export function startPdfRegionDrawing(
  runtime: ScientPdfRuntime,
  container: HTMLElement,
  handlers: PdfRegionDrawingHandlers,
): () => void {
  const document = container.ownerDocument;
  container.dataset.drawingRegion = "";
  let drag: {
    readonly pointerId: number;
    readonly pageDiv: HTMLElement;
    readonly page: number;
    readonly start: PageFraction;
    readonly band: HTMLElement;
    end: PageFraction;
  } | null = null;

  const fractionIn = (pageDiv: HTMLElement, event: PointerEvent): PageFraction => {
    const rect = pageDiv.getBoundingClientRect();
    const left = rect.left + pageDiv.clientLeft;
    const top = rect.top + pageDiv.clientTop;
    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    return {
      x: clamp((event.clientX - left) / Math.max(1, pageDiv.clientWidth)),
      y: clamp((event.clientY - top) / Math.max(1, pageDiv.clientHeight)),
    };
  };
  const placeBand = () => {
    if (!drag) return;
    const left = Math.min(drag.start.x, drag.end.x);
    const top = Math.min(drag.start.y, drag.end.y);
    drag.band.style.left = `${left * 100}%`;
    drag.band.style.top = `${top * 100}%`;
    drag.band.style.width = `${Math.abs(drag.end.x - drag.start.x) * 100}%`;
    drag.band.style.height = `${Math.abs(drag.end.y - drag.start.y) * 100}%`;
  };
  const endDrag = () => {
    if (!drag) return;
    drag.band.remove();
    if (drag.pageDiv.hasPointerCapture(drag.pointerId)) {
      drag.pageDiv.releasePointerCapture(drag.pointerId);
    }
    drag = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || drag || !(event.target instanceof Element)) return;
    const pageDiv = event.target.closest<HTMLElement>(".page[data-page-number]");
    const page = Number(pageDiv?.dataset.pageNumber);
    if (!pageDiv || !container.contains(pageDiv) || !Number.isInteger(page)) return;
    event.preventDefault();
    event.stopPropagation();
    document.getSelection()?.removeAllRanges();
    const band = document.createElement("div");
    band.className = "scient-pdf-region-band";
    pageDiv.append(band);
    pageDiv.setPointerCapture(event.pointerId);
    const start = fractionIn(pageDiv, event);
    drag = { pointerId: event.pointerId, pageDiv, page, start, end: start, band };
    placeBand();
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    drag.end = fractionIn(drag.pageDiv, event);
    placeBand();
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    drag.end = fractionIn(drag.pageDiv, event);
    placeBand();
    const { pageDiv, page, start, end } = drag;
    const bounds = DOMRect.fromRect(drag.band.getBoundingClientRect());
    endDrag();
    swallowNextClick();
    const tooSmall =
      Math.abs(end.x - start.x) * pageDiv.clientWidth < MIN_DRAG ||
      Math.abs(end.y - start.y) * pageDiv.clientHeight < MIN_DRAG;
    if (tooSmall) return;
    const view = pdfPageView(runtime, page);
    const geometry = view ? pdfPageGeometry(view, page) : null;
    if (!view || !geometry) return;
    const rect = pdfRegionFromPageFractions(view.viewport, geometry.viewBox, start, end);
    if (!rect) return;
    handlers.onDrawn(
      {
        selector: {
          type: "region",
          pages: [
            {
              page,
              viewBox: [...geometry.viewBox],
              rotation: geometry.rotation,
              userUnit: geometry.userUnit,
              rect,
            },
          ],
        },
      },
      bounds,
    );
  };
  const onPointerCancel = (event: PointerEvent) => {
    if (drag?.pointerId === event.pointerId) endDrag();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    endDrag();
    handlers.onCancel();
  };
  // The click that ends a drag would open an annotation under the pointer, even after drawing ends.
  const swallowNextClick = () => {
    const swallow = (event: MouseEvent) => event.stopPropagation();
    document.addEventListener("click", swallow, { capture: true, once: true });
    document.defaultView?.setTimeout(
      () => document.removeEventListener("click", swallow, { capture: true }),
      0,
    );
  };

  container.addEventListener("pointerdown", onPointerDown, true);
  container.addEventListener("pointermove", onPointerMove, true);
  container.addEventListener("pointerup", onPointerUp, true);
  container.addEventListener("pointercancel", onPointerCancel, true);
  document.addEventListener("keydown", onKeyDown, true);
  return () => {
    endDrag();
    delete container.dataset.drawingRegion;
    container.removeEventListener("pointerdown", onPointerDown, true);
    container.removeEventListener("pointermove", onPointerMove, true);
    container.removeEventListener("pointerup", onPointerUp, true);
    container.removeEventListener("pointercancel", onPointerCancel, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };
}
