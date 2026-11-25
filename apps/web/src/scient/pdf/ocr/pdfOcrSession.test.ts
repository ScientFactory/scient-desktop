import { describe, expect, it, vi } from "vite-plus/test";

import { textContentText } from "../anchors/pdfTextLayer";
import { createMemoryPdfOcrCache, type PdfOcrCache } from "./pdfOcrCache";
import type { PdfOcrEngine } from "./pdfOcrEngine";
import type { PdfImageOps } from "./pdfOcrPageImage";
import { createPdfOcrQueue } from "./pdfOcrQueue";
import {
  createPdfOcrSession,
  PDF_OCR_SEARCH_AHEAD,
  type PdfOcrDependencies,
  type PdfOcrDocument,
  type PdfOcrPage,
  type PdfTextContentLike,
} from "./pdfOcrSession";
import type { PdfOcrLine } from "./pdfOcrText";

const ops: PdfImageOps = {
  save: 10,
  restore: 11,
  transform: 12,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageMaskXObject: 83,
  paintSolidColorImageMask: 90,
  paintImageXObjectRepeat: 88,
};
const NATIVE = "This page has its own text, long enough to be read as a PDF's own text. ".repeat(4);

interface FakePage extends PdfOcrPage {
  operatorLists: number;
  cleanups: number;
}

/**
 * By default page 1 is a scan carrying a small stamp of its own text and page 2 an ordinary
 * page. `fetched` lists the pages asked for, in order.
 */
function fakePdf(
  options: {
    readonly rotation?: number;
    readonly numPages?: number;
    readonly scanned?: (page: number) => boolean;
  } = {},
) {
  const pages = new Map<number, FakePage>();
  const fetched: number[] = [];
  const isScan = options.scanned ?? ((page: number) => page === 1);
  const page = (pageNumber: number): FakePage => {
    const scanned = isScan(pageNumber);
    const content = (): PdfTextContentLike => ({
      items: [{ str: scanned ? "Downloaded 2024" : NATIVE, hasEOL: true }],
      styles: {},
      lang: null,
    });
    const fake: FakePage = {
      pageNumber,
      rotate: options.rotation ?? 0,
      view: [0, 0, 612, 792],
      operatorLists: 0,
      cleanups: 0,
      getTextContent: async () => content(),
      streamTextContent: () =>
        new ReadableStream({
          start: (controller) => {
            controller.enqueue(content());
            controller.close();
          },
        }),
      getOperatorList: async () => {
        fake.operatorLists += 1;
        return scanned
          ? {
              fnArray: [ops.transform, ops.paintImageXObject],
              argsArray: [[612, 0, 0, 792, 0, 0], []],
            }
          : { fnArray: [], argsArray: [] };
      },
      getViewport: ({ rotation = 0 }) => ({
        width: rotation % 180 === 0 ? 612 : 792,
        height: rotation % 180 === 0 ? 792 : 612,
        convertToPdfPoint: (x, y) => (rotation % 180 === 0 ? [x, 792 - y] : [y, x]),
      }),
      cleanup: () => {
        fake.cleanups += 1;
        return true;
      },
    };
    return fake;
  };
  const document: PdfOcrDocument = {
    numPages: options.numPages ?? 2,
    getPage: async (pageNumber) => {
      fetched.push(pageNumber);
      let found = pages.get(pageNumber);
      if (!found) {
        found = page(pageNumber);
        pages.set(pageNumber, found);
      }
      return found;
    },
  };
  return { document, pages, fetched };
}

const readable: PdfOcrLine[] = [
  {
    rtl: false,
    box: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.12 },
    words: [
      { text: "Recognized", confidence: 95, box: { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.12 } },
      { text: "words", confidence: 95, box: { x0: 0.32, y0: 0.1, x1: 0.4, y1: 0.12 } },
    ],
  },
];
const sideways = "Recognized words on a page that was scanned sideways";
const sidewaysLine: PdfOcrLine[] = [
  {
    rtl: false,
    box: { x0: 0.05, y0: 0.1, x1: 0.95, y1: 0.12 },
    words: sideways.split(" ").map((text, index) => ({
      text,
      confidence: 95,
      box: { x0: 0.05 + index * 0.1, y0: 0.1, x1: 0.13 + index * 0.1, y1: 0.12 },
    })),
  },
];
const noise: PdfOcrLine[] = [
  {
    rtl: false,
    box: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.12 },
    words: ["~", "|", ";", ",", "'"].map((text, index) => ({
      text,
      confidence: 20,
      box: { x0: 0.1 + index * 0.05, y0: 0.1, x1: 0.14 + index * 0.05, y1: 0.12 },
    })),
  },
];

