import { expect, it, vi } from "vite-plus/test";

import { startPdfDocumentLoad } from "./pdfRuntime";

function onePagePdf() {
  const text = "BT /F1 24 Tf 30 700 Td (Results) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets: Array<number> = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 6\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const url = URL.createObjectURL(new Blob([source], { type: "application/pdf" }));
  return { url, [Symbol.dispose]: () => URL.revokeObjectURL(url) };
}

function countWorkerStarts() {
  const counter = {
    started: [] as Array<Worker>,
    [Symbol.dispose]: () => vi.unstubAllGlobals(),
  };
  vi.stubGlobal(
    "Worker",
    class extends Worker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        counter.started.push(this);
      }
    },
  );
  return counter;
}

it("opens every document on one pdf.js worker, replaced only after it reports an error", async () => {
  using workers = countWorkerStarts();
  using pdf = onePagePdf();
  const callbacks = { onPassword: () => {}, onProgress: () => {} };

  const first = startPdfDocumentLoad(pdf.url, callbacks);
  expect((await first.promise).numPages).toBe(1);
  await first.destroy();

  const second = startPdfDocumentLoad(pdf.url, callbacks);
  const third = startPdfDocumentLoad(pdf.url, callbacks);
  expect((await second.promise).numPages).toBe(1);
  expect((await third.promise).numPages).toBe(1);
  await Promise.all([second.destroy(), third.destroy()]);
  expect(workers.started).toHaveLength(1);

  workers.started[0]!.dispatchEvent(new Event("error"));
  const afterError = startPdfDocumentLoad(pdf.url, callbacks);
  expect((await afterError.promise).numPages).toBe(1);
  await afterError.destroy();
  expect(workers.started).toHaveLength(2);
});
