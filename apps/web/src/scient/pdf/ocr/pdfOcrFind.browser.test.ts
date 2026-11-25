import { AnnotationMode, OPS, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { FindState } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import { describe, expect, it, vi } from "vite-plus/test";

import { createPdfRuntime } from "../pdfRuntime";
import { attachPdfOcr } from "./pdfOcr";
import { createMemoryPdfOcrCache } from "./pdfOcrCache";
import { createPdfOcrQueue } from "./pdfOcrQueue";
import { createPdfOcrSession, type PdfOcrDocument } from "./pdfOcrSession";
import { pdfTextLayerHasOcr, type PdfOcrLine } from "./pdfOcrText";

import "pdfjs-dist/legacy/web/pdf_viewer.css";

/** A PDF whose pages are scans (one gray image, no text) or a line of their own text. */
function pdfOf(pages: ReadonlyArray<"scan" | string>): Uint8Array {
  const objects = [
    "", // Pages, written once the page objects are numbered.
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nw\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  const kids: string[] = [];
  for (const page of pages) {
    const content =
      page === "scan" ? "q 612 0 0 792 0 0 cm /Im1 Do Q" : `BT /F1 14 Tf 72 700 Td (${page}) Tj ET`;
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
  pages: ReadonlyArray<"scan" | string>,
  options: {
    readonly height: number;
    readonly slots: number;
    readonly read: Record<number, string>;
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
    cache: createMemoryPdfOcrCache(),
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
  const detach = attachPdfOcr(runtime, session);
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
    queue,
    selected,
    asked,
    found,
    find,
    release,
    layer,
    [Symbol.asyncDispose]: async () => {
      for (const resolve of waiting.values()) resolve();
      detach();
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
});
