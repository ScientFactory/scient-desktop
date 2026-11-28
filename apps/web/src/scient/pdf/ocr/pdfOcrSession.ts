import { sha256 } from "@noble/hashes/sha2";

import type { PdfOcrCache } from "./pdfOcrCache";
import type { PdfOcrEngine } from "./pdfOcrEngine";
import { pdfPageImageCoverage, PDF_SCAN_IMAGE_COVERAGE, type PdfImageOps } from "./pdfOcrPageImage";
import { PDF_OCR_PRIORITY, type PdfOcrQueue, type PdfOcrQueueJob } from "./pdfOcrQueue";
import {
  PDF_NATIVE_TEXT_LIMIT,
  PDF_OCR_LAYER_ID,
  PDF_OCR_RECOGNIZER,
  pdfOcrTextContent,
  textContentCharacters,
  type PdfOcrLine,
  type PdfOcrPageText,
  type PdfOcrTextContent,
  type PdfOcrViewport,
} from "./pdfOcrText";

/** The parts of a PDF.js page the session reads and patches. */
export interface PdfOcrPage {
  readonly pageNumber: number;
  readonly rotate: number;
  readonly view: ArrayLike<number>;
  getTextContent(params?: object): Promise<PdfTextContentLike>;
  streamTextContent(params?: object): ReadableStream<PdfTextContentLike>;
  getOperatorList(params?: object): Promise<{
    readonly fnArray: ArrayLike<number>;
    readonly argsArray: ArrayLike<unknown>;
  }>;
  getViewport(params: { scale: number; rotation?: number }): PdfOcrViewport;
  cleanup(): boolean;
}

export interface PdfTextContentLike {
  readonly items: ReadonlyArray<object>;
  readonly styles: Record<string, unknown>;
  readonly lang?: string | null;
}

export interface PdfOcrDocument {
  readonly numPages: number;
  readonly isPureXfa?: boolean;
  getPage(pageNumber: number): Promise<PdfOcrPage>;
}

export interface PdfOcrImage {
  readonly blob: Blob;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface PdfOcrDependencies {
  readonly engine: () => PdfOcrEngine;
  readonly queue: PdfOcrQueue;
  readonly cache: PdfOcrCache;
  readonly render: (page: PdfOcrPage, rotation: number) => Promise<PdfOcrImage>;
  /** The text layer's ascent ratio for the font recognized words are drawn in. */
  readonly ascent: () => number;
  readonly ops: PdfImageOps;
  /** PDF.js's annotation mode for display, so classification reuses the viewer's parse. */
  readonly annotationMode: number;
}

export interface PdfOcrCoverage {
  readonly pageCount: number;
  /** Every page has been looked at, so `scanned` is the document's count. */
  readonly checked: boolean;
  readonly scanned: number;
  readonly recognized: number;
  readonly failed: number;
}

export type PdfOcrPageState = "native" | "unknown" | "pending" | "recognized" | "failed";

interface PageEntry {
  scanned: boolean | null;
  classifying: Promise<boolean> | null;
  /** Number of classification errors for this page; caps retries so a broken page cannot loop. */
  classifyFailures: number;
  /** The page's own non-space characters (capped at `PDF_NATIVE_TEXT_LIMIT`), once read. */
  characters: number | null;
  /** True when the page's own text content has zero items, avoiding redundant worker reads. */
  nativeEmpty: boolean;
  /** True once the page-key cache was checked for this page. */
  cacheChecked: boolean;
  /** True after an in-memory layer was evicted, so a return re-reads `byPage`. */
  evicted: boolean;
  content: PdfOcrTextContent | null;
  failed: boolean;
  task: Promise<PdfOcrTextContent | null> | null;
  job: PdfOcrQueueJob | null;
  priority: number;
  /** A search's look-ahead wants it read. */
  search: boolean;
  /** Callers of the page's `getTextContent` waiting for it. */
  asked: number;
  visible: number;
}

/** A search's pass over either discovered sparse pages or the whole document from `start`. */
interface SearchPass {
  /** When non-null, only these sparse pages are inspected; null walks all pages from `start`. */
  readonly targets: ReadonlyArray<number> | null;
  readonly start: number;
  offset: number;
  active: number;
  finished: boolean;
}

/**
 * Pages a search looks at, or waits to have read, at once. Each holds its page (and, while
 * queued, a job) until done, so a book is never queued whole.
 */
export const PDF_OCR_SEARCH_AHEAD = 4;

/** Words with this much confidence count towards how readable a reading is. */
const READABLE_CONFIDENCE = 60;
const READABLE_CHARACTERS = 40;
const STOP_AFTER_FAILURES = 3;
const FAILURE_COOLDOWN_MS = 30_000;
const MAX_CLASSIFY_FAILURES = 2;
const DEFAULT_MAX_RETAINED_PAGES = 4_000;
const EMPTY_TEXT_CONTENT: PdfTextContentLike = { items: [], styles: {}, lang: null };

function readable(lines: ReadonlyArray<PdfOcrLine>): { characters: number; words: number } {
  let characters = 0;
  let words = 0;
  for (const line of lines) {
    for (const word of line.words) {
      words += 1;
      if (word.confidence >= READABLE_CONFIDENCE)
        characters += word.text.replace(/\s/gu, "").length;
    }
  }
  return { characters, words };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const buffer =
      bytes.buffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer;
    return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)));
  }
  return hex(sha256(bytes));
}

