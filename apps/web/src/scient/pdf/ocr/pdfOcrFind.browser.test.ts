import { AnnotationMode, OPS, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { EventBus, FindState, PDFFindController } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import { describe, expect, it, vi } from "vite-plus/test";

import { createPdfRuntime } from "../pdfRuntime";
import { attachPdfOcr } from "./pdfOcr";
import { createMemoryPdfOcrCache } from "./pdfOcrCache";
import { attachPdfOcrFind } from "./pdfOcrFind";
import { createPdfOcrQueue } from "./pdfOcrQueue";
import { createPdfOcrSession, type PdfOcrDocument, type PdfOcrSession } from "./pdfOcrSession";
import { pdfTextLayerHasOcr, type PdfOcrLine } from "./pdfOcrText";

import "pdfjs-dist/legacy/web/pdf_viewer.css";

/** A PDF whose pages are scans, scans with a short native stamp, or native text. */
function pdfOf(
  pages: ReadonlyArray<"scan" | string | { readonly scan: true; readonly stamp: string }>,
): Uint8Array {
  const objects = [
    "", // Pages, written once the page objects are numbered.
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nw\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  const kids: string[] = [];
  for (const page of pages) {
    const content =
      page === "scan"
        ? "q 612 0 0 792 0 0 cm /Im1 Do Q"
        : typeof page === "string"
          ? `BT /F1 14 Tf 72 700 Td (${page}) Tj ET`
          : `q 612 0 0 792 0 0 cm /Im1 Do Q BT /F1 14 Tf 72 700 Td (${page.stamp}) Tj ET`;
    const pageObject = objects.length + 1;
    kids.push(`${pageObject} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 1 0 R /MediaBox [0 0 612 792] /Contents ${pageObject + 1} 0 R /Resources << /XObject << /Im1 2 0 R >> /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  objects[0] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  objects.push("<< /Type /Catalog /Pages 1 0 R >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const line = (text: string): PdfOcrLine[] => [
  {
    rtl: false,
    box: { x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.23 },
    words: text.split(" ").map((word, index) => ({
      text: word,
      confidence: 95,
      box: { x0: 0.1 + index * 0.17, y0: 0.2, x1: 0.25 + index * 0.17, y1: 0.23 },
    })),
  },
];

/** Opens `pages` in a reader whose recognition of each page waits until the test releases it. */
async function openReader(
  pages: ReadonlyArray<"scan" | string | { readonly scan: true; readonly stamp: string }>,
  options: {
    readonly height: number;
    readonly slots: number;
    readonly read: Record<number, string>;
    readonly maxPages?: number;
  },
) {
  const task = getDocument({ data: pdfOf(pages) });
  const document = await task.promise;
  const waiting = new Map<number, () => void>();
  const asked: number[] = [];
  const queue = createPdfOcrQueue(options.slots);
  const session = createPdfOcrSession(document as unknown as PdfOcrDocument, "find", {
    engine: () => ({
      recognize: async (image) => {
        const page = Number(await image.text());
        asked.push(page);
        await new Promise<void>((resolve) => waiting.set(page, resolve));
        return line(options.read[page] ?? "");
      },
    }),
    queue,
    cache: createMemoryPdfOcrCache(options.maxPages),
    render: async (page) => ({
      blob: new Blob([String(page.pageNumber)]),
      bytes: new TextEncoder().encode(String(page.pageNumber)),
      width: 1,
      height: 1,
    }),
    ascent: () => 0.8,
    ops: OPS,
    annotationMode: AnnotationMode.ENABLE_FORMS,
  });
  const container = window.document.createElement("div");
  container.style.cssText = `position:absolute;top:0;left:0;width:320px;height:${options.height}px;overflow:auto`;
  const viewerElement = window.document.createElement("div");
  viewerElement.className = "pdfViewer";
  container.append(viewerElement);
  window.document.body.append(container);
  const runtime = createPdfRuntime({ container, viewerElement, document, sourceUrl: "test:find" });
  runtime.eventBus.on("pagesinit", () => {
    runtime.viewer.currentScaleValue = "page-width";
    runtime.viewer.update();
  });
  const ocrBinding = attachPdfOcr(runtime, session);
  const found = { current: 0, total: 0, state: -1 };
  runtime.eventBus.on(
    "updatefindmatchescount",
    ({ matchesCount }: { matchesCount: { current: number; total: number } }) =>
      Object.assign(found, matchesCount),
  );
  runtime.eventBus.on(
    "updatefindcontrolstate",
    ({
      state,
      matchesCount,
    }: {
      state: number;
      matchesCount: { current: number; total: number };
    }) => Object.assign(found, matchesCount, { state }),
  );
  const find = (query: string, type: "" | "again" = "") =>
    runtime.eventBus.dispatch("find", {
      source: runtime,
      type,
      query,
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false,
      highlightAll: query.length > 0,
      findPrevious: false,
      matchDiacritics: true,
    });
  const release = (page: number) => {
    waiting.get(page)?.();
    waiting.delete(page);
  };
  const layer = (page: number) =>
    container.querySelector<HTMLElement>(`.page[data-page-number="${page}"] .textLayer`);
  const selected = () => runtime.findController.selected ?? { pageIdx: -1, matchIdx: -1 };
  return {
    runtime,
    session,
    ocrBinding,
    queue,
    selected,
    asked,
    found,
    find,
    release,
    layer,
    [Symbol.asyncDispose]: async () => {
      for (const resolve of waiting.values()) resolve();
      ocrBinding.detach();
      session.dispose();
      await runtime.destroy();
      container.remove();
      await task.destroy();
    },
  };
}

describe("finding text in a PDF with scanned pages", () => {
  it("finds the PDF's own and already read text while an earlier scan is still being read", async () => {
    // Page 1 is held; page 2 is read while in view; page 3 is the PDF's own text.
    await using reader = await openReader(["scan", "scan", "a needle in text"], {
      height: 1_400,
      slots: 2,
      read: { 1: "first needle", 2: "second needle" },
    });
    await vi.waitFor(() => expect(reader.asked).toEqual(expect.arrayContaining([1, 2])));
    reader.release(2);
    await vi.waitFor(() => expect(pdfTextLayerHasOcr(reader.layer(2)!)).toBe(true));
    expect(reader.session.pageState(1)).toBe("pending");

    reader.find("needle");
    await vi.waitFor(() => {
      expect(reader.found).toMatchObject({ state: FindState.FOUND, current: 1, total: 2 });
    });
    expect(reader.selected().pageIdx).toBe(1);
    expect(reader.layer(2)!.querySelector(".highlight.selected")?.textContent).toBe("needle");

    // Page 1's reading arrives: its match counts and is drawn on its recognized words.
    reader.release(1);
    await vi.waitFor(() => expect(reader.found).toMatchObject({ current: 2, total: 3 }));
    await vi.waitFor(() =>
      expect(reader.layer(1)!.querySelector(".highlight")?.textContent).toBe("needle"),
    );

    // Navigating visits every match in page order, the late one included.
    const visits: string[] = [];
    for (let step = 0; step < 3; step += 1) {
      reader.find("needle", "again");
      await vi.waitFor(() => expect(reader.found.state).not.toBe(FindState.PENDING));
      const { pageIdx, matchIdx } = reader.selected();
      visits.push(`${pageIdx + 1}:${matchIdx}:${reader.found.current}`);
    }
    expect(visits).toEqual(["3:0:3", "1:0:1", "2:0:2"]);
  });

  it("selects the first match a late reading brings when nothing was found before", async () => {
    await using reader = await openReader(["scan", "no match here"], {
      height: 1_000,
      slots: 1,
      read: { 1: "late needle" },
    });
    await vi.waitFor(() => expect(reader.asked).toEqual([1]));
    reader.find("needle");
    await vi.waitFor(() => expect(reader.found).toMatchObject({ state: FindState.NOT_FOUND }));

    reader.release(1);
    await vi.waitFor(() => {
      expect(reader.selected()).toEqual({ pageIdx: 0, matchIdx: 0 });
      // Found after wrapping round from where the search stopped; the reader shows it as found.
      expect(reader.found).toMatchObject({ state: FindState.WRAPPED, current: 1, total: 1 });
    });
  });

  it("reads no scan out of view until a query is typed, and stops when it is cleared", async () => {
    // Only page 1 is in view; page 4 is a scan further on.
    await using reader = await openReader(["scan", "two", "three", "scan"], {
      height: 300,
      slots: 1,
      read: { 1: "needle", 4: "needle" },
    });
    await vi.waitFor(() => expect(reader.asked).toEqual([1]));

    // Opening find extracts the PDF's own text; no scan is looked at for it.
    reader.find("");
    await vi.waitFor(() =>
      expect(
        (reader.runtime.findController as unknown as { _pageContents: string[] })._pageContents,
      ).toHaveLength(4),
    );
    expect(reader.session.pageState(4)).toBe("unknown");

    // A query queues page 4 behind the page in view; clearing it lets page 4 go.
    reader.find("needle");
    await vi.waitFor(() => expect(reader.session.pageState(4)).toBe("pending"));
    reader.find("");
    await vi.waitFor(() => expect(reader.session.pageState(4)).toBe("unknown"));
    reader.release(1);
    await vi.waitFor(() =>
      expect(reader.session.recognized(1) && reader.queue.size === 0).toBe(true),
    );
    expect(reader.asked).toEqual([1]);

    // Typing again asks for it anew.
    reader.find("needle");
    await vi.waitFor(() => expect(reader.asked).toEqual([1, 4]));
  });

  it("keeps an active query and avoids double-counting when the viewer re-applies the same document", async () => {
    await using reader = await openReader(["alpha needle", "beta needle"], {
      height: 1_000,
      slots: 1,
      read: {},
    });
    reader.find("needle");
    // Simulate PDFViewer calling findController.setDocument(document) again after first paint.
    reader.runtime.findController.setDocument(reader.runtime.document);
    await vi.waitFor(() => {
      expect(reader.found).toMatchObject({ state: FindState.FOUND, current: 1, total: 2 });
    });
    expect((reader.runtime.findController.state as { query?: string } | null)?.query).toBe(
      "needle",
    );
  });

  it("suspends queued search OCR while parked and resumes when shown again", async () => {
    await using reader = await openReader(["scan", "two", "three", "scan"], {
      height: 300,
      slots: 1,
      read: { 1: "needle", 4: "needle" },
    });
    await vi.waitFor(() => expect(reader.asked).toEqual([1]));
    reader.find("needle");
    await vi.waitFor(() => expect(reader.session.pageState(4)).toBe("pending"));

    // Parking drops queued offscreen work; unparking resumes the active query.
    reader.ocrBinding.setParked(true);
    await vi.waitFor(() => expect(reader.session.pageState(4)).toBe("unknown"));
    reader.release(1);
    await vi.waitFor(() => expect(reader.queue.size).toBe(0));
    expect(reader.asked).toEqual([1]);

    reader.ocrBinding.setParked(false);
    await vi.waitFor(() => expect(reader.asked).toEqual([1, 4]));
  });

  it("preserves native Find matches on a mixed page when its OCR layer is evicted", async () => {
    await using reader = await openReader([{ scan: true, stamp: "NativeStamp" }, "scan"], {
      height: 300,
      slots: 1,
      maxPages: 1,
      read: { 1: "OcrNeedle", 2: "SecondNeedle" },
    });
    await vi.waitFor(() => expect(reader.asked).toEqual([1]));
    reader.release(1);
    await vi.waitFor(() => expect(reader.session.recognized(1)).toBe(true));

    // Find finds the OCR word on page 1, then triggers page 2 which evicts page 1 (maxPages=1).
    reader.find("OcrNeedle");
    await vi.waitFor(() => expect(reader.found.total).toBe(1));
    await vi.waitFor(() => expect(reader.asked).toEqual([1, 2]));
    // Scroll page 1 out of view so page 2 can evict it cleanly.
    reader.session.setVisible({}, new Set());
    reader.runtime.viewer.currentPageNumber = 2;
    reader.release(2);
    await vi.waitFor(() => expect(reader.session.recognized(2)).toBe(true));
    await vi.waitFor(() => expect(reader.session.recognized(1)).toBe(false));

    // Eviction cleared the OCR match on page 1, while native text on page 1 stays searchable.
    await vi.waitFor(() => expect(reader.found.total).toBe(0));
    reader.find("NativeStamp");
    await vi.waitFor(() => expect(reader.found.total).toBe(1));
  });

  it("keeps surviving native matches counted and selected when the selected OCR hit is evicted", async () => {
    await using reader = await openReader(["scan", "SharedNeedle in native text", "scan"], {
      height: 300,
      slots: 1,
      maxPages: 1,
      read: { 1: "SharedNeedle", 3: "OtherWord" },
    });
    await vi.waitFor(() => expect(reader.asked).toEqual([1]));
    reader.release(1);
    await vi.waitFor(() => expect(reader.session.recognized(1)).toBe(true));

    // Page 1's OCR hit is selected first, with page 2's native hit as match 2 of 2.
    reader.find("SharedNeedle");
    await vi.waitFor(() => {
      expect(reader.found).toMatchObject({ state: FindState.FOUND, current: 1, total: 2 });
    });
    expect(reader.selected()).toEqual({ pageIdx: 0, matchIdx: 0 });

    // Scroll to page 3 so page 1 is eligible for eviction and page 3 finishes OCR (maxPages=1).
    reader.session.setVisible({}, new Set());
    reader.runtime.viewer.currentPageNumber = 3;
    await vi.waitFor(() => expect(reader.asked).toEqual([1, 3]));
    reader.release(3);
    await vi.waitFor(() => expect(reader.session.recognized(3)).toBe(true));
    await vi.waitFor(() => expect(reader.session.recognized(1)).toBe(false));

    // Evicting the selected OCR match must keep page 2's native hit counted and selected.
    await vi.waitFor(() => {
      expect(reader.found).toMatchObject({ current: 1, total: 1 });
      expect(reader.selected()).toEqual({ pageIdx: 1, matchIdx: 0 });
    });
  });

  it("does not index or jump to an OCR hit evicted during initial Find text extraction", async () => {
    const eventBus = new EventBus();
    const pageJumps: number[] = [];
    let currentPage = 1;
    const linkService = {
      pagesCount: 1,
      get page() {
        return currentPage;
      },
      set page(value: number) {
        currentPage = value;
        pageJumps.push(value);
      },
    };
    const controller = new PDFFindController({
      linkService: linkService as never,
      eventBus,
      delay: 0,
      updateMatchesCountOnProgress: true,
    });
    let recognizedNow = true;
    let findAdapter: ReturnType<typeof attachPdfOcrFind> | null = null;
    const emptyNative = { items: [], styles: {} };
    const ocrContent = { items: [{ str: "EvictedNeedle", hasEOL: true }], styles: {} };
    const document: PdfOcrDocument = {
      numPages: 1,
      getPage: async () =>
        ({
          pageNumber: 1,
          ref: { num: 1, gen: 0 },
          getTextContent: async () => emptyNative,
          getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
          getViewport: () => ({ width: 612, height: 792, viewBox: [0, 0, 612, 792] }),
        }) as never,
    };
    const session = {
      setFindExtracting: () => undefined,
      recognized: () => recognizedNow,
      nativeTextContent: async () => emptyNative,
      findTextContent: async () => ({ native: emptyNative, recognized: ocrContent }),
    } as unknown as PdfOcrSession;

    findAdapter = attachPdfOcrFind({
      controller,
      eventBus: eventBus as never,
      document,
      session,
      owner: {},
      staleLayer: () => {
        // Queue eviction right before createPagesProxy returns composed OCR text, so evicted(1)
        // runs after complete.add(1) and before #extractText() reads textContent.items.
        queueMicrotask(() => {
          recognizedNow = false;
          findAdapter?.evicted(1);
        });
        return false;
      },
    });
    const counts: Array<{ current: number; total: number }> = [];
    eventBus.on(
      "updatefindmatchescount",
      ({ matchesCount }: { matchesCount: { current: number; total: number } }) => {
        counts.push(matchesCount);
      },
    );
    eventBus.on(
      "updatefindcontrolstate",
      ({ matchesCount }: { matchesCount: { current: number; total: number } }) => {
        counts.push(matchesCount);
      },
    );

    eventBus.dispatch("find", {
      source: controller,
      type: "again",
      query: "EvictedNeedle",
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: false,
      matchDiacritics: true,
    });

    const fields = controller as unknown as {
      _extractTextPromises: Array<Promise<void> | undefined>;
      _pageContents: string[];
      _pageMatches: Array<number[] | undefined>;
      _matchesCountTotal: number;
    };
    await vi.waitFor(() => expect(fields._extractTextPromises[0]).toBeDefined());
    await fields._extractTextPromises[0];
    await vi.waitFor(() => expect(fields._pageMatches[0]).toBeDefined());
    expect(fields._pageContents[0]).toBe("");
    expect(fields._pageMatches[0]).toEqual([]);
    expect(fields._matchesCountTotal).toBe(0);
    // Must never transiently report 1/1 or jump to the evicted page.
    expect(counts.every((entry) => entry.total === 0 && entry.current === 0)).toBe(true);
    expect(pageJumps).toEqual([]);
    findAdapter.detach();
  });
});
