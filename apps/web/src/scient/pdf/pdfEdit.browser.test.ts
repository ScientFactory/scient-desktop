import { expect, it, vi } from "vite-plus/test";
import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, StandardFonts } from "pdf-lib";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
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

function editingWorker() {
  const worker = new Worker(new URL("./pdfEdit.worker.ts", import.meta.url), { type: "module" });
  return { worker, [Symbol.dispose]: () => worker.terminate() };
}

async function pageLabels(bytes: Uint8Array) {
  using _workerUrl = vi
    .spyOn(GlobalWorkerOptions, "workerSrc", "get")
    .mockReturnValue(pdfWorkerUrl);
  const task = getDocument({ data: bytes });
  await using _task = { [Symbol.asyncDispose]: () => task.destroy() };
  return await (await task.promise).getPageLabels();
}

async function labeledPdf() {
  const document = await PDFDocument.create();
  for (let i = 0; i < 8; i++) document.addPage();
  const frontMatter = document.context.register(
    document.context.obj({
      Limits: [0, 2],
      Nums: [0, { S: "r" }, 2, { S: "D", St: 1 }],
    }),
  );
  const appendix = document.context.register(
    document.context.obj({
      Limits: [4, 6],
      Nums: [4, { S: "A", St: 27, P: PDFString.of("A-") }, 6, { P: PDFHexString.fromText("封面") }],
    }),
  );
  document.catalog.set(
    PDFName.of("PageLabels"),
    document.context.obj({ Kids: [frontMatter, appendix] }),
  );
  return document.save();
}

it.each([
  {
    action: "deleting a Roman-numbered front-matter page",
    order: [1, 2, 3, 4, 5, 6, 7],
    labels: ["ii", "1", "2", "A-AA", "A-BB", "封面", "封面"],
  },
  {
    action: "moving pages across numbering sections",
    order: [3, 1, 6, 0, 2, 4, 5, 7],
    labels: ["2", "ii", "封面", "i", "1", "A-AA", "A-BB", "封面"],
  },
])(
  "keeps labels with their source pages when $action, and restores their original order",
  async ({ order, labels }) => {
    using editor = editingWorker();
    const loaded = await request(editor.worker, {
      kind: "load",
      id: 1,
      sourceId: "labels",
      bytes: await labeledPdf(),
    });
    if (loaded.kind !== "loaded") throw new Error("Expected loaded pages.");
    const built = await request(editor.worker, {
      kind: "build",
      id: 2,
      pages: order.map((index) => loaded.pages[index]!),
    });
    if (built.kind !== "built") throw new Error("Expected the edited PDF.");
    expect(await pageLabels(built.bytes)).toEqual(labels);
    const restored = await request(editor.worker, { kind: "build", id: 3, pages: loaded.pages });
    if (restored.kind !== "built") throw new Error("Expected the restored PDF.");
    expect(await pageLabels(restored.bytes)).toEqual([
      "i",
      "ii",
      "1",
      "2",
      "A-AA",
      "A-BB",
      "封面",
      "封面",
    ]);
  },
);

it("keeps automatic numbering without labels and preserves imported and duplicated labels beside blank pages", async () => {
  using editor = editingWorker();
  const source = await PDFDocument.create();
  source.addPage();
  source.addPage();
  const base = await request(editor.worker, {
    kind: "load",
    id: 1,
    sourceId: "base",
    bytes: await source.save(),
  });
  if (base.kind !== "loaded") throw new Error("Expected loaded pages.");
  const ordinary = await request(editor.worker, {
    kind: "build",
    id: 2,
    pages: [base.pages[1]!, base.pages[0]!],
  });
  if (ordinary.kind !== "built") throw new Error("Expected the edited PDF.");
  expect(await pageLabels(ordinary.bytes)).toBeNull();
  const imported = await request(editor.worker, {
    kind: "load",
    id: 3,
    sourceId: "imported",
    bytes: await labeledPdf(),
  });
  if (imported.kind !== "loaded") throw new Error("Expected imported pages.");
  const firstBodyPage = imported.pages[2]!;
  const built = await request(editor.worker, {
    kind: "build",
    id: 4,
    pages: [
      base.pages[0]!,
      imported.pages[1]!,
      firstBodyPage,
      { ...firstBodyPage, id: "duplicate" },
      { ...base.pages[0]!, id: "blank", sourceId: null },
      base.pages[1]!,
    ],
  });
  if (built.kind !== "built") throw new Error("Expected the edited PDF.");
  expect(await pageLabels(built.bytes)).toEqual(["1", "ii", "1", "1", "5", "6"]);
});

it("rejects a label tree without an initial range before editing", async () => {
  using editor = editingWorker();
  const source = await PDFDocument.create();
  source.addPage();
  source.addPage();
  source.catalog.set(PDFName.of("PageLabels"), source.context.obj({ Nums: [1, { S: "D" }] }));
  await expect(
    request(editor.worker, {
      kind: "load",
      id: 1,
      sourceId: "invalid-labels",
      bytes: await source.save(),
    }),
  ).rejects.toThrow("page labels could not be preserved");
});