/** Collects a text content stream as PDF.js's `getTextContent` does. */
async function collect(
  stream: ReadableStream<PdfTextContentLike>,
): Promise<PdfTextContentLike & { items: object[] }> {
  const content = {
    items: [] as object[],
    styles: {} as Record<string, unknown>,
    lang: null as string | null,
  };
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return content;
    content.lang ??= value.lang ?? null;
    Object.assign(content.styles, value.styles);
    content.items.push(...value.items);
  }
}

/** A page's own text followed by its recognized text, as the text layer draws them. */
export function composePdfTextContent(
  native: PdfTextContentLike,
  ocr: PdfOcrTextContent,
): PdfTextContentLike {
  return {
    ...native,
    items: [...native.items, ...ocr.items],
    styles: { ...native.styles, ...ocr.styles },
  };
}

export interface PdfOcrSession {
  /** Recognition so far; replaced, never mutated, on each change. */
  coverage(): PdfOcrCoverage;
  subscribe(listener: (page: number | null) => void): () => void;
  pageState(page: number): PdfOcrPageState;
  /** True when the page's text includes recognized text. */
  recognized(page: number): boolean;
  /**
   * The page one reader's search starts from, or null once its query is cleared or its search
   * closed. While any reader searches, the scanned pages are read a few at a time from there.
   */
  setSearch(viewer: object, from: number | null): void;
  /** While a reader's find controller extracts native text, background scan sweeps wait. */
  setFindExtracting(viewer: object, extracting: boolean): void;
  /** Suspends all OCR demand for a parked reader; when every reader is parked, queued work stops. */
  setParked(viewer: object, parked: boolean): void;
  /** The pages one reader shows; pages nobody shows or searches stop waiting. */
  setVisible(viewer: object, pages: ReadonlySet<number>): void;
  /** Stops waiting work for a reader that closed; the last one stops everything. */
  release(viewer: object): void;
  /** The PDF's own text, without recognized text. */
  nativeTextContent(page: PdfOcrPage, params?: object): Promise<PdfTextContentLike>;
  /** The page's own text and its recognized text if it is already read; never waits for it. */
  findTextContent(
    page: PdfOcrPage,
    params?: object,
  ): Promise<{ native: PdfTextContentLike; recognized: PdfOcrTextContent | null }>;
  dispose(): void;
}

/**
 * Text recognition for one open PDF. Patched pages' text includes scanned pages' recognized
 * words after their own: `getTextContent` waits for them, the text layer shows what is ready
 * and is redrawn when a page is read, and find (`findTextContent`) never waits.
 */
