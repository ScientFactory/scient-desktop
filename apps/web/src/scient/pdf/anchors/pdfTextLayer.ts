import { PDF_TARGET_LIMITS } from "@scientfactory/document-artifacts";
import type { PDFPageView } from "pdfjs-dist/types/web/pdf_page_view";

import type { ScientPdfRuntime } from "../pdfRuntime";

/**
 * The text layer as one string per page, in the profile the PDF target
 * stores (raw item text, a newline for each line break), plus the DOM
 * geometry that maps offsets in that string to and from the page.
 *
 * Ported from the Phase 2A passage capture (Sources annotations, 2026-09).
 */

const MAX_PAGE_CHARACTERS = 250_000;
const MAX_PAGE_NODES = 50_000;

export type PdfSelectionRefusal =
  | "too-many-pages"
  | "page-not-ready"
  | "page-too-complex"
  | "unsupported-text-angle"
  | "selection-too-large"
  | "invalid-selection";

export const PDF_SELECTION_REFUSAL_COPY: Record<PdfSelectionRefusal, string> = {
  "too-many-pages": "Select up to four consecutive pages.",
  "page-not-ready": "Wait for the pages to finish loading, then select again.",
  "page-too-complex": "This page has too much text to quote from.",
  "unsupported-text-angle": "Diagonal text can't be quoted yet.",
  "selection-too-large": "Shorten selection",
  "invalid-selection": "Select text inside the PDF pages.",
};

export interface PdfPageGeometry {
  readonly page: number;
  readonly viewBox: readonly [number, number, number, number];
  readonly rotation: number;
  readonly userUnit: number;
}

export interface PdfSelectedPage extends PdfPageGeometry {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export type PdfTextSelection =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Ready"; readonly pages: ReadonlyArray<PdfSelectedPage> }
  | { readonly _tag: "Refused"; readonly reason: PdfSelectionRefusal };

interface TextPiece {
  readonly node: Node;
  readonly text: string;
}

// PDFViewer.getPageView is typed `any`; constrain it at this one seam.
export function pdfPageView(runtime: ScientPdfRuntime, page: number): PDFPageView | undefined {
  return runtime.viewer.getPageView(page - 1) as PDFPageView | undefined;
}

export function pdfPageGeometry(view: PDFPageView, page: number): PdfPageGeometry | null {
  const pdfPage = view.pdfPage;
  if (!pdfPage) return null;
  const [x1, y1, x2, y2] = pdfPage.view;
  return {
    page,
    viewBox: [x1!, y1!, x2!, y2!],
    rotation: pdfPage.rotate,
    userUnit: pdfPage.userUnit,
  };
}

/** The rendered text layer of a page, or null while it is not on screen. */
export function renderedTextLayer(view: PDFPageView | undefined): HTMLElement | null {
  const layer = view?.textLayer?.div;
  return layer && layer.isConnected && !layer.hidden ? layer : null;
}

function textPieces(layer: HTMLElement): TextPiece[] | null {
  const pieces: TextPiece[] = [];
  const walker = layer.ownerDocument.createTreeWalker(
    layer,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );
  let nodes = 0;
  let characters = 0;
  while (walker.nextNode()) {
    if (++nodes > MAX_PAGE_NODES) return null;
    const node = walker.currentNode;
    if ((node instanceof Element ? node : node.parentElement)?.closest(".endOfContent")) continue;
    const text =
      node.nodeType === Node.TEXT_NODE
        ? (node.textContent ?? "")
        : node instanceof HTMLBRElement
          ? "\n"
          : "";
    characters += text.length;
    if (characters > MAX_PAGE_CHARACTERS) return null;
    if (text) pieces.push({ node, text });
  }
  return pieces;
}

/** The page's text in the target profile, or null when it is too large to read. */
export function textLayerText(layer: HTMLElement): string | null {
  const pieces = textPieces(layer);
  return pieces ? pieces.map((piece) => piece.text).join("") : null;
}

function closestTextLayer(node: Node): HTMLElement | null {
  return (
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".textLayer") ??
    null
  );
}

function isQuarterTurn(span: Element | null): boolean {
  const angle = Number.parseFloat(
    span ? getComputedStyle(span).getPropertyValue("--rotate") || "0" : "0",
  );
  return Number.isFinite(angle) && Math.abs(angle / 90 - Math.round(angle / 90)) <= 0.0001;
}

