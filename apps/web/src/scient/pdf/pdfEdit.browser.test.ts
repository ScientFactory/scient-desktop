import { expect, it } from "vite-plus/test";
import { PDFDocument, PDFName, PDFNumber, StandardFonts } from "pdf-lib";
import type { PdfEditWorkerRequest, PdfEditWorkerResponse } from "./pdfPageEdits";

function request(worker: Worker, input: PdfEditWorkerRequest) {
  return new Promise<PdfEditWorkerResponse>((resolve, reject) => {
    function onError() {
      worker.removeEventListener("message", onMessage);
      reject(new Error("PDF editing worker failed."));
    }
    function onMessage(event: MessageEvent<PdfEditWorkerResponse>) {
      worker.removeEventListener("error", onError);
      if (event.data.kind === "error") reject(new Error(event.data.message));
      else resolve(event.data);
    }
    worker.addEventListener("message", onMessage, { once: true });
    worker.addEventListener("error", onError, { once: true });
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker messages do not accept Window origins.
    worker.postMessage(input);
  });
}

it("preserves resources and page boxes inherited from a nested page tree when rotating", async () => {
  const source = await PDFDocument.create();
  const first = source.addPage([612, 792]);
  const second = source.addPage([612, 792]);
  const font = await source.embedFont(StandardFonts.Helvetica);
  first.drawText("Inherited font resources", { x: 30, y: 700, font });
  const resources = first.node.get(PDFName.of("Resources"))!;
  const root = source.catalog.Pages();
  const branch = source.context.obj({
    Type: "Pages",
    Parent: source.catalog.get(PDFName.of("Pages")),
    Kids: [first.ref, second.ref],
    Count: 2,
    Resources: resources,
    MediaBox: [0, 0, 612, 792],
    CropBox: [0, 0, 600, 780],
  });
  const branchRef = source.context.register(branch);
  for (const page of [first, second]) {
    page.node.set(PDFName.of("Parent"), branchRef);
    for (const key of ["Resources", "MediaBox", "CropBox"]) page.node.delete(PDFName.of(key));
  }
  root.set(PDFName.of("Kids"), source.context.obj([branchRef]));
  root.set(PDFName.of("Count"), PDFNumber.of(2));

  const worker = new Worker(new URL("./pdfEdit.worker.ts", import.meta.url), { type: "module" });
  try {
    const loaded = await request(worker, {
      kind: "load",
      id: 1,
      sourceId: "inherited-resources",
      bytes: await source.save(),
    });
    if (loaded.kind !== "loaded") throw new Error("Expected loaded pages.");
    const built = await request(worker, {
      kind: "build",
      id: 2,
      pages: loaded.pages.map((page, index) => (index === 0 ? { ...page, rotation: 90 } : page)),
    });
    if (built.kind !== "built") throw new Error("Expected the edited PDF.");
    const saved = await PDFDocument.load(built.bytes);
    expect(saved.getPageCount()).toBe(2);
    for (const page of saved.getPages()) {
      expect(page.getMediaBox()).toEqual({ x: 0, y: 0, width: 612, height: 792 });
      expect(page.getCropBox()).toEqual({ x: 0, y: 0, width: 600, height: 780 });
      expect(page.node.Resources()?.has(PDFName.of("Font"))).toBe(true);
    }
    expect(saved.getPage(0).getRotation().angle).toBe(90);
    expect(saved.getPage(1).getRotation().angle).toBe(0);
  } finally {
    worker.terminate();
  }
});
