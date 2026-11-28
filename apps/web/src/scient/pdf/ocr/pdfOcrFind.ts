import { PDFFindController } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";

import {
  composePdfTextContent,
  type PdfOcrDocument,
  type PdfOcrSession,
  type PdfTextContentLike,
} from "./pdfOcrSession";

/** The `find` event state PDF.js keeps; only the fields that change a page's matches. */
interface FindQueryState {
  readonly query: string | ReadonlyArray<string> | null;
  readonly caseSensitive?: boolean;
  readonly entireWord?: boolean;
  readonly matchDiacritics?: boolean;
  readonly highlightAll?: boolean;
}

/**
 * The fields of PDF.js 6.2's `PDFFindController` a page's late text is merged into. They are
 * public by convention only; `pdfOcrFind.browser.test.ts` runs the real controller.
 */
interface FindControllerFields {
  readonly state: FindQueryState | null;
  readonly highlightMatches: boolean;
  setDocument(document: unknown): void;
  _firstPageCapability: { readonly promise: Promise<void> };
  _extractTextPromises: Array<Promise<void> | undefined>;
  _pageContents: string[];
  _pageDiffs: unknown[];
  _hasDiacritics: boolean[];
  _pageMatches: Array<number[] | undefined>;
  _pageMatchesLength: Array<number[] | undefined>;
  _matchesCountTotal: number;
  _selected: { pageIdx: number; matchIdx: number };
  _offset: { pageIdx: number | null; matchIdx: number | null; wrapped: boolean };
  _pagesToSearch: number | null;
  _resumePageIdx: number | null;
  _findTimeout: unknown;
}

interface FindEventBus {
  on(name: string, listener: (event: never) => void): void;
  off(name: string, listener: (event: never) => void): void;
  dispatch(name: string, event: object): void;
}

interface PageFindText {
  readonly content: string;
  readonly diffs: unknown;
  readonly hasDiacritics: boolean;
  readonly matches: number[];
  readonly lengths: number[];
}

const hasQuery = (state: FindQueryState | null): state is FindQueryState =>
  state !== null &&
  (typeof state.query === "string" ? state.query.length > 0 : (state.query?.length ?? 0) > 0);

const sameMatches = (a: FindQueryState | null, b: FindQueryState | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    JSON.stringify(a.query) === JSON.stringify(b.query) &&
    a.caseSensitive === b.caseSensitive &&
    a.entireWord === b.entireWord &&
    a.matchDiacritics === b.matchDiacritics);

/**
 * PDF.js's own normalization and matching of one page's text, from a one-page controller of
 * its own, so offsets agree with the text layer's; PDF.js exports neither step.
 */
async function findPageText(
  content: PdfTextContentLike,
  state: FindQueryState | null,
): Promise<PageFindText> {
  const listeners = new Map<string, (event: object) => void>();
  const eventBus = {
    on: (name: string, listener: (event: object) => void) => listeners.set(name, listener),
    off: () => undefined,
    dispatch: () => undefined,
  };
  const scratch = new PDFFindController({
    linkService: { pagesCount: 1, page: 1 } as never,
    eventBus: eventBus as never,
    delay: 0,
    updateMatchesCountOnProgress: true,
  }) as unknown as FindControllerFields;
  scratch.setDocument({ getPage: async () => ({ getTextContent: async () => content }) });
  // "again" on a fresh controller matches at once instead of after its typing delay.
  listeners.get("find")?.({
    caseSensitive: false,
    entireWord: false,
    matchDiacritics: true,
    ...state,
    query: state?.query ?? "",
    highlightAll: false,
    type: "again",
    findPrevious: false,
  });
  // Each settles after the controller's own reaction to it: extraction, then matching.
  await scratch._firstPageCapability.promise;
  await scratch._extractTextPromises[0];
  return {
    content: scratch._pageContents[0] ?? "",
    diffs: scratch._pageDiffs[0] ?? null,
    hasDiacritics: scratch._hasDiacritics[0] ?? false,
    matches: scratch._pageMatches[0] ?? [],
    lengths: scratch._pageMatchesLength[0] ?? [],
  };
}

