import { sha256 } from "@noble/hashes/sha2";
import { expect, it, vi } from "vite-plus/test";

import { PdfEditSession } from "./pdfEditSession";

function onePagePdf(note = ""): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 4\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n${note}`;
  return new TextEncoder().encode(source);
}

const revision = (bytes: Uint8Array) =>
  "sha256:" + [...sha256(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

// regression: page edits that start from a filled-in form's bytes saved against the file's revision.
it("checks a save against the file on disk when editing starts from filled-in form bytes", async () => {
  const original = onePagePdf();
  const filled = onePagePdf("% the reader's form values");
  const persist = vi.fn(
    async (_bytes: Uint8Array, _expectedRevision: string, _operation: string) => ({
      path: "/synthetic/form.pdf",
      revision: "sha256:next",
      source: null,
      createdCopy: false,
    }),
  );
  const session = new PdfEditSession();
  session.configure(persist as never);
  await session.start(
    async () => filled,
    1,
    async () => original,
  );
  await session.rotate(90, [session.getSnapshot().frame.pages[0]!.id]);
  await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
  expect(persist.mock.calls[0]![1]).toBe(revision(original));
  await session.reset();
});