export function createPdfOcrSession(
  document: PdfOcrDocument,
  documentKey: string | null,
  dependencies: PdfOcrDependencies,
): PdfOcrSession {
  const entries = new Map<number, PageEntry>();
  /** The PDF's own text: PDF.js's `getTextContent` reads `this.streamTextContent`, so not that. */
  const originals = new WeakMap<PdfOcrPage, Pick<PdfOcrPage, "getTextContent">>();
  const listeners = new Set<(page: number | null) => void>();
  const viewers = new Map<object, ReadonlySet<number>>();
  const parkedViewers = new Set<object>();
  const searchers = new Map<object, number>();
  const extractingViewers = new Set<object>();
  const retainedContent = new Map<number, true>();
  const maxRetainedPages = Math.max(1, dependencies.cache.maxPages ?? DEFAULT_MAX_RETAINED_PAGES);
  let disposed = false;
  let pass: SearchPass | null = null;
  let scannedKnown = false;
  const sparseFindPages = new Set<number>();
  let checked = false;
  let consecutiveFailures = 0;
  let failuresPausedUntil = 0;
  let snapshot: PdfOcrCoverage | null = null;
  let snapshotDirty = true;
  let layerMarks = 0;
  let preloadedMap: Map<string, PdfOcrPageText> | null = null;
  let preloaded: Promise<Map<string, PdfOcrPageText>> | null =
    !document.isPureXfa && documentKey !== null && dependencies.cache.forDocument
      ? dependencies.cache
          .forDocument(documentKey)
          .catch(() => new Map<string, PdfOcrPageText>())
          .then((map) => {
            if (!disposed) preloadedMap = map;
            return map;
          })
      : null;

  const entry = (page: number): PageEntry => {
    let found = entries.get(page);
    if (!found) {
      found = {
        scanned: null,
        classifying: null,
        classifyFailures: 0,
        characters: null,
        nativeEmpty: false,
        cacheChecked: false,
        evicted: false,
        content: null,
        failed: false,
        task: null,
        job: null,
        priority: 0,
        search: false,
        asked: 0,
        visible: 0,
      };
      entries.set(page, found);
    }
    return found;
  };

  const emit = (page: number | null) => {
    snapshotDirty = true;
    for (const listener of listeners) listener(page);
  };

  const evictRetained = (candidate: number) => {
    retainedContent.delete(candidate);
    const found = entries.get(candidate);
    if (!found || !found.content) return;
    found.content = null;
    found.cacheChecked = false;
    found.evicted = true;
    emit(candidate);
  };

  const touchRetained = (pageNumber: number) => {
    retainedContent.delete(pageNumber);
    retainedContent.set(pageNumber, true);
    if (retainedContent.size <= maxRetainedPages) return;
    // Drop the oldest non-visible page first so active views stay populated.
    for (const candidate of retainedContent.keys()) {
      if (retainedContent.size <= maxRetainedPages) break;
      const found = entries.get(candidate);
      if (found && found.visible > 0) continue;
      evictRetained(candidate);
    }
    for (const candidate of retainedContent.keys()) {
      if (retainedContent.size <= maxRetainedPages) break;
      evictRetained(candidate);
    }
  };

  const native = (page: PdfOcrPage) => originals.get(page) ?? page;

  const build = (page: PdfOcrPage, text: PdfOcrPageText): PdfOcrTextContent =>
    pdfOcrTextContent(
      text,
      page.getViewport({ scale: 1, rotation: text.rotation }),
      dependencies.ascent(),
    );

  const pageKey = (page: PdfOcrPage) =>
    documentKey === null ? null : `${documentKey}\n${page.pageNumber}\n${page.rotate}`;

  const markNative = (pageNumber: number, found: PageEntry) => {
    found.scanned = false;
    sparseFindPages.delete(pageNumber);
  };

  const markScanned = (pageNumber: number, found: PageEntry) => {
    const changed = found.scanned !== true;
    found.scanned = true;
    scannedKnown = true;
    sparseFindPages.delete(pageNumber);
    return changed;
  };

  /** Looks up a cached reading for this document page at most once until evicted. */
  const cachedByPage = async (
    page: PdfOcrPage,
    found: PageEntry,
  ): Promise<PdfOcrPageText | null> => {
    const key = pageKey(page);
    if (key === null || found.cacheChecked) return null;
    let stored: PdfOcrPageText | null = null;
    if (preloaded && !found.evicted) {
      const map = await preloaded;
      stored = map.get(key) ?? null;
      if (stored) map.delete(key);
    } else {
      stored = await dependencies.cache.byPage(key);
    }
    found.cacheChecked = true;
    found.evicted = false;
    return stored;
  };

  const applyCached = (page: PdfOcrPage, found: PageEntry, stored: PdfOcrPageText) => {
    markScanned(page.pageNumber, found);
    settle(page, stored);
  };

  const classify = (page: PdfOcrPage, content?: PdfTextContentLike): Promise<boolean> => {
    if (document.isPureXfa) return Promise.resolve(false);
    const found = entry(page.pageNumber);
    if (found.scanned !== null) return Promise.resolve(found.scanned);
    if (found.classifyFailures >= MAX_CLASSIFY_FAILURES) return Promise.resolve(false);
    found.classifying ??= (async () => {
      const characters = content
        ? textContentCharacters(content.items, PDF_NATIVE_TEXT_LIMIT)
        : (found.characters ??
          textContentCharacters(
            (await native(page).getTextContent({ disableNormalization: true })).items,
            PDF_NATIVE_TEXT_LIMIT,
          ));
      found.characters = characters;
      if (characters >= PDF_NATIVE_TEXT_LIMIT) return false;
      const operators = await page.getOperatorList({
        annotationMode: dependencies.annotationMode,
      });
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = Array.from(page.view);
      return (
        pdfPageImageCoverage(operators, dependencies.ops, (x2 - x1) * (y2 - y1)) >=
        PDF_SCAN_IMAGE_COVERAGE
      );
    })().then(
      (scanned) => {
        if (scanned) {
          markScanned(page.pageNumber, found);
          emit(page.pageNumber);
          startSearch();
        } else {
          markNative(page.pageNumber, found);
        }
        return scanned;
      },
      () => {
        found.classifying = null;
        found.classifyFailures += 1;
        sparseFindPages.delete(page.pageNumber);
        return false;
      },
    );
    return found.classifying;
  };

  /** Records a reading; the caller announces it. */
  const settle = (page: PdfOcrPage, text: PdfOcrPageText | null) => {
    const found = entry(page.pageNumber);
    if (text) {
      consecutiveFailures = 0;
      failuresPausedUntil = 0;
      found.content = build(page, text);
      found.failed = false;
      touchRetained(page.pageNumber);
    } else {
      found.failed = true;
    }
    return found.content;
  };

  const read = async (page: PdfOcrPage): Promise<PdfOcrPageText> => {
    const rotation = page.rotate;
    const image = await dependencies.render(page, rotation);
    // Equal pixels in PDFs with different intrinsic rotations map to different page coordinates.
    const imageHash = `${rotation}:${await sha256Hex(image.bytes)}`;
    const cached = await dependencies.cache.byImage(imageHash);
    if (cached) {
      void dependencies.cache.put(imageHash, pageKey(page), cached);
      return cached;
    }
    const engine = dependencies.engine();
    const lines = await engine.recognize(image.blob, image);
    const upright = readable(lines);
    let best = { rotation, lines, characters: upright.characters };
    // Little confident text among many words is often a page scanned sideways.
    if (upright.characters < READABLE_CHARACTERS && upright.words >= 5) {
      for (const turn of [90, 270, 180]) {
        if (disposed) break;
        const turned = (rotation + turn) % 360;
        const other = await dependencies.render(page, turned);
        const turnedLines = await engine.recognize(other.blob, other);
        const characters = readable(turnedLines).characters;
        if (characters > best.characters) {
          best = { rotation: turned, lines: turnedLines, characters };
          if (characters >= PDF_NATIVE_TEXT_LIMIT && characters > upright.characters * 2) break;
        }
      }
      if (best.characters <= Math.max(READABLE_CHARACTERS, upright.characters * 2)) {
        best = { rotation, lines, characters: upright.characters };
      }
    }
    const text: PdfOcrPageText = {
      recognizer: PDF_OCR_RECOGNIZER,
      rotation: best.rotation,
      lines: best.lines,
    };
    await dependencies.cache.put(imageHash, pageKey(page), text);
    return text;
  };

  const allViewersParked = () => viewers.size > 0 && parkedViewers.size >= viewers.size;

  const priorityOf = (found: PageEntry) =>
    allViewersParked()
      ? 0
      : found.visible > 0
        ? PDF_OCR_PRIORITY.visible
        : found.search || found.asked > 0
          ? PDF_OCR_PRIORITY.search
          : 0;

  const failureCooldownActive = () => {
    if (consecutiveFailures < STOP_AFTER_FAILURES) return false;
    if (Date.now() < failuresPausedUntil) return true;
    consecutiveFailures = 0;
    failuresPausedUntil = 0;
    let cleared = false;
    for (const found of entries.values()) {
      if (found.failed) {
        found.failed = false;
        cleared = true;
      }
    }
    if (cleared) checked = false;
    return false;
  };

  const recognize = (page: PdfOcrPage): Promise<PdfOcrTextContent | null> => {
    const found = entry(page.pageNumber);
    if (found.content) {
      touchRetained(page.pageNumber);
      return Promise.resolve(found.content);
    }
    if (disposed || document.isPureXfa) return Promise.resolve(null);
    if (found.task) {
      found.job?.setPriority(priorityOf(found));
      return found.task;
    }
    // Pause briefly after consecutive failures instead of hammering a broken engine; retry after cooldown.
    if (failureCooldownActive()) {
      found.failed = true;
      emit(page.pageNumber);
      return Promise.resolve(null);
    }
    emit(page.pageNumber);
    // A cancelled job frees the page at once, so a search that starts again queues it anew.
    let current = true;
    const release = () => {
      if (!current) return;
      current = false;
      found.task = null;
      found.job = null;
    };
    const task = (async () => {
      const stored = await cachedByPage(page, found);
      if (stored) {
        applyCached(page, found, stored);
        return found.content;
      }
      // Nobody wants it any more (it left the view, its search ended, its reader closed):
      // a page that comes back into view is asked for again by `setVisible`.
      if (disposed || !current || priorityOf(found) === 0) return null;
      return new Promise<PdfOcrTextContent | null>((resolve) => {
        found.priority = priorityOf(found);
        let ran = false;
        const job = dependencies.queue.add(found.priority, async () => {
          ran = true;
          if (disposed) {
            resolve(null);
            return;
          }
          try {
            resolve(settle(page, await read(page)));
          } catch {
            consecutiveFailures += 1;
            if (consecutiveFailures >= STOP_AFTER_FAILURES) {
              failuresPausedUntil = Date.now() + FAILURE_COOLDOWN_MS;
            }
            resolve(settle(page, null));
          }
        });
        found.job = {
          setPriority: job.setPriority,
          cancel: () => {
            if (ran || !job.cancel()) return false;
            release();
            resolve(null);
            return true;
          },
        };
      });
    })().finally(() => {
      release();
      emit(page.pageNumber);
    });
    found.task = task;
    return task;
  };

  const textFor = async (
    page: PdfOcrPage,
    content: PdfTextContentLike,
  ): Promise<PdfOcrTextContent | null> => {
    const found = entry(page.pageNumber);
    if (found.content) {
      touchRetained(page.pageNumber);
      return found.content;
    }
    const stored = await cachedByPage(page, found);
    if (stored) {
      applyCached(page, found, stored);
      emit(page.pageNumber);
      return found.content;
    }
    if (!(await classify(page, content))) return null;
    found.asked += 1;
    try {
      return await recognize(page);
    } finally {
      found.asked = Math.max(0, found.asked - 1);
    }
  };

  const patch = (page: PdfOcrPage) => {
    // Pure XFA forms extract text through `getXfa()`, not `streamTextContent()`; leave them untouched.
    if (document.isPureXfa || originals.has(page)) return page;
    const streamTextContent = page.streamTextContent.bind(page);
    const getTextContent = (params?: object) => collect(streamTextContent(params));
    originals.set(page, { getTextContent });
    const patched = page as {
      getTextContent: PdfOcrPage["getTextContent"];
      streamTextContent: PdfOcrPage["streamTextContent"];
    };
    patched.getTextContent = async (params) => {
      const content = await getTextContent(params);
      const found = entry(page.pageNumber);
      found.nativeEmpty = content.items.length === 0;
      const characters = textContentCharacters(content.items, PDF_NATIVE_TEXT_LIMIT);
      found.characters ??= characters;
      if (characters >= PDF_NATIVE_TEXT_LIMIT) {
        markNative(page.pageNumber, found);
        return content;
      }
      if (disposed) return content;
      const ocr = await textFor(page, content);
      return ocr ? composePdfTextContent(content, ocr) : content;
    };
    patched.streamTextContent = (params) => {
      const source = streamTextContent(params);
      let reader: ReadableStreamDefaultReader<PdfTextContentLike> | null = null;
      let cancelled = false;
      return new ReadableStream<PdfTextContentLike>({
        start: async (controller) => {
          reader = source.getReader();
          let characters = 0;
          let itemCount = 0;
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              itemCount += value.items.length;
              if (characters < PDF_NATIVE_TEXT_LIMIT) {
                characters += textContentCharacters(
                  value.items,
                  PDF_NATIVE_TEXT_LIMIT - characters,
                );
              }
              controller.enqueue(value);
            }
            const found = entry(page.pageNumber);
            found.nativeEmpty = itemCount === 0;
            found.characters ??= characters;
            if (characters >= PDF_NATIVE_TEXT_LIMIT) {
              markNative(page.pageNumber, found);
            } else if (!disposed && found.scanned !== false) {
              if (!found.content) {
                const stored = await cachedByPage(page, found);
                if (stored && !found.content) {
                  applyCached(page, found, stored);
                  emit(page.pageNumber);
                }
              }
              if (found.content) {
                touchRetained(page.pageNumber);
                // Marked so the layer shows it holds recognized text (`pdfTextLayerHasOcr`).
                controller.enqueue({
                  items: [
                    { type: "beginMarkedContentProps", id: `${PDF_OCR_LAYER_ID}${++layerMarks}` },
                    ...found.content.items,
                    { type: "endMarkedContent" },
                  ],
                  styles: found.content.styles,
                });
              } else {
                // Drawn now with the page's own text; redrawn when the page has been read.
                void classify(page).then((scanned) => {
                  if (scanned && found.visible > 0) void recognize(page);
                });
              }
            }
            if (!cancelled) controller.close();
          } catch (error) {
            if (!cancelled) controller.error(error);
          }
        },
        cancel: (reason) => {
          cancelled = true;
          return reader?.cancel(reason);
        },
      });
    };
    return page;
  };

  const getPage = document.getPage.bind(document);
  (document as { getPage: PdfOcrDocument["getPage"] }).getPage = (pageNumber) =>
    getPage(pageNumber).then(patch);

  const updatePriorities = () => {
    for (const [page, found] of entries) {
      const next = priorityOf(found);
      if (!found.job || next === found.priority) continue;
      found.priority = next;
      if (next === 0) {
        if (found.job.cancel()) emit(page);
      } else {
        found.job.setPriority(next);
      }
    }
  };

  /** Looks at one page for a search and, if it is a scan, waits for its reading. */
  const look = async (number: number, live: () => boolean) => {
    const found = entry(number);
    let page: PdfOcrPage;
    try {
      page = await document.getPage(number);
    } catch {
      found.classifyFailures += 1;
      sparseFindPages.delete(number);
      return;
    }
    try {
      if (!found.content) {
        const stored = await cachedByPage(page, found);
        if (stored && !found.content) {
          applyCached(page, found, stored);
          emit(number);
          return;
        }
      }
      if (!live() || !(await classify(page)) || !live()) return;
      found.search = true;
      await recognize(page);
    } finally {
      // A page read for a search is not kept parsed unless someone shows it.
      if (entry(number).visible === 0) page.cleanup();
    }
  };

  /**
   * Walks either discovered sparse pages or (once a scan is known) all remaining pages from the
   * reader's page, a few at a time. A PDF with no scanned or sparse pages is never swept.
   */
  const pump = () => {
    const current = pass;
    if (!current || disposed) return;
    const live = () => pass === current && !disposed;
    const count = document.numPages;
    const total = current.targets ? current.targets.length : count;
    while (current.active < PDF_OCR_SEARCH_AHEAD && current.offset < total) {
      const number = current.targets
        ? current.targets[current.offset]!
        : ((current.start - 1 + current.offset) % count) + 1;
      current.offset += 1;
      const found = entry(number);
      if (
        found.scanned === false ||
        found.content ||
        found.failed ||
        found.classifyFailures >= MAX_CLASSIFY_FAILURES
      ) {
        continue;
      }
      if (found.task) {
        // Already being read for a reader that shows it.
        found.search = true;
        continue;
      }
      current.active += 1;
      void look(number, live)
        .catch(() => undefined)
        .finally(() => {
          current.active -= 1;
          pump();
        });
    }
    if (!current.finished && current.active === 0 && current.offset >= total) {
      current.finished = true;
      if (current.targets === null) {
        checked = true;
        emit(null);
      } else {
        pass = null;
        startSearch();
      }
    }
  };

  function startSearch() {
    if (disposed || document.isPureXfa || searchers.size === 0 || extractingViewers.size > 0)
      return;
    // A finished pass that skipped pages during cooldown retries them once cooldown elapses.
    if (!failureCooldownActive() && pass?.finished && !checked) pass = null;
    if (pass) return;
    if (!scannedKnown && sparseFindPages.size === 0) return;
    const [from] = searchers.values();
    if (from === undefined) return;
    const count = Math.max(1, document.numPages);
    const start = Math.min(Math.max(1, Math.trunc(from) || 1), count);
    const targets = scannedKnown
      ? null
      : [...sparseFindPages].toSorted(
          (a, b) => ((a - start + count) % count) - ((b - start + count) % count),
        );
    pass = { targets, start, offset: 0, active: 0, finished: false };
    pump();
  }

  /** No reader searches: waiting pages stop, and pages being read finish. */
  const stopSearch = () => {
    if (!pass) return;
    pass = null;
    for (const found of entries.values()) found.search = false;
    updatePriorities();
    emit(null);
  };

  const setVisible = (viewer: object, pages: ReadonlySet<number>) => {
    const before = viewers.get(viewer) ?? new Set<number>();
    viewers.set(viewer, pages);
    for (const page of before) if (!pages.has(page)) entry(page).visible -= 1;
    for (const page of pages) {
      if (before.has(page)) continue;
      const found = entry(page);
      found.visible += 1;
      // Retry a previously failed page once the failure cooldown has elapsed.
      if (found.failed && !failureCooldownActive()) found.failed = false;
      // A scan drawn before it came into view was left unread until someone looks at it.
      if (found.scanned && !found.content && !found.task && !found.failed && !disposed) {
        void document.getPage(page).then(recognize, () => null);
      }
    }
    updatePriorities();
  };

  return {
    coverage() {
      if (snapshot && !snapshotDirty) return snapshot;
      let scanned = 0;
      let recognized = 0;
      let failed = 0;
      for (const found of entries.values()) {
        if (found.scanned) scanned += 1;
        if (found.content) recognized += 1;
        else if (found.failed && !found.task) failed += 1;
      }
      snapshotDirty = false;
      if (
        snapshot &&
        snapshot.pageCount === document.numPages &&
        snapshot.checked === checked &&
        snapshot.scanned === scanned &&
        snapshot.recognized === recognized &&
        snapshot.failed === failed
      ) {
        return snapshot;
      }
      snapshot = { pageCount: document.numPages, checked, scanned, recognized, failed };
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pageState(page) {
      const found = entries.get(page);
      if (!found || found.scanned === null) return "unknown";
      if (!found.scanned) return "native";
      if (found.content) return "recognized";
      if (found.task) return "pending";
      return found.failed ? "failed" : "unknown";
    },
    recognized: (page) => Boolean(entries.get(page)?.content),
    setSearch(viewer, from) {
      if (from === null) {
        if (searchers.delete(viewer) && searchers.size === 0) stopSearch();
        return;
      }
      if (disposed || document.isPureXfa) return;
      searchers.set(viewer, from);
      startSearch();
    },
    setFindExtracting(viewer, extracting) {
      if (extracting) {
        if (!disposed) extractingViewers.add(viewer);
        return;
      }
      if (extractingViewers.delete(viewer) && extractingViewers.size === 0) startSearch();
    },
    setParked(viewer, parked) {
      if (parked) {
        if (!viewers.has(viewer)) viewers.set(viewer, new Set());
        parkedViewers.add(viewer);
      } else {
        parkedViewers.delete(viewer);
      }
      updatePriorities();
    },
    setVisible,
    release(viewer) {
      const before = viewers.get(viewer);
      if (before) {
        for (const page of before) entry(page).visible -= 1;
      }
      viewers.delete(viewer);
      parkedViewers.delete(viewer);
      const stoppedExtracting = extractingViewers.delete(viewer) && extractingViewers.size === 0;
      if (searchers.delete(viewer) && searchers.size === 0) stopSearch();
      else if (stoppedExtracting) startSearch();
      const idle = viewers.size === 0 && searchers.size === 0;
      if (idle) {
        // Nobody reads this PDF now: pages waiting for a text reader stop too.
        for (const found of entries.values()) found.asked = 0;
      }
      updatePriorities();
      if (idle) emit(null);
    },
    nativeTextContent: (page, params) => native(page).getTextContent(params),
    async findTextContent(page, params) {
      if (document.isPureXfa) {
        return { native: await native(page).getTextContent(params), recognized: null };
      }
      const found = entry(page.pageNumber);
      if (found.nativeEmpty && found.content) {
        touchRetained(page.pageNumber);
        return { native: EMPTY_TEXT_CONTENT, recognized: found.content };
      }
      // Read native text first so sequential Find never waits on IndexedDB preload.
      const content = await native(page).getTextContent(params);
      found.nativeEmpty = content.items.length === 0;
      found.characters ??= textContentCharacters(content.items, PDF_NATIVE_TEXT_LIMIT);
      if (found.characters >= PDF_NATIVE_TEXT_LIMIT) {
        if (found.scanned === null) markNative(page.pageNumber, found);
        return { native: content, recognized: null };
      }
      // Consume already-preloaded cache hits synchronously; never block later native pages on I/O.
      if (!found.content && !disposed && preloadedMap && !found.cacheChecked && !found.evicted) {
        const key = pageKey(page);
        if (key !== null) {
          const stored = preloadedMap.get(key) ?? null;
          found.cacheChecked = true;
          if (stored) {
            preloadedMap.delete(key);
            applyCached(page, found, stored);
            emit(page.pageNumber);
          }
        }
      }
      if (found.content) {
        touchRetained(page.pageNumber);
        return { native: content, recognized: found.content };
      }
      if (found.scanned === null && found.classifyFailures === 0 && !disposed) {
        sparseFindPages.add(page.pageNumber);
        startSearch();
      }
      return { native: content, recognized: null };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pass = null;
      preloaded = null;
      preloadedMap = null;
      parkedViewers.clear();
      retainedContent.clear();
      sparseFindPages.clear();
      extractingViewers.clear();
      for (const found of entries.values()) found.job?.cancel();
      listeners.clear();
    },
  };
}