function matchesCount(controller: FindControllerFields) {
  const { pageIdx, matchIdx } = controller._selected;
  let total = controller._matchesCountTotal;
  let current = 0;
  if (matchIdx !== -1) {
    for (let index = 0; index < pageIdx; index += 1)
      current += controller._pageMatches[index]?.length ?? 0;
    current += matchIdx + 1;
  }
  if (current < 1 || current > total) current = total = 0;
  return { current, total };
}

export interface PdfOcrFind {
  /** A page's recognized text arrived: find adds it once its text layer can show it. */
  recognized(page: number): void;
  /** A page's recognized layer was evicted: drop its OCR offsets so highlighting never mismatches. */
  evicted(page: number): void;
  /** Text layers changed: pages held back for their layer are tried again. */
  layersChanged(): void;
  detach(): void;
}

/**
 * Feeds a reader's find controller its pages' text without waiting for recognition, and adds
 * a page's recognized text when it arrives. PDF.js extracts pages one after another and selects
 * the next match only once the page it is on has been extracted, so a find that waited for a
 * scan would hold every later page, and every hit on them, until that scan was read.
 */
export function attachPdfOcrFind(input: {
  readonly controller: PDFFindController;
  readonly eventBus: FindEventBus;
  readonly document: PdfOcrDocument;
  readonly session: PdfOcrSession;
  readonly owner: object;
  /** The page's drawn text layer lacks the recognized text the page now has. */
  readonly staleLayer: (page: number) => boolean;
}): PdfOcrFind {
  const controller = input.controller as unknown as FindControllerFields;
  const { document, owner, session } = input;
  /** Pages whose extracted text includes their recognized text. */
  const complete = new Set<number>();
  /** Recognized pages waiting for their text layer to be drawn again. */
  const held = new Set<number>();
  const merging = new Set<number>();
  /**
   * Composed text handed to PDF.js `#extractText()` whose `.items` have not been read yet;
   * stripping it on eviction prevents `#extractText()` from ever indexing or jumping to evicted OCR.
   */
  const inflightComposed = new Map<number, { strip: () => boolean }>();
  let generation = 0;
  let extracting = false;
  let detached = false;
  let attachedDocument: unknown = null;

  const setExtracting = (next: boolean) => {
    if (extracting === next) return;
    extracting = next;
    session.setFindExtracting(owner, next);
  };

  // Hold off background scan sweeps while PDF.js extracts native text sequentially.
  const onFind = () => {
    if (detached || extracting || document.numPages <= 0) return;
    if (controller._extractTextPromises.length > 0) return;
    const current = generation;
    setExtracting(true);
    void controller._firstPageCapability.promise.then(() => {
      if (detached || current !== generation) return;
      const last = controller._extractTextPromises[document.numPages - 1];
      if (!last) {
        setExtracting(false);
        return;
      }
      void last.finally(() => {
        if (detached || current !== generation) return;
        setExtracting(false);
      });
    });
  };
  input.eventBus.on("find", onFind);

  // Fresh wrapper per attachment so PDF.js's `pdfDoc !== this._pdfDocument` rejects stale loops.
  const createPagesProxy = (current: number) => ({
    getPage: async (number: number) => ({
      getTextContent: async (params?: object) => {
        const page = await document.getPage(number);
        const { native, recognized } = await session.findTextContent(page, params);
        if (!recognized || !session.recognized(number)) return native;
        // Offsets past the page's own text would land on a layer drawn without them.
        if (input.staleLayer(number)) {
          held.add(number);
          return native;
        }
        const composed = composePdfTextContent(native, recognized);
        if (current !== generation) return composed;
        const items = [...composed.items];
        const nativeLength = native.items.length;
        let consumed = false;
        const inflight = {
          strip: () => {
            if (consumed) return false;
            items.length = nativeLength;
            return true;
          },
        };
        complete.add(number);
        inflightComposed.set(number, inflight);
        return {
          ...composed,
          get items() {
            consumed = true;
            if (inflightComposed.get(number) === inflight) inflightComposed.delete(number);
            return items;
          },
        };
      },
    }),
  });
  const setDocument = controller.setDocument.bind(controller);
  const ownSetDocument = (value: unknown) => {
    // PDFViewer sets the same document again after first paint; keep any active Find state.
    if (value === document && attachedDocument === document) return;
    attachedDocument = value;
    generation += 1;
    setExtracting(false);
    complete.clear();
    held.clear();
    merging.clear();
    inflightComposed.clear();
    setDocument(value === document ? createPagesProxy(generation) : value);
  };
  // The viewer sets the document again once a page has drawn (PDFViewer#setDocument).
  controller.setDocument = ownSetDocument;
  ownSetDocument(document);

  const findSurvivingMatch = (fromIndex: number): number => {
    const count = document.numPages;
    for (let step = 1; step < count; step += 1) {
      const candidate = (fromIndex + step) % count;
      if ((controller._pageMatches[candidate]?.length ?? 0) > 0) return candidate;
    }
    return -1;
  };

  const findUnmatchedPage = (fromIndex: number): number => {
    const count = document.numPages;
    for (let step = 1; step < count; step += 1) {
      const candidate = (fromIndex + step) % count;
      if (controller._pageMatches[candidate] === undefined) return candidate;
    }
    return -1;
  };

  /**
   * Moves selection off `index` when its selected hit vanished so PDF.js's match count does not
   * collapse to 0/0 while matches remain on other pages. Returns the newly selected page, or -1.
   */
  const reselectOffPage = (index: number): number => {
    const surviving = findSurvivingMatch(index);
    if (surviving !== -1) {
      controller._selected.pageIdx = surviving;
      controller._selected.matchIdx = 0;
      controller._offset.pageIdx = surviving;
      controller._offset.matchIdx = 0;
      controller._offset.wrapped = false;
      return surviving;
    }
    controller._selected.pageIdx = -1;
    controller._selected.matchIdx = -1;
    if (controller._offset.pageIdx === index) controller._offset.matchIdx = null;
    if (controller._resumePageIdx === null && hasQuery(controller.state)) {
      const pending = findUnmatchedPage(index);
      if (pending !== -1) {
        controller._offset.pageIdx = pending;
        controller._offset.matchIdx = null;
        controller._offset.wrapped = false;
        controller._pagesToSearch = document.numPages;
        controller._resumePageIdx = pending;
      }
    }
    return -1;
  };

  const merge = (index: number, text: PageFindText, state: FindQueryState | null) => {
    controller._pageContents[index] = text.content;
    controller._pageDiffs[index] = text.diffs;
    controller._hasDiacritics[index] = text.hasDiacritics;
    const previous = controller._pageMatches[index];
    // Not matched yet for this query: the controller matches the new text itself.
    if (previous === undefined || !hasQuery(state)) return;
    controller._pageMatches[index] = text.matches;
    controller._pageMatchesLength[index] = text.lengths;
    controller._matchesCountTotal = Math.max(
      0,
      controller._matchesCountTotal + text.matches.length - previous.length,
    );
    // Recognized text follows the page's own, so earlier matches keep their place.
    const last = text.matches.length - 1;
    let reselectedPage = -1;
    if (controller._selected.pageIdx === index && controller._selected.matchIdx > last) {
      if (last >= 0) controller._selected.matchIdx = last;
      else reselectedPage = reselectOffPage(index);
    }
    if (
      reselectedPage === -1 &&
      controller._offset.pageIdx === index &&
      controller._offset.matchIdx !== null &&
      controller._offset.matchIdx > last
    )
      controller._offset.matchIdx = last >= 0 ? last : null;
    if (!controller.highlightMatches) return;
    input.eventBus.dispatch("updatetextlayermatches", { source: controller, pageIndex: index });
    if (reselectedPage !== -1) {
      input.eventBus.dispatch("updatetextlayermatches", {
        source: controller,
        pageIndex: reselectedPage,
      });
    }
    input.eventBus.dispatch("updatefindmatchescount", {
      source: controller,
      matchesCount: matchesCount(controller),
    });
    // Nothing was found before: the first late match is selected, as a typed query would be.
    if (
      text.matches.length > 0 &&
      controller._selected.pageIdx === -1 &&
      controller._resumePageIdx === null &&
      !controller._findTimeout
    ) {
      input.eventBus.dispatch("find", {
        ...state,
        source: controller,
        type: "again",
        findPrevious: false,
      });
    }
  };

  const add = async (number: number) => {
    const current = generation;
    const extraction = controller._extractTextPromises[number - 1];
    // Not extracted yet: the extraction reads the recognized text with the rest.
    if (!extraction || complete.has(number) || merging.has(number)) return;
    if (input.staleLayer(number)) {
      held.add(number);
      return;
    }
    held.delete(number);
    merging.add(number);
    try {
      await extraction;
      if (detached || current !== generation || complete.has(number)) return;
      const page = await document.getPage(number);
      const { native, recognized } = await session.findTextContent(page, {
        disableNormalization: true,
      });
      if (!recognized || !session.recognized(number)) return;
      const content = composePdfTextContent(native, recognized);
      // Matched for the query current when merged: one typed meanwhile is matched again.
      for (;;) {
        const state = controller.state;
        const text = await findPageText(content, state);
        if (
          detached ||
          current !== generation ||
          complete.has(number) ||
          !session.recognized(number)
        )
          return;
        if (sameMatches(state, controller.state)) {
          complete.add(number);
          merge(number - 1, text, controller.state);
          return;
        }
      }
    } finally {
      if (current === generation) merging.delete(number);
    }
  };

  const recognized = (page: number) => {
    if (!detached) void add(page).catch(() => undefined);
  };

  const clearEvictedPage = (index: number) => {
    const previous = controller._pageMatches[index];
    const hadContent = (controller._pageContents[index]?.length ?? 0) > 0;
    const hadMatches = (previous?.length ?? 0) > 0;
    const selectedEvicted = controller._selected.pageIdx === index;
    if (!hadContent && !hadMatches && !selectedEvicted) return;

    controller._pageContents[index] = "";
    controller._pageDiffs[index] = null;
    controller._hasDiacritics[index] = false;
    if (previous === undefined) return;

    controller._pageMatches[index] = [];
    controller._pageMatchesLength[index] = [];
    controller._matchesCountTotal = Math.max(0, controller._matchesCountTotal - previous.length);

    let reselectedPage = -1;
    if (selectedEvicted) reselectedPage = reselectOffPage(index);
    else if (controller._offset.pageIdx === index) controller._offset.matchIdx = null;

    if (controller.highlightMatches) {
      input.eventBus.dispatch("updatetextlayermatches", { source: controller, pageIndex: index });
      if (reselectedPage !== -1) {
        input.eventBus.dispatch("updatetextlayermatches", {
          source: controller,
          pageIndex: reselectedPage,
        });
      }
      input.eventBus.dispatch("updatefindmatchescount", {
        source: controller,
        matchesCount: matchesCount(controller),
      });
    }
  };

  const restoreNative = async (page: number, current: number) => {
    const pdfPage = await document.getPage(page);
    if (detached || current !== generation || complete.has(page) || session.recognized(page))
      return;
    const native = await session.nativeTextContent(pdfPage, { disableNormalization: true });
    if (
      native.items.length === 0 ||
      detached ||
      current !== generation ||
      complete.has(page) ||
      session.recognized(page)
    )
      return;
    for (;;) {
      const state = controller.state;
      const text = await findPageText(native, state);
      if (detached || current !== generation || complete.has(page) || session.recognized(page))
        return;
      if (sameMatches(state, controller.state)) {
        merge(page - 1, text, controller.state);
        return;
      }
    }
  };

  const evicted = (page: number) => {
    if (detached) return;
    held.delete(page);
    const inflight = inflightComposed.get(page);
    if (inflight) inflightComposed.delete(page);
    if (!complete.delete(page)) return;
    // If PDF.js has not read the composed items yet, strip OCR in place so #extractText()
    // indexes only the page's native text and never flashes a match or page jump.
    if (inflight?.strip()) return;
    const current = generation;
    clearEvictedPage(page - 1);
    void restoreNative(page, current).catch(() => undefined);
  };

  return {
    recognized,
    evicted,
    layersChanged() {
      for (const page of held) if (!input.staleLayer(page)) recognized(page);
    },
    detach() {
      detached = true;
      setExtracting(false);
      input.eventBus.off("find", onFind);
      held.clear();
      inflightComposed.clear();
      if (controller.setDocument === ownSetDocument)
        delete (controller as { setDocument?: unknown }).setDocument;
    },
  };
}