function setup(
  options: {
    readonly cache?: PdfOcrCache;
    readonly read?: (rotation: number) => ReadonlyArray<PdfOcrLine>;
    readonly engine?: PdfOcrEngine;
  } = {},
) {
  const calls = { renders: [] as number[], recognitions: 0 };
  const engine: PdfOcrEngine = options.engine ?? {
    recognize: async (image) => {
      calls.recognitions += 1;
      const rotation = Number(await image.text());
      return (options.read ?? (() => readable))(rotation);
    },
  };
  const queue = createPdfOcrQueue(1);
  const dependencies: PdfOcrDependencies = {
    engine: () => engine,
    queue,
    cache: options.cache ?? createMemoryPdfOcrCache(),
    render: async (page, rotation) => {
      calls.renders.push(rotation);
      const blob = new Blob([options.engine ? String(page.pageNumber) : String(rotation)]);
      return {
        blob,
        bytes: new TextEncoder().encode(`page ${page.pageNumber} ${rotation}`),
        width: 1000,
        height: 1000,
      };
    },
    ascent: () => 0.8,
    ops,
    annotationMode: 2,
  };
  return { calls, dependencies, queue };
}

/** An engine whose readings wait until the test releases them, by page. */
function heldEngine() {
  const waiting = new Map<number, () => void>();
  const asked: number[] = [];
  const engine: PdfOcrEngine = {
    recognize: async (image) => {
      const page = Number(await image.text());
      asked.push(page);
      await new Promise<void>((resolve) => waiting.set(page, resolve));
      return readable;
    },
  };
  const release = (page: number) => {
    waiting.get(page)?.();
    waiting.delete(page);
  };
  return { engine, asked, release, waiting };
}

async function streamed(page: PdfOcrPage): Promise<string> {
  const reader = page.streamTextContent().getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += textContentText(value.items);
  }
}

