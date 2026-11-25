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
  content: PdfOcrTextContent | null;
  failed: boolean;
  task: Promise<PdfOcrTextContent | null> | null;
  job: PdfOcrQueueJob | null;
  priority: number;
  search: boolean;
  visible: number;
}

/** Words with this much confidence count towards how readable a reading is. */
const READABLE_CONFIDENCE = 60;
const READABLE_CHARACTERS = 40;
const STOP_AFTER_FAILURES = 3;

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

function compose(native: PdfTextContentLike, ocr: PdfOcrTextContent): PdfTextContentLike {
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
  /** Looks at every page and reads the scanned ones, for a search. */
  recognizeAll(): void;
  /** The pages one reader shows; pages nobody shows or searches stop waiting. */
  setVisible(viewer: object, pages: ReadonlySet<number>): void;
  /** Stops waiting work for a reader that closed; the last one stops everything. */
  release(viewer: object): void;
  /** The PDF's own text, without recognized text. */
  nativeTextContent(page: PdfOcrPage, params?: object): Promise<PdfTextContentLike>;
  dispose(): void;
}

/**
 * Text recognition for one open PDF. Pages are patched so their text content includes the
 * recognized words of scanned pages: find waits for them, the text layer shows what is ready
 * and is redrawn when a page is read. A page counts as scanned when it has little text of its
 * own and is mostly image; its own text, such as a stamp, stays first.
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
  let disposed = false;
  let sweeping: Promise<void> | null = null;
  let sweepGeneration = 0;
  let searching = false;
  let checked = false;
  let consecutiveFailures = 0;
  let snapshot: PdfOcrCoverage | null = null;
  let layerMarks = 0;

  const entry = (page: number): PageEntry => {
    let found = entries.get(page);
    if (!found) {
      found = {
        scanned: null,
        classifying: null,
        content: null,
        failed: false,
        task: null,
        job: null,
        priority: 0,
        search: false,
        visible: 0,
      };
      entries.set(page, found);
    }
    return found;
  };

  const emit = (page: number | null) => {
    snapshot = null;
    for (const listener of listeners) listener(page);
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

  const classify = (page: PdfOcrPage, content?: PdfTextContentLike): Promise<boolean> => {
    const found = entry(page.pageNumber);
    if (found.scanned !== null) return Promise.resolve(found.scanned);
    found.classifying ??= (async () => {
      const text = content ?? (await native(page).getTextContent({ disableNormalization: true }));
      if (textContentCharacters(text.items) >= PDF_NATIVE_TEXT_LIMIT) return false;
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
        found.scanned = scanned;
        if (scanned) {
          emit(page.pageNumber);
          if (searching) sweep();
        }
        return scanned;
      },
      () => {
        found.classifying = null;
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
      found.content = build(page, text);
      found.failed = false;
    } else {
      found.failed = true;
    }
    return found.content;
  };

  const read = async (page: PdfOcrPage): Promise<PdfOcrPageText> => {
    const rotation = page.rotate;
    const image = await dependencies.render(page, rotation);
    const imageHash = hex(sha256(image.bytes));
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
        const turned = (rotation + turn) % 360;
        const other = await dependencies.render(page, turned);
        const turnedLines = await engine.recognize(other.blob, other);
        const characters = readable(turnedLines).characters;
        if (characters > best.characters)
          best = { rotation: turned, lines: turnedLines, characters };
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

  const priorityOf = (found: PageEntry) =>
    found.visible > 0 ? PDF_OCR_PRIORITY.visible : found.search ? PDF_OCR_PRIORITY.search : 0;

  const recognize = (page: PdfOcrPage): Promise<PdfOcrTextContent | null> => {
    const found = entry(page.pageNumber);
    if (found.content) return Promise.resolve(found.content);
    if (disposed) return Promise.resolve(null);
    if (found.task) {
      found.job?.setPriority(priorityOf(found));
      return found.task;
    }
    // Several pages in a row failing means the engine cannot run here; stop asking it.
    if (consecutiveFailures >= STOP_AFTER_FAILURES) {
      found.failed = true;
      emit(page.pageNumber);
      return Promise.resolve(null);
    }
    emit(page.pageNumber);
    found.task = (async () => {
      const key = pageKey(page);
      const stored = key === null ? null : await dependencies.cache.byPage(key);
      if (stored) return settle(page, stored);
      if (disposed) return null;
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
            resolve(settle(page, null));
          }
        });
        found.job = {
          setPriority: job.setPriority,
          cancel: () => {
            if (ran || !job.cancel()) return false;
            resolve(null);
            return true;
          },
        };
      });
    })().finally(() => {
      found.task = null;
      found.job = null;
      emit(page.pageNumber);
    });
    return found.task;
  };

  const textFor = async (
    page: PdfOcrPage,
    content: PdfTextContentLike,
  ): Promise<PdfOcrTextContent | null> => {
    if (!(await classify(page, content))) return null;
    entry(page.pageNumber).search = true;
    return recognize(page);
  };

  const patch = (page: PdfOcrPage) => {
    if (originals.has(page)) return page;
    const streamTextContent = page.streamTextContent.bind(page);
    const getTextContent = (params?: object) => collect(streamTextContent(params));
    originals.set(page, { getTextContent });
    const patched = page as {
      getTextContent: PdfOcrPage["getTextContent"];
      streamTextContent: PdfOcrPage["streamTextContent"];
    };
    patched.getTextContent = async (params) => {
      const content = await getTextContent(params);
      if (disposed || textContentCharacters(content.items) >= PDF_NATIVE_TEXT_LIMIT) return content;
      const ocr = await textFor(page, content);
      return ocr ? compose(content, ocr) : content;
    };
    patched.streamTextContent = (params) => {
      const source = streamTextContent(params);
      let reader: ReadableStreamDefaultReader<PdfTextContentLike> | null = null;
      let cancelled = false;
      return new ReadableStream<PdfTextContentLike>({
        start: async (controller) => {
          reader = source.getReader();
          let characters = 0;
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              characters += textContentCharacters(value.items);
              controller.enqueue(value);
            }
            const found = entry(page.pageNumber);
            if (!disposed && characters < PDF_NATIVE_TEXT_LIMIT && found.scanned !== false) {
              const key = pageKey(page);
              if (!found.content && key !== null && (await classify(page))) {
                const stored = await dependencies.cache.byPage(key);
                if (stored && !found.content) {
                  settle(page, stored);
                  emit(page.pageNumber);
                }
              }
              if (found.content) {
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
                  if (scanned) void recognize(page);
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

  /**
   * Once a search is open and a scanned page is known, every page is looked at and the
   * scanned ones queued, so several are read at once ahead of the search reaching them. A
   * PDF with no scanned page is never swept: find reads its text as it always has.
   */
  function sweep() {
    if (disposed || sweeping !== null) return;
    const generation = ++sweepGeneration;
    const current = () => !disposed && generation === sweepGeneration;
    sweeping = (async () => {
      for (let number = 1; number <= document.numPages && current(); number += 1) {
        const page = await document.getPage(number);
        if (!current()) return;
        if (await classify(page)) {
          entry(number).search = true;
          void recognize(page);
        } else if (entry(number).visible === 0) {
          page.cleanup();
        }
      }
      if (!current()) return;
      checked = true;
      emit(null);
    })().catch(() => {
      if (generation === sweepGeneration) sweeping = null;
    });
  }

  const setVisible = (viewer: object, pages: ReadonlySet<number>) => {
    const before = viewers.get(viewer) ?? new Set<number>();
    viewers.set(viewer, pages);
    for (const page of before) if (!pages.has(page)) entry(page).visible -= 1;
    for (const page of pages) if (!before.has(page)) entry(page).visible += 1;
    updatePriorities();
  };

  return {
    coverage() {
      if (snapshot) return snapshot;
      let scanned = 0;
      let recognized = 0;
      let failed = 0;
      for (const found of entries.values()) {
        if (found.scanned) scanned += 1;
        if (found.content) recognized += 1;
        else if (found.failed && !found.task) failed += 1;
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
    recognizeAll() {
      if (disposed) return;
      searching = true;
      if ([...entries.values()].some((found) => found.scanned)) sweep();
    },
    setVisible,
    release(viewer) {
      setVisible(viewer, new Set());
      viewers.delete(viewer);
      if (viewers.size > 0) return;
      // Nobody reads this PDF now: waiting pages stop, and a later search starts again.
      sweepGeneration += 1;
      sweeping = null;
      searching = false;
      checked = false;
      for (const found of entries.values()) found.search = false;
      updatePriorities();
      emit(null);
    },
    nativeTextContent: (page, params) => native(page).getTextContent(params),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const found of entries.values()) found.job?.cancel();
      listeners.clear();
    },
  };
}
