import { ArtifactAuthority, LogicalDocumentKey } from "@scientfactory/document-artifacts";
import { AnnotationMode, OPS, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it, vi } from "vite-plus/test";

import { readPdfTextSelection } from "../anchors/pdfTextLayer";
import { pdfTextTarget } from "../anchors/pdfTextTarget";
import { createPdfRuntime } from "../pdfRuntime";
import { attachPdfOcr } from "./pdfOcr";
import { createMemoryPdfOcrCache } from "./pdfOcrCache";
import { createPdfOcrQueue } from "./pdfOcrQueue";
import { createPdfOcrSession, type PdfOcrDocument } from "./pdfOcrSession";
import { PDF_OCR_ENGINE, pdfTextLayerHasOcr, type PdfOcrLine } from "./pdfOcrText";

import "pdfjs-dist/legacy/web/pdf_viewer.css";

/** A one-page scan: a single gray image over the whole page and no text of its own. */
function scannedPdf(): Uint8Array {
  const content = "q 612 0 0 792 0 0 cm /Im1 Do Q";
  const objects = [
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nw\nendstream",
    "<< /Type /Page /Parent 1 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 2 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Catalog /Pages 1 0 R >>",
  ];
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

const lines: PdfOcrLine[] = [
  {
    rtl: true,
    box: { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.13 },
    words: [
      { text: "המינון", confidence: 92, box: { x0: 0.7, y0: 0.1, x1: 0.8, y1: 0.13 } },
      { text: "mg", confidence: 96, box: { x0: 0.6, y0: 0.1, x1: 0.65, y1: 0.13 } },
      { text: "10-20", confidence: 90, box: { x0: 0.45, y0: 0.1, x1: 0.58, y1: 0.13 } },
    ],
  },
];

describe("reading a scanned PDF in the reader", () => {
  it("searches, selects and quotes recognized text on a scanned page", async () => {
    const task = getDocument({ data: scannedPdf() });
    const document = await task.promise;
    const recognize = vi.fn(async () => lines);
    const session = createPdfOcrSession(document as unknown as PdfOcrDocument, "scan", {
      engine: () => ({ recognize }),
      queue: createPdfOcrQueue(1),
      cache: createMemoryPdfOcrCache(),
      render: async () => ({
        blob: new Blob(["page"]),
        bytes: new Uint8Array([1]),
        width: 1,
        height: 1,
      }),
      ascent: () => 0.8,
      ops: OPS,
      annotationMode: AnnotationMode.ENABLE_FORMS,
    });
    const container = window.document.createElement("div");
    container.style.cssText = "position:absolute;inset:0;overflow:auto";
    const viewerElement = window.document.createElement("div");
    viewerElement.className = "pdfViewer";
    container.append(viewerElement);
    window.document.body.append(container);
    const runtime = createPdfRuntime({
      container,
      viewerElement,
      document,
      sourceUrl: "test:scan",
    });
    // The reader sets a scale once pages exist; PDF.js draws nothing before.
    runtime.eventBus.on("pagesinit", () => {
      runtime.viewer.currentScaleValue = "page-width";
      runtime.viewer.update();
    });
    const detach = attachPdfOcr(runtime, session);
    await using _cleanup = {
      [Symbol.asyncDispose]: async () => {
        detach();
        session.dispose();
        await runtime.destroy();
        container.remove();
        await task.destroy();
      },
    };

    // The page is drawn with its own (no) text, read once, and its text layer drawn again.
    const layer = await vi.waitFor(() => {
      const div = container.querySelector<HTMLElement>('.page[data-page-number="1"] .textLayer');
      if (!div || !pdfTextLayerHasOcr(div))
        throw new Error(
          `not read yet: ${JSON.stringify({ layer: !!div, pages: container.querySelectorAll(".page").length, calls: recognize.mock.calls.length, state: session.pageState(1), coverage: session.coverage(), html: container.querySelector(".page")?.innerHTML.slice(0, 300) })}`,
        );
      return div;
    });
    expect(layer.textContent).toBe("המינון 10-20 mg");
    expect(recognize).toHaveBeenCalledTimes(1);

    // A selection on the scan becomes a quote that says its text was recognized.
    const spans = [...layer.querySelectorAll("span:not(.markedContent)")].filter(
      (span) => span.textContent === "10-20" || span.textContent === "mg",
    );
    const range = window.document.createRange();
    range.setStart(spans[0]!.firstChild!, 0);
    range.setEnd(spans[1]!.firstChild!, 2);
    const selection = window.document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const read = readPdfTextSelection(runtime, selection);
    selection.removeAllRanges();
    expect(read._tag).toBe("Ready");
    if (read._tag !== "Ready") return;
    const built = pdfTextTarget({
      document: {
        authority: ArtifactAuthority.make("environment-1"),
        logicalDocumentKey: LogicalDocumentKey.make("workspace:/p/scan.pdf"),
        title: "scan.pdf",
        fileName: "scan.pdf",
        locator: { _tag: "workspace", workspaceRoot: "/p", relativePath: "scan.pdf" },
      },
      material: null,
      pages: read.pages,
    });
    expect(built._tag).toBe("Target");
    if (built._tag !== "Target") return;
    expect(built.target.selector.pages[0]).toMatchObject({
      quote: "10-20 mg",
      recognized: { engine: PDF_OCR_ENGINE, geometry: "word-box" },
    });

    // Find reads the same text without reading the page again.
    const found = new Promise<number>((resolve) =>
      runtime.eventBus.on(
        "updatefindmatchescount",
        ({ matchesCount }: { matchesCount: { total: number } }) => {
          if (matchesCount.total > 0) resolve(matchesCount.total);
        },
      ),
    );
    runtime.eventBus.dispatch("find", {
      source: runtime,
      type: "",
      query: "10-20 mg",
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: false,
      matchDiacritics: true,
    });
    expect(await found).toBe(1);
    expect(recognize).toHaveBeenCalledTimes(1);
  });
});
