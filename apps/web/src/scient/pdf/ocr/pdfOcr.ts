import { msg } from "gt-react";
import {
  AnnotationMode,
  OPS,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";

import { m } from "~/i18n/messages";

import type { ScientPdfRuntime } from "../pdfRuntime";
import { createIndexedDbPdfOcrCache, createMemoryPdfOcrCache } from "./pdfOcrCache";
import { createTesseractOcrEngine, pdfOcrConcurrency, type PdfOcrEngine } from "./pdfOcrEngine";
import { createPdfOcrQueue } from "./pdfOcrQueue";
import {
  createPdfOcrSession,
  type PdfOcrDependencies,
  type PdfOcrDocument,
  type PdfOcrPage,
  type PdfOcrSession,
} from "./pdfOcrSession";
import { PDF_OCR_RECOGNIZER, pdfTextLayerHasOcr } from "./pdfOcrText";

const OCR_DPI = 300;
const MAX_SIDE = 4_200;
const MAX_PIXELS = 16_000_000;
/** PDF.js text layers measure this font the same way (TextLayer#getAscent). */
const OCR_FONT_FAMILY = "sans-serif";
const PDFJS_MEASURE_SIZE = 30;
const FINISHED = 3;

async function renderForRecognition(page: PdfOcrPage, rotation: number) {
  const proxy = page as unknown as PDFPageProxy;
  const base = proxy.getViewport({ scale: 1, rotation });
  const scale = Math.min(
    OCR_DPI / 72,
    MAX_SIDE / Math.max(base.width, base.height),
    Math.sqrt(MAX_PIXELS / (base.width * base.height)),
  );
  const viewport = proxy.getViewport({ scale, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const canvasContext = canvas.getContext("2d", { alpha: false });
  if (!canvasContext) throw new Error("No canvas is available for text recognition.");
  try {
    await proxy.render({
      canvas,
      canvasContext,
      viewport,
      annotationMode: AnnotationMode.ENABLE_FORMS,
      background: "#ffffff",
    }).promise;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("The page image was empty."))),
        "image/png",
      ),
    );
    return {
      blob,
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

let measuredAscent: number | null = null;
function textLayerAscent(): number {
  if (measuredAscent !== null) return measuredAscent;
  const context = document.createElement("canvas").getContext("2d");
  let ratio = 0.8;
  if (context) {
    context.font = `${PDFJS_MEASURE_SIZE}px ${OCR_FONT_FAMILY}`;
    const metrics = context.measureText("");
    const ascent = metrics.fontBoundingBoxAscent;
    const descent = Math.abs(metrics.fontBoundingBoxDescent);
    if (ascent) ratio = ascent / (ascent + descent);
  }
  measuredAscent = ratio;
  return ratio;
}

let shared: PdfOcrDependencies | null = null;
function sharedDependencies(): PdfOcrDependencies {
  if (shared) return shared;
  const slots = pdfOcrConcurrency();
  let engine: PdfOcrEngine | null = null;
  shared = {
    engine: () => (engine ??= createTesseractOcrEngine(slots)),
    queue: createPdfOcrQueue(slots),
    cache:
      typeof indexedDB === "undefined"
        ? createMemoryPdfOcrCache()
        : createIndexedDbPdfOcrCache(PDF_OCR_RECOGNIZER),
    render: renderForRecognition,
    ascent: textLayerAscent,
    ops: OPS,
    annotationMode: AnnotationMode.ENABLE_FORMS,
  };
  return shared;
}

const sessions = new WeakMap<PDFDocumentProxy, PdfOcrSession>();

/**
 * The recognition session of an open PDF, created before a viewer reads its pages. `key`
 * names its bytes (the document cache key) so readings are found again; null when unknown.
 */
export function pdfOcrSession(
  document: PDFDocumentProxy,
  key: string | null,
  passwordProtected = false,
): PdfOcrSession {
  let session = sessions.get(document);
  if (!session) {
    const dependencies = sharedDependencies();
    session = createPdfOcrSession(
      document as unknown as PdfOcrDocument,
      key,
      passwordProtected ? { ...dependencies, cache: createMemoryPdfOcrCache() } : dependencies,
    );
    sessions.set(document, session);
  }
  return session;
}

export function disposePdfOcrSession(document: PDFDocumentProxy): void {
  sessions.get(document)?.dispose();
  sessions.delete(document);
}

/** A page's own text, never waiting for recognition. */
export function pdfNativeTextContent(
  document: PDFDocumentProxy,
  page: PDFPageProxy,
  params?: object,
): ReturnType<PDFPageProxy["getTextContent"]> {
  const session = sessions.get(document);
  return session
    ? (session.nativeTextContent(page as unknown as PdfOcrPage, params) as ReturnType<
        PDFPageProxy["getTextContent"]
      >)
    : page.getTextContent(params);
}

interface OcrPageView {
  readonly id: number;
  readonly div: HTMLDivElement;
  readonly renderingState: number;
  readonly viewport: unknown;
  readonly textLayer: {
    readonly div: HTMLDivElement;
    cancel(): void;
    render(options: { viewport: unknown; images: null }): Promise<void>;
  } | null;
}

interface VisibleViewer {
  _getVisiblePages(): { readonly ids: Set<number> };
}

/**
 * Connects a reader to its PDF's recognition: reports the pages it shows, labels pages being
 * read, and redraws a page's text layer once it has been read, except under a selection,
 * which is left alone until it moves.
 */
export function attachPdfOcr(runtime: ScientPdfRuntime, session: PdfOcrSession): () => void {
  const viewer = runtime.viewer;
  const owner = {};
  const deferred = new Set<number>();
  const view = (page: number) => viewer.getPageView(page - 1) as OcrPageView | undefined;

  const badge = (page: number) => {
    const pageView = view(page);
    if (!pageView) return;
    const existing = pageView.div.querySelector(":scope > .scient-pdf-ocr-badge");
    if (session.pageState(page) !== "pending" || pageView.renderingState !== FINISHED) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const label = pageView.div.ownerDocument.createElement("div");
    label.className = "scient-pdf-ocr-badge";
    label.setAttribute("aria-hidden", "true");
    label.textContent = m(msg("Reading text…"));
    pageView.div.append(label);
  };

  const selectionInside = (layer: HTMLElement) => {
    const selection = layer.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
    return layer.contains(selection.anchorNode) || layer.contains(selection.focusNode);
  };

  /** Draws a page's text layer again when it lacks recognized text the page now has. */
  const redraw = (page: number) => {
    const pageView = view(page);
    const textLayer = pageView?.textLayer;
    if (!pageView || !textLayer || pageView.renderingState !== FINISHED) return;
    if (!session.recognized(page) || pdfTextLayerHasOcr(textLayer.div)) return;
    if (selectionInside(textLayer.div)) {
      deferred.add(page);
      return;
    }
    deferred.delete(page);
    textLayer.cancel();
    void textLayer.render({ viewport: pageView.viewport, images: null }).then(
      () =>
        runtime.eventBus.dispatch("textlayerrendered", {
          source: pageView,
          pageNumber: page,
          error: null,
        }),
      () => undefined,
    );
  };

  const onChange = (page: number | null) => {
    if (page === null) return;
    badge(page);
    redraw(page);
  };
  // A layer drawn while its page was being read is drawn again once the reading is ready.
  const onTextLayer = ({ pageNumber }: { pageNumber: number }) => redraw(pageNumber);
  const onPageRendered = ({ pageNumber }: { pageNumber: number }) => badge(pageNumber);
  const onViewArea = () => {
    session.setVisible(owner, new Set((viewer as unknown as VisibleViewer)._getVisiblePages().ids));
  };
  const onSelection = () => {
    for (const page of deferred) {
      const layer = view(page)?.textLayer?.div;
      if (!layer || !selectionInside(layer)) redraw(page);
    }
  };

  runtime.eventBus.on("textlayerrendered", onTextLayer);
  runtime.eventBus.on("pagerendered", onPageRendered);
  runtime.eventBus.on("updateviewarea", onViewArea);
  runtime.eventBus.on("pagesloaded", onViewArea);
  const unsubscribe = session.subscribe(onChange);
  const ownerDocument = runtime.viewer.container.ownerDocument;
  ownerDocument.addEventListener("selectionchange", onSelection);
  return () => {
    unsubscribe();
    ownerDocument.removeEventListener("selectionchange", onSelection);
    runtime.eventBus.off("textlayerrendered", onTextLayer);
    runtime.eventBus.off("pagerendered", onPageRendered);
    runtime.eventBus.off("updateviewarea", onViewArea);
    runtime.eventBus.off("pagesloaded", onViewArea);
    session.release(owner);
  };
}
