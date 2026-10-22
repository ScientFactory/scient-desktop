import {
  relocatePdfText,
  verifyPdfTarget,
  type PdfCurrentPage,
  type PdfTarget,
  type PdfTextRange,
} from "@scientfactory/document-artifacts";

import type { ScientPdfRuntime } from "../pdfRuntime";
import {
  pdfPageGeometry,
  pdfPageView,
  renderedTextLayer,
  textContentText,
  textLayerText,
  textRangeDomRanges,
} from "./pdfTextLayer";
import { PDF_EXTRACTOR_VERSION, pdfTextHash } from "./pdfTextTarget";

/** How a quote was found again in the PDF the reader shows now. */
export type PdfRevealOutcome =
  | { readonly _tag: "Exact" }
  | { readonly _tag: "Relocated" }
  | { readonly _tag: "Ambiguous"; readonly page: number }
  | { readonly _tag: "NotFound"; readonly page: number }
  | { readonly _tag: "Incomplete"; readonly page: number };

const TEXT_LAYER_TIMEOUT_MS = 4_000;
const SEARCH_DEADLINE_MS = 3_000;
const SEARCH_CONCURRENCY = 2;
let nextHighlight = 0;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

const LATE = Symbol("late");

/** Settles with the work, or LATE at the deadline, or rejects on abort; whichever is first. */
function bounded<A>(
  work: Promise<A>,
  deadline: number,
  signal: AbortSignal,
): Promise<A | typeof LATE> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(() => resolve(LATE)), Math.max(0, deadline - Date.now()));
    const onAbort = () => finish(() => reject(signal.reason));
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/** Waits until the page's text layer is on screen, scrolling the page into view. */
function textLayerFor(
  runtime: ScientPdfRuntime,
  page: number,
  signal: AbortSignal,
): Promise<HTMLElement | null> {
  throwIfAborted(signal);
  const ready = () => renderedTextLayer(pdfPageView(runtime, page));
  const existing = ready();
  if (existing) return Promise.resolve(existing);
  runtime.viewer.scrollPageIntoView({ pageNumber: page });
  return new Promise((resolve, reject) => {
    const finish = (layer: HTMLElement | null) => {
      clearTimeout(timer);
      runtime.eventBus.off("textlayerrendered", onRendered);
      signal.removeEventListener("abort", onAbort);
      resolve(layer);
    };
    const onRendered = (event: { pageNumber: number }) => {
      if (event.pageNumber === page) finish(ready());
    };
    const onAbort = () => {
      clearTimeout(timer);
      runtime.eventBus.off("textlayerrendered", onRendered);
      reject(signal.reason);
    };
    const timer = setTimeout(() => finish(ready()), TEXT_LAYER_TIMEOUT_MS);
    runtime.eventBus.on("textlayerrendered", onRendered);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function currentPage(
  runtime: ScientPdfRuntime,
  page: number,
  signal: AbortSignal,
): Promise<PdfCurrentPage | undefined> {
  if (page > runtime.document.numPages) return undefined;
  const layer = await textLayerFor(runtime, page, signal);
  const view = pdfPageView(runtime, page);
  const geometry = view ? pdfPageGeometry(view, page) : null;
  const text = layer ? textLayerText(layer) : null;
  if (!geometry || text === null) return undefined;
  return { ...geometry, text, textHash: pdfTextHash(text) };
}

/** Every page's text, two pages at a time, until the deadline; never longer. */
async function documentText(runtime: ScientPdfRuntime, signal: AbortSignal) {
  const deadline = Date.now() + SEARCH_DEADLINE_MS;
  const count = runtime.document.numPages;
  const pages: { page: number; text: string }[] = [];
  let next = 1;
  let complete = true;
  const read = async (number: number) => {
    const page = await runtime.document.getPage(number);
    const content = await page.getTextContent({
      includeMarkedContent: true,
      disableNormalization: true,
    });
    return textContentText(content.items);
  };
  const worker = async () => {
    while (complete && next <= count) {
      const number = next++;
      const text = await bounded(read(number), deadline, signal);
      if (text === LATE) {
        complete = false;
        return;
      }
      pages.push({ page: number, text });
    }
  };
  await Promise.all(Array.from({ length: SEARCH_CONCURRENCY }, worker));
  return { pages, complete };
}

/**
 * The offsets of a relocated range in the page's rendered text. Extraction
 * and the text layer normally agree; when they do not, the range's own text
 * must occur exactly once on the page.
 */
function renderedRange(
  range: PdfTextRange,
  extracted: string,
  rendered: string,
): PdfTextRange | null {
  if (rendered === extracted) return range;
  const part = extracted.slice(range.start, range.end);
  const at = rendered.indexOf(part);
  if (at < 0 || rendered.indexOf(part, at + 1) >= 0) return null;
  return { page: range.page, start: at, end: at + part.length };
}

export interface PdfQuoteHighlight {
  readonly ranges: ReadonlyArray<PdfTextRange>;
}

/**
 * Finds a stored quote in the PDF the reader shows. The stored offsets are
 * reused only when the live page text proves them; otherwise the whole
 * document is searched for the quote. Never guesses between repeats.
 */
export async function locatePdfQuote(
  runtime: ScientPdfRuntime,
  target: PdfTarget,
  signal: AbortSignal,
): Promise<{ outcome: PdfRevealOutcome; highlight: PdfQuoteHighlight | null }> {
  const stored = target.selector.pages;
  const first = stored[0]!.page;
  const live = new Map<number, PdfCurrentPage>();
  for (const page of stored) {
    throwIfAborted(signal);
    const current = await currentPage(runtime, page.page, signal);
    if (current) live.set(page.page, current);
  }
  const verification = verifyPdfTarget(target, {
    material: null,
    extractorVersion: PDF_EXTRACTOR_VERSION,
    page: (page) => live.get(page),
  });
  if (verification.selectorValid) {
    return {
      outcome: { _tag: "Exact" },
      highlight: { ranges: stored.map(({ page, start, end }) => ({ page, start, end })) },
    };
  }

  const document = await documentText(runtime, signal);
  throwIfAborted(signal);
  const relocation = relocatePdfText(target, document);
  const fallbackPage = Math.min(first, runtime.document.numPages);
  if (relocation._tag !== "Found") {
    return { outcome: { _tag: relocation._tag, page: fallbackPage }, highlight: null };
  }
  const ranges: PdfTextRange[] = [];
  for (const range of relocation.ranges) {
    const extracted = document.pages.find((page) => page.page === range.page)?.text ?? "";
    throwIfAborted(signal);
    const rendered = await currentPage(runtime, range.page, signal);
    const mapped = rendered ? renderedRange(range, extracted, rendered.text) : null;
    if (!mapped) {
      return { outcome: { _tag: "NotFound", page: range.page }, highlight: null };
    }
    ranges.push(mapped);
  }
  return { outcome: { _tag: "Relocated" }, highlight: { ranges } };
}

/**
 * Paints the quote with the CSS Custom Highlight API and keeps it painted as
 * pages re-render (zoom, rotation). Returns a function that clears it.
 */
export function paintPdfQuote(
  runtime: ScientPdfRuntime,
  highlight: PdfQuoteHighlight,
  container: HTMLElement,
): () => void {
  const registry = typeof CSS === "undefined" ? undefined : CSS.highlights;
  if (!registry || typeof Highlight === "undefined") return () => undefined;
  // One name per reader, so two readers of the same PDF never clear each other.
  const name = `scient-pdf-citation-${++nextHighlight}`;
  const style = container.ownerDocument.createElement("style");
  style.textContent = `.textLayer ::highlight(${name}) { background: color-mix(in oklab, var(--primary) 30%, transparent); color: inherit; }`;
  container.append(style);
  const paint = () => {
    const ranges = highlight.ranges.flatMap((range) => {
      const layer = renderedTextLayer(pdfPageView(runtime, range.page));
      return layer ? textRangeDomRanges(layer, range.start, range.end) : [];
    });
    registry.set(name, new Highlight(...ranges));
    return ranges;
  };
  const ranges = paint();
  ranges[0]?.startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });
  const onRendered = (event: { pageNumber: number }) => {
    if (highlight.ranges.some((range) => range.page === event.pageNumber)) paint();
  };
  runtime.eventBus.on("textlayerrendered", onRendered);
  return () => {
    runtime.eventBus.off("textlayerrendered", onRendered);
    registry.delete(name);
    style.remove();
  };
}

/** Shows the stored page when the quote itself cannot be shown. */
export function showPdfPage(runtime: ScientPdfRuntime, page: number): void {
  runtime.viewer.scrollPageIntoView({ pageNumber: page });
}
