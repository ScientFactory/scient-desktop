import { describe, expect, it } from "vite-plus/test";

import { textContentText } from "../anchors/pdfTextLayer";
import { createMemoryPdfOcrCache, type PdfOcrCache } from "./pdfOcrCache";
import type { PdfOcrEngine } from "./pdfOcrEngine";
import type { PdfImageOps } from "./pdfOcrPageImage";
import { createPdfOcrQueue } from "./pdfOcrQueue";
import {
  createPdfOcrSession,
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
}

/** Page 1 is a scan carrying a small stamp of its own text; page 2 is an ordinary page. */
function fakePdf() {
  const pages = new Map<number, FakePage>();
  const page = (pageNumber: number): FakePage => {
    const scanned = pageNumber === 1;
    const content = (): PdfTextContentLike => ({
      items: [{ str: scanned ? "Downloaded 2024" : NATIVE, hasEOL: true }],
      styles: {},
      lang: null,
    });
    const fake: FakePage = {
      pageNumber,
      rotate: 0,
      view: [0, 0, 612, 792],
      operatorLists: 0,
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
      cleanup: () => true,
    };
    return fake;
  };
  const document: PdfOcrDocument = {
    numPages: 2,
    getPage: async (pageNumber) => {
      let found = pages.get(pageNumber);
      if (!found) {
        found = page(pageNumber);
        pages.set(pageNumber, found);
      }
      return found;
    },
  };
  return { document, pages };
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
  } = {},
) {
  const calls = { renders: [] as number[], recognitions: 0 };
  const engine: PdfOcrEngine = {
    recognize: async (image) => {
      calls.recognitions += 1;
      const rotation = Number(await image.text());
      return (options.read ?? (() => readable))(rotation);
    },
  };
  const dependencies: PdfOcrDependencies = {
    engine: () => engine,
    queue: createPdfOcrQueue(1),
    cache: options.cache ?? createMemoryPdfOcrCache(),
    render: async (page, rotation) => {
      calls.renders.push(rotation);
      const blob = new Blob([String(rotation)]);
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
  return { calls, dependencies };
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

  it("looks at every page for a search only once a scanned page is known", async () => {
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
    quiet.recognizeAll();
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
    session.recognizeAll();
    // The page in view is found to be a scan, which starts the sweep.
    await streamed(await document.getPage(1));
    await checked;
    expect(session.coverage()).toMatchObject({ pageCount: 2, scanned: 1, recognized: 1 });
  });
});
