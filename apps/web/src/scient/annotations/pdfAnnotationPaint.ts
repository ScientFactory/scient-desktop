import type { ScientPdfAnnotation } from "@t3tools/contracts";

import {
  pdfPageView,
  renderedTextLayer,
  textLayerText,
  textRangeDomRanges,
} from "../pdf/anchors/pdfTextLayer";
import type { ScientPdfRuntime } from "../pdf/pdfRuntime";
import { annotationRangeOnPage } from "./annotationPlacement";

export interface PdfAnnotationPainter {
  readonly update: (annotations: ReadonlyArray<ScientPdfAnnotation>) => void;
  /** The annotation painted under a viewport point, if any. */
  readonly annotationAt: (x: number, y: number) => ScientPdfAnnotation | null;
  /** Where an annotation is painted now, for anchoring a popover. */
  readonly boundsOf: (annotationId: string) => DOMRect | null;
  readonly dispose: () => void;
}

let nextPainter = 0;
const HIT_SLOP = 2;

/**
 * Paints saved highlights and notes on the rendered pages with the CSS Custom
 * Highlight API, and keeps them painted as pages render again (scroll, zoom,
 * rotation). A part that cannot be placed exactly once on its page is skipped.
 */
export function paintPdfAnnotations(
  runtime: ScientPdfRuntime,
  container: HTMLElement,
): PdfAnnotationPainter {
  const registry = typeof CSS === "undefined" ? undefined : CSS.highlights;
  const supported = registry !== undefined && typeof Highlight !== "undefined";
  const id = ++nextPainter;
  const highlightName = `scient-pdf-annotation-${id}`;
  const noteName = `scient-pdf-annotation-note-${id}`;
  const style = container.ownerDocument.createElement("style");
  style.textContent = [
    `.textLayer ::highlight(${highlightName}) { background: color-mix(in oklab, var(--warning) 32%, transparent); color: inherit; }`,
    `.textLayer ::highlight(${noteName}) { text-decoration: underline dotted var(--warning); text-decoration-thickness: 2px; text-underline-offset: 2px; color: inherit; }`,
  ].join("\n");
  container.append(style);

  let annotations: ReadonlyArray<ScientPdfAnnotation> = [];
  const painted = new Map<number, Map<string, Range[]>>();

  const publish = () => {
    if (!supported) return;
    const highlighted: Range[] = [];
    const noted: Range[] = [];
    const byId = new Map(annotations.map((annotation) => [annotation.annotationId, annotation]));
    for (const page of painted.values()) {
      for (const [annotationId, ranges] of page) {
        const annotation = byId.get(annotationId);
        if (!annotation) continue;
        if (annotation.highlighted) highlighted.push(...ranges);
        if (annotation.note) noted.push(...ranges);
      }
    }
    registry.set(highlightName, new Highlight(...highlighted));
    registry.set(noteName, new Highlight(...noted));
  };

  const paintPage = (page: number) => {
    const layer = renderedTextLayer(pdfPageView(runtime, page));
    const text = layer ? textLayerText(layer) : null;
    if (!layer || text === null) {
      painted.delete(page);
      return;
    }
    const onPage = new Map<string, Range[]>();
    for (const annotation of annotations) {
      const range = annotationRangeOnPage(annotation, page, text);
      if (!range) continue;
      const dom = textRangeDomRanges(layer, range.start, range.end);
      if (dom.length > 0) onPage.set(annotation.annotationId, dom);
    }
    painted.set(page, onPage);
  };

  const pagesWithAnnotations = () =>
    new Set(
      annotations.flatMap((annotation) =>
        annotation.anchor.selector.pages.map((selected) => selected.page),
      ),
    );

  const onRendered = (event: { pageNumber: number }) => {
    if (!pagesWithAnnotations().has(event.pageNumber)) return;
    paintPage(event.pageNumber);
    publish();
  };
  runtime.eventBus.on("textlayerrendered", onRendered);

  const rectsOf = (annotationId: string) =>
    [...painted.values()].flatMap((page) =>
      (page.get(annotationId) ?? []).flatMap((range) => [...range.getClientRects()]),
    );

  return {
    update: (next) => {
      annotations = next;
      painted.clear();
      for (const page of pagesWithAnnotations()) {
        if (page <= runtime.document.numPages) paintPage(page);
      }
      publish();
    },
    annotationAt: (x, y) => {
      for (const annotation of annotations) {
        const hit = rectsOf(annotation.annotationId).some(
          (rect) =>
            x >= rect.left - HIT_SLOP &&
            x <= rect.right + HIT_SLOP &&
            y >= rect.top - HIT_SLOP &&
            y <= rect.bottom + HIT_SLOP,
        );
        if (hit) return annotation;
      }
      return null;
    },
    boundsOf: (annotationId) => {
      const rects = rectsOf(annotationId).filter((rect) => rect.width > 0);
      const last = rects.at(-1);
      return last ? DOMRect.fromRect(last) : null;
    },
    dispose: () => {
      runtime.eventBus.off("textlayerrendered", onRendered);
      registry?.delete(highlightName);
      registry?.delete(noteName);
      style.remove();
    },
  };
}
