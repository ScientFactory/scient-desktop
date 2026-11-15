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
  const noteName = `scient-pdf-annotation-note-${id}`;
  const noteRule = `.textLayer ::highlight(${noteName}) { text-decoration: underline dotted var(--warning); text-decoration-thickness: 2px; text-underline-offset: 2px; color: inherit; }`;
  const style = container.ownerDocument.createElement("style");
  style.textContent = noteRule;
  container.append(style);
  // One registered highlight for each look in use: Scient's own, or a colour and kind kept
  // from the reader a highlight was made in.
  let looks = new Map<string, string>();

  let annotations: ReadonlyArray<ScientPdfAnnotation> = [];
  const painted = new Map<number, Map<string, Range[]>>();

  const lookOf = (annotation: ScientPdfAnnotation) => {
    const color = annotation.color ?? "var(--warning)";
    const name = `scient-pdf-annotation-${id}-${annotation.underline ? "line" : "fill"}-${annotation.color?.slice(1) ?? "own"}`;
    const rule = annotation.underline
      ? `text-decoration: underline solid ${color}; text-decoration-thickness: 2px; text-underline-offset: 2px;`
      : `background: color-mix(in oklab, ${color} ${annotation.color ? 40 : 32}%, transparent);`;
    return { name, css: `.textLayer ::highlight(${name}) { ${rule} color: inherit; }` };
  };

  const publish = () => {
    if (!supported) return;
    const highlighted = new Map<string, { readonly css: string; readonly ranges: Range[] }>();
    const noted: Range[] = [];
    const byId = new Map(annotations.map((annotation) => [annotation.annotationId, annotation]));
    for (const page of painted.values()) {
      for (const [annotationId, ranges] of page) {
        const annotation = byId.get(annotationId);
        if (!annotation) continue;
        if (annotation.highlighted) {
          const look = lookOf(annotation);
          const group = highlighted.get(look.name) ?? { css: look.css, ranges: [] };
          group.ranges.push(...ranges);
          highlighted.set(look.name, group);
        }
        if (annotation.note) noted.push(...ranges);
      }
    }
    for (const name of looks.keys()) if (!highlighted.has(name)) registry.delete(name);
    for (const [name, group] of highlighted) registry.set(name, new Highlight(...group.ranges));
    registry.set(noteName, new Highlight(...noted));
    looks = new Map([...highlighted].map(([name, group]) => [name, group.css]));
    style.textContent = [...looks.values(), noteRule].join("\n");
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
      for (const name of looks.keys()) registry?.delete(name);
      registry?.delete(noteName);
      style.remove();
    },
  };
}
