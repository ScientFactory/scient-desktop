import {
  isScientRegionAnchor,
  type ScientPdfAnnotation,
  type ScientPdfRegionAnchor,
} from "@t3tools/contracts";

import {
  pdfPageView,
  renderedTextLayer,
  textLayerText,
  textRangeDomRanges,
} from "../pdf/anchors/pdfTextLayer";
import type { ScientPdfRuntime } from "../pdf/pdfRuntime";
import { annotationRangeOnPage } from "./annotationPlacement";
import { pdfRegionPageBox } from "./pdfRegionGeometry";

export interface PdfAnnotationPainter {
  readonly update: (annotations: ReadonlyArray<ScientPdfAnnotation>) => void;
  /** A box being drawn or waiting for its note, shown until it is saved or dropped. */
  readonly showDraft: (anchor: ScientPdfRegionAnchor | null) => void;
  /** The annotation painted under a viewport point, if any. */
  readonly annotationAt: (x: number, y: number) => ScientPdfAnnotation | null;
  /** Where an annotation is painted now, for anchoring a popover. */
  readonly boundsOf: (annotationId: string) => DOMRect | null;
  readonly dispose: () => void;
}

let nextPainter = 0;
const HIT_SLOP = 2;

/**
 * Paints saved highlights and notes with the CSS Custom Highlight API, and marked areas as
 * elements placed in fractions of their page, keeping both painted as pages render again
 * (scroll, zoom, rotation). A text part that cannot be placed exactly once is skipped.
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
        isScientRegionAnchor(annotation.anchor)
          ? []
          : annotation.anchor.selector.pages.map((selected) => selected.page),
      ),
    );

  const onRendered = (event: { pageNumber: number }) => {
    if (!pagesWithAnnotations().has(event.pageNumber)) return;
    paintPage(event.pageNumber);
    publish();
  };
  runtime.eventBus.on("textlayerrendered", onRendered);

  let draft: ScientPdfRegionAnchor | null = null;
  const regionLayers = new Map<number, HTMLElement>();
  let regionObserver: MutationObserver | null = null;
  const regionsOn = (page: number) => {
    const boxes: Array<{ readonly id: string | null; readonly anchor: ScientPdfRegionAnchor }> = [];
    for (const annotation of annotations) {
      const { anchor } = annotation;
      if (isScientRegionAnchor(anchor) && anchor.selector.pages[0].page === page) {
        boxes.push({ id: annotation.annotationId, anchor });
      }
    }
    if (draft?.selector.pages[0].page === page) boxes.push({ id: null, anchor: draft });
    return boxes;
  };
  const regionPages = () =>
    new Set([
      ...annotations.flatMap((annotation) =>
        isScientRegionAnchor(annotation.anchor) ? [annotation.anchor.selector.pages[0].page] : [],
      ),
      ...(draft ? [draft.selector.pages[0].page] : []),
    ]);
  const paintRegions = (page: number) => {
    regionLayers.get(page)?.remove();
    regionLayers.delete(page);
    const view = pdfPageView(runtime, page);
    const pageDiv = view?.div;
    if (!view?.pdfPage || !pageDiv) return;
    const boxes = regionsOn(page);
    if (boxes.length === 0) return;
    const byId = new Map(annotations.map((annotation) => [annotation.annotationId, annotation]));
    const layer = pageDiv.ownerDocument.createElement("div");
    layer.className = "scient-pdf-region-layer";
    for (const { id, anchor } of boxes) {
      const placed = pdfRegionPageBox(view.viewport, anchor.selector.pages[0].rect);
      const box = pageDiv.ownerDocument.createElement("div");
      box.className = "scient-pdf-region";
      const annotation = id === null ? undefined : byId.get(id);
      if (annotation) {
        box.dataset.annotationId = annotation.annotationId;
        box.dataset.look = annotation.highlighted ? "fill" : "note";
        if (annotation.color) box.style.setProperty("--scient-region-color", annotation.color);
      } else {
        box.dataset.look = "draft";
      }
      box.style.left = `${placed.left * 100}%`;
      box.style.top = `${placed.top * 100}%`;
      box.style.width = `${placed.width * 100}%`;
      box.style.height = `${placed.height * 100}%`;
      layer.append(box);
    }
    pageDiv.append(layer);
    regionLayers.set(page, layer);
    regionObserver?.observe(pageDiv, { childList: true });
  };
  // pdf.js empties a page's element when it zooms, rotates or recycles it, keeping only its own layers.
  regionObserver =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => {
          for (const page of regionPages()) {
            if (regionLayers.get(page)?.isConnected === false) paintRegions(page);
          }
        });
  const onPageRendered = (event: { pageNumber: number }) => {
    if (regionPages().has(event.pageNumber)) paintRegions(event.pageNumber);
  };
  runtime.eventBus.on("pagerendered", onPageRendered);
  const repaintRegions = () => {
    const pages = regionPages();
    for (const page of regionLayers.keys()) if (!pages.has(page)) paintRegions(page);
    for (const page of pages) if (page <= runtime.document.numPages) paintRegions(page);
  };

  const rectsOf = (annotationId: string) =>
    [...painted.values()].flatMap((page) =>
      (page.get(annotationId) ?? []).flatMap((range) => [...range.getClientRects()]),
    );
  const regionRectOf = (annotationId: string) => {
    for (const layer of regionLayers.values()) {
      for (const box of layer.children) {
        if (box instanceof HTMLElement && box.dataset.annotationId === annotationId) {
          return box.getBoundingClientRect();
        }
      }
    }
    return null;
  };
  const inside = (rect: DOMRect, x: number, y: number) =>
    x >= rect.left - HIT_SLOP &&
    x <= rect.right + HIT_SLOP &&
    y >= rect.top - HIT_SLOP &&
    y <= rect.bottom + HIT_SLOP;

  return {
    update: (next) => {
      annotations = next;
      painted.clear();
      for (const page of pagesWithAnnotations()) {
        if (page <= runtime.document.numPages) paintPage(page);
      }
      publish();
      repaintRegions();
    },
    showDraft: (anchor) => {
      draft = anchor;
      repaintRegions();
    },
    annotationAt: (x, y) => {
      for (const annotation of annotations) {
        if (rectsOf(annotation.annotationId).some((rect) => inside(rect, x, y))) return annotation;
      }
      // Text marked inside a box opens first; of nested boxes, the smallest.
      let found: { readonly annotation: ScientPdfAnnotation; readonly area: number } | null = null;
      for (const annotation of annotations) {
        const rect = regionRectOf(annotation.annotationId);
        if (!rect || !inside(rect, x, y)) continue;
        const area = rect.width * rect.height;
        if (!found || area < found.area) found = { annotation, area };
      }
      return found?.annotation ?? null;
    },
    boundsOf: (annotationId) => {
      const region = regionRectOf(annotationId);
      if (region) return DOMRect.fromRect(region);
      const rects = rectsOf(annotationId).filter((rect) => rect.width > 0);
      const last = rects.at(-1);
      return last ? DOMRect.fromRect(last) : null;
    },
    dispose: () => {
      runtime.eventBus.off("textlayerrendered", onRendered);
      runtime.eventBus.off("pagerendered", onPageRendered);
      regionObserver?.disconnect();
      for (const layer of regionLayers.values()) layer.remove();
      regionLayers.clear();
      for (const name of looks.keys()) registry?.delete(name);
      registry?.delete(noteName);
      style.remove();
    },
  };
}