/**
 * Reads the current selection as page offsets, synchronously, before focus
 * moves. A selection that is not entirely inside this viewer's text layers is
 * Empty, so other surfaces' selections are left alone.
 */
export function readPdfTextSelection(
  runtime: ScientPdfRuntime,
  selection: Selection | null,
): PdfTextSelection {
  const refuse = (reason: PdfSelectionRefusal): PdfTextSelection => ({ _tag: "Refused", reason });
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return { _tag: "Empty" };
  const range = selection.getRangeAt(0);
  const startLayer = closestTextLayer(range.startContainer);
  const endLayer = closestTextLayer(range.endContainer);
  const viewer = runtime.viewer.viewer;
  if (!startLayer || !endLayer || !viewer?.contains(startLayer) || !viewer.contains(endLayer)) {
    return { _tag: "Empty" };
  }
  const first = Number(startLayer.closest<HTMLElement>(".page")?.dataset.pageNumber);
  const last = Number(endLayer.closest<HTMLElement>(".page")?.dataset.pageNumber);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) {
    return refuse("invalid-selection");
  }
  // The first and last page may each hold only the selection's boundary; a
  // wider span cannot fit. Pages with selected text are counted below.
  if (last - first > PDF_TARGET_LIMITS.pages + 1) return refuse("too-many-pages");

  const pages: PdfSelectedPage[] = [];
  let characters = 0;
  for (let number = first; number <= last; number += 1) {
    const view = pdfPageView(runtime, number);
    const layer = renderedTextLayer(view);
    const geometry = view ? pdfPageGeometry(view, number) : null;
    if (!view || !layer || !geometry) return refuse("page-not-ready");
    const pieces = textPieces(layer);
    if (!pieces) return refuse("page-too-complex");
    let offset = 0;
    let start = Infinity;
    let end = 0;
    for (const piece of pieces) {
      const node = piece.node;
      if (range.intersectsNode(node)) {
        const isText = node.nodeType === Node.TEXT_NODE;
        const from = node === range.startContainer ? range.startOffset : 0;
        const to = node === range.endContainer ? range.endOffset : piece.text.length;
        const before = isText ? range.comparePoint(node, piece.text.length) < 0 : false;
        const after = isText ? range.comparePoint(node, 0) > 0 : false;
        if (!before && !after && from < to) {
          if (isText && !isQuarterTurn(node.parentElement)) return refuse("unsupported-text-angle");
          characters += to - from;
          if (characters > PDF_TARGET_LIMITS.characters) return refuse("selection-too-large");
          start = Math.min(start, offset + from);
          end = Math.max(end, offset + to);
        }
      }
      offset += piece.text.length;
    }
    const text = pieces.map((piece) => piece.text).join("");
    // A page the range only touches at a boundary contributes nothing.
    if (!Number.isFinite(start) || !text.slice(start, end).trim()) continue;
    pages.push({ ...geometry, text, start, end });
  }
  if (pages.length === 0) return { _tag: "Empty" };
  if (pages.length > PDF_TARGET_LIMITS.pages) return refuse("too-many-pages");
  return { _tag: "Ready", pages };
}

/**
 * DOM ranges covering `[start, end)` of a rendered page's text layer, for
 * painting a highlight. Empty when the offsets no longer fit its text.
 */
export function textRangeDomRanges(layer: HTMLElement, start: number, end: number): Range[] {
  const pieces = textPieces(layer);
  if (!pieces || start >= end) return [];
  const ranges: Range[] = [];
  let offset = 0;
  for (const piece of pieces) {
    const from = Math.max(start, offset);
    const to = Math.min(end, offset + piece.text.length);
    if (from < to && piece.node.nodeType === Node.TEXT_NODE) {
      const range = layer.ownerDocument.createRange();
      range.setStart(piece.node, from - offset);
      range.setEnd(piece.node, to - offset);
      ranges.push(range);
    }
    offset += piece.text.length;
    if (offset >= end) break;
  }
  return ranges;
}

/** The same profile from `getTextContent` items, for pages that are not rendered. */
export function textContentText(items: ReadonlyArray<object>): string {
  return items
    .map((item) =>
      "str" in item && typeof item.str === "string"
        ? item.str + ("hasEOL" in item && item.hasEOL ? "\n" : "")
        : "",
    )
    .join("");
}
