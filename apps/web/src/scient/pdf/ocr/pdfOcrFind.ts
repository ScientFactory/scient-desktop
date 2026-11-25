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
  _offset: { pageIdx: number | null; matchIdx: number | null };
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
  /** The page's drawn text layer lacks the recognized text the page now has. */
  readonly staleLayer: (page: number) => boolean;
}): PdfOcrFind {
  const controller = input.controller as unknown as FindControllerFields;
  const { document, session } = input;
  /** Pages whose extracted text includes their recognized text. */
  const complete = new Set<number>();
  /** Recognized pages waiting for their text layer to be drawn again. */
  const held = new Set<number>();
  const merging = new Set<number>();
  let generation = 0;
  let detached = false;

  const pages = {
    getPage: async (number: number) => ({
      getTextContent: async (params?: object) => {
        const current = generation;
        const page = await document.getPage(number);
        const { native, recognized } = await session.findTextContent(page, params);
        if (!recognized) return native;
        // Offsets past the page's own text would land on a layer drawn without them.
        if (input.staleLayer(number)) {
          held.add(number);
          return native;
        }
        if (current === generation) complete.add(number);
        return composePdfTextContent(native, recognized);
      },
    }),
  };
  const setDocument = controller.setDocument.bind(controller);
  const ownSetDocument = (value: unknown) => {
    generation += 1;
    complete.clear();
    held.clear();
    merging.clear();
    setDocument(value === document ? pages : value);
  };
  // The viewer sets the document again once a page has drawn (PDFViewer#setDocument).
  controller.setDocument = ownSetDocument;
  ownSetDocument(document);

  const merge = (index: number, text: PageFindText, state: FindQueryState | null) => {
    controller._pageContents[index] = text.content;
    controller._pageDiffs[index] = text.diffs;
    controller._hasDiacritics[index] = text.hasDiacritics;
    const previous = controller._pageMatches[index];
    // Not matched yet for this query: the controller matches the new text itself.
    if (previous === undefined || !hasQuery(state)) return;
    controller._pageMatches[index] = text.matches;
    controller._pageMatchesLength[index] = text.lengths;
    controller._matchesCountTotal += text.matches.length - previous.length;
    // Recognized text follows the page's own, so earlier matches keep their place.
    const last = text.matches.length - 1;
    if (controller._selected.pageIdx === index && controller._selected.matchIdx > last)
      controller._selected.matchIdx = last;
    if (
      controller._offset.pageIdx === index &&
      controller._offset.matchIdx !== null &&
      controller._offset.matchIdx > last
    )
      controller._offset.matchIdx = Math.max(last, 0);
    if (!controller.highlightMatches) return;
    input.eventBus.dispatch("updatetextlayermatches", { source: controller, pageIndex: index });
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
      if (!recognized) return;
      const content = composePdfTextContent(native, recognized);
      // Matched for the query current when merged: one typed meanwhile is matched again.
      for (;;) {
        const state = controller.state;
        const text = await findPageText(content, state);
        if (detached || current !== generation || complete.has(number)) return;
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

  return {
    recognized,
    layersChanged() {
      for (const page of held) if (!input.staleLayer(page)) recognized(page);
    },
    detach() {
      detached = true;
      held.clear();
      if (controller.setDocument === ownSetDocument)
        delete (controller as { setDocument?: unknown }).setDocument;
    },
  };
}