describe("PDF text recognition session", () => {
  it("gives a scanned page its recognized text once, after its own, and leaves other pages alone", async () => {
    const { document, pages } = fakePdf();
    const { calls, dependencies } = setup();
    const session = createPdfOcrSession(document, "doc", dependencies);
    const scan = await document.getPage(1);
    const ordinary = await document.getPage(2);

    // Find waits for the page to be read; the stamp stays first.
    expect(textContentText((await scan.getTextContent()).items)).toBe(
      "Downloaded 2024\nRecognized words\n",
    );
    expect((await ordinary.getTextContent()).items).toHaveLength(1);
    expect(pages.get(2)!.operatorLists).toBe(0);

    // Searching again, redrawing and scrolling back reuse the reading.
    await scan.getTextContent();
    expect(await streamed(scan)).toBe("Downloaded 2024\nRecognized words\n");
    expect(calls.recognitions).toBe(1);
    expect(session.recognized(1)).toBe(true);
    expect(session.coverage()).toMatchObject({ scanned: 1, recognized: 1, failed: 0 });
    // Callers that need the PDF's own text still get it.
    expect(textContentText((await session.nativeTextContent(scan)).items)).toBe(
      "Downloaded 2024\n",
    );
  });

  it("draws a scanned page with what is ready and has it read for the redraw", async () => {
    const { document } = fakePdf();
    const { calls, dependencies } = setup();
    const session = createPdfOcrSession(document, "doc", dependencies);
    const scan = await document.getPage(1);
    const read = new Promise<void>((resolve) =>
      session.subscribe((page) => {
        if (page === 1 && session.recognized(1)) resolve();
      }),
    );
    expect(await streamed(scan)).toBe("Downloaded 2024\n");
    await read;
    expect(await streamed(scan)).toBe("Downloaded 2024\nRecognized words\n");
    expect(calls.recognitions).toBe(1);
  });

  it("reuses a reading for the same PDF without drawing, and for the same image elsewhere", async () => {
    const cache = createMemoryPdfOcrCache();
    const first = setup({ cache });
    const one = fakePdf();
    createPdfOcrSession(one.document, "doc", first.dependencies);
    await (await one.document.getPage(1)).getTextContent();
    expect(first.calls.recognitions).toBe(1);

    // The same PDF opened again: its page is known, nothing is drawn or read.
    const reopened = setup({ cache });
    const two = fakePdf();
    createPdfOcrSession(two.document, "doc", reopened.dependencies);
    expect(
      textContentText((await (await two.document.getPage(1)).getTextContent()).items),
    ).toContain("Recognized words");
    expect(reopened.calls).toEqual({ renders: [], recognitions: 0 });

    // A copy with other bytes draws the page, finds its image, and does not read it again.
    const copy = setup({ cache });
    const three = fakePdf();
    createPdfOcrSession(three.document, "edited copy", copy.dependencies);
    await (await three.document.getPage(1)).getTextContent();
    expect(copy.calls).toEqual({ renders: [0], recognitions: 0 });
  });

  it("keeps word geometry correct when identical pixels have different PDF rotations", async () => {
    const cache = createMemoryPdfOcrCache();
    for (const rotation of [0, 90]) {
      const { document } = fakePdf({ rotation });
      const { dependencies } = setup({ cache });
      createPdfOcrSession(document, null, {
        ...dependencies,
        render: async (page, angle) => ({
          ...(await dependencies.render(page, angle)),
          bytes: new Uint8Array([42]),
        }),
      });
      const items = (await (await document.getPage(1)).getTextContent()).items;
      const word = items[1] as { transform: number[] };
      expect(Math.abs(word.transform[0]!) < 1e-9).toBe(rotation === 90);
    }
  });

  it("reads a page scanned sideways the way it reads best", async () => {
    const { document } = fakePdf();
    const { calls, dependencies } = setup({
      read: (rotation) => (rotation === 90 ? sidewaysLine : noise),
    });
    const session = createPdfOcrSession(document, "doc", dependencies);
    const scan = await document.getPage(1);
    const items = (await scan.getTextContent()).items;
    expect(textContentText(items)).toBe(`Downloaded 2024\n${sideways}\n`);
    expect(calls.renders).toEqual([0, 90, 270, 180]);
    // Its words run along the turned page, as a quarter turn.
    const recognized = items[1] as { transform: number[] };
    expect(Math.abs(recognized.transform[0]!)).toBeLessThan(1e-9);
    expect(session.recognized(1)).toBe(true);
  });

  it("counts a page that could not be read and keeps its own text", async () => {
    const { document } = fakePdf();
    const { dependencies } = setup();
    const session = createPdfOcrSession(document, "doc", {
      ...dependencies,
      engine: () => ({
        recognize: async () => {
          throw new Error("no engine");
        },
      }),
    });
    const scan = await document.getPage(1);
    expect(textContentText((await scan.getTextContent()).items)).toBe("Downloaded 2024\n");
    expect(session.pageState(1)).toBe("failed");
    expect(session.coverage()).toMatchObject({ scanned: 1, recognized: 0, failed: 1 });
  });

  it("looks at the pages for a search only once a scanned page is known", async () => {
    // A PDF with no scanned page in view is never swept: find reads its text as before.
    const native = fakePdf();
    let fetched = 0;
    const nativeDocument: PdfOcrDocument = {
      numPages: 1,
      getPage: async () => {
        fetched += 1;
        return native.document.getPage(2);
      },
    };
    const quiet = createPdfOcrSession(nativeDocument, "native", setup().dependencies);
    quiet.setSearch({}, 1);
    await streamed(await nativeDocument.getPage(1));
    expect(fetched).toBe(1);
    expect(quiet.coverage()).toMatchObject({ checked: false, scanned: 0 });

    const { document } = fakePdf();
    const { dependencies } = setup();
    const session = createPdfOcrSession(document, "doc", dependencies);
    const checked = new Promise<void>((resolve) =>
      session.subscribe(() => {
        const coverage = session.coverage();
        if (coverage.checked && coverage.recognized === 1) resolve();
      }),
    );
    session.setSearch({}, 1);
    // The page in view is found to be a scan, which starts the search's pass.
    await streamed(await document.getPage(1));
    await checked;
    expect(session.coverage()).toMatchObject({ pageCount: 2, scanned: 1, recognized: 1 });
  });

  it("gives find a page's text at once, with its reading only once it is ready", async () => {
    const { document } = fakePdf();
    const held = heldEngine();
    const { dependencies } = setup({ engine: held.engine });
    const session = createPdfOcrSession(document, "doc", dependencies);
    const scan = await document.getPage(1);
    void streamed(scan);
    await vi.waitFor(() => expect(held.asked).toEqual([1]));

    const pending = await session.findTextContent(scan);
    expect(textContentText(pending.native.items)).toBe("Downloaded 2024\n");
    expect(pending.recognized).toBeNull();

    held.release(1);
    await vi.waitFor(() => expect(session.recognized(1)).toBe(true));
    const read = await session.findTextContent(scan);
    expect(textContentText(read.recognized!.items)).toBe("Recognized words\n");
  });

  it("discovers an offscreen scan behind native pages, including after Find prefetched text", async () => {
    const { document, pages } = fakePdf({ numPages: 3, scanned: (page) => page === 3 });
    const { dependencies, calls } = setup();
    const session = createPdfOcrSession(document, "appendix", dependencies);
    session.setVisible({}, new Set([1]));
    for (const number of [1, 2, 3]) {
      await session.findTextContent(await document.getPage(number));
    }
    expect(calls.recognitions).toBe(0);
    expect(pages.get(3)?.operatorLists).toBe(0);
    session.setSearch({}, 1);
    await vi.waitFor(() => expect(session.recognized(3)).toBe(true));
    expect(calls.recognitions).toBe(1);
    expect(pages.get(1)?.operatorLists).toBe(0);
    expect(pages.get(2)?.operatorLists).toBe(0);
  });

  it("reads a search's scanned pages a few at a time from its reader's page", async () => {
    const pageCount = 12;
    const { document, pages, fetched } = fakePdf({ numPages: pageCount, scanned: () => true });
    const held = heldEngine();
    const { dependencies, queue } = setup({ engine: held.engine });
    const session = createPdfOcrSession(document, "doc", dependencies);
    const reader = {};
    // The page in view is known to be a scan.
    session.setVisible(reader, new Set([5]));
    void streamed(await document.getPage(5));
    await vi.waitFor(() => expect(held.asked).toEqual([5]));
    fetched.length = 0;

    session.setSearch(reader, 5);
    // Page 5 is already being read; the next pages wait, a few at a time, and none past them.
    await vi.waitFor(() => expect(queue.size).toBe(1 + PDF_OCR_SEARCH_AHEAD));
    expect(fetched).toEqual([6, 7, 8, 9]);
    expect(session.pageState(10)).toBe("unknown");
    // Each keystroke keeps the same search: nothing is looked at again.
    for (let key = 0; key < 5; key += 1) session.setSearch(reader, 5);
    expect(fetched).toEqual([6, 7, 8, 9]);

    // A page the search read lets it take the next one.
    held.release(5);
    await vi.waitFor(() => expect(held.asked).toEqual([5, 6]));
    expect(fetched).toEqual([6, 7, 8, 9]);
    held.release(6);
    await vi.waitFor(() => expect(held.asked).toEqual([5, 6, 7]));
    await vi.waitFor(() => expect(fetched).toEqual([6, 7, 8, 9, 10]));
    expect(pages.get(6)!.cleanups).toBeGreaterThan(0);
    expect(pages.get(5)!.cleanups).toBe(0);
    expect(queue.size).toBe(PDF_OCR_SEARCH_AHEAD);
  });

  it("stops a search's waiting pages when its query is cleared, and only the last reader's", async () => {
    const { document, fetched } = fakePdf({ numPages: 12, scanned: () => true });
    const held = heldEngine();
    const { dependencies, queue } = setup({ engine: held.engine });
    const session = createPdfOcrSession(document, "doc", dependencies);
    const first = {};
    const second = {};
    session.setVisible(first, new Set([1]));
    void streamed(await document.getPage(1));
    await vi.waitFor(() => expect(held.asked).toEqual([1]));
    session.setSearch(first, 1);
    session.setSearch(second, 1);
    await vi.waitFor(() => expect(queue.size).toBe(1 + PDF_OCR_SEARCH_AHEAD));

    // One reader's search ends; the other still searches.
    session.setSearch(first, null);
    expect(queue.size).toBe(1 + PDF_OCR_SEARCH_AHEAD);

    // The other reader closes: queued pages stop at once, the page being read finishes.
    session.release(second);
    expect(queue.size).toBe(1);
    expect(session.pageState(2)).toBe("unknown");
    fetched.length = 0;
    held.release(1);
    await vi.waitFor(() => expect(session.recognized(1) && queue.size === 0).toBe(true));
    expect(held.asked).toEqual([1]);
    expect(fetched).toEqual([]);

    // A new search queues the stopped pages again.
    session.setSearch(first, 1);
    await vi.waitFor(() => expect(held.asked).toEqual([1, 2]));
  });
});
