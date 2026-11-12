// @effect-diagnostics nodeBuiltinImport:off -- Test fixtures write synthetic projects and PDFs to a temporary folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import { PDF_TEXT_PROFILE, type PdfTextPageSelector } from "@scientfactory/document-artifacts";
import type { ScientPdfAnnotationAnchor } from "@t3tools/contracts";

/** A temporary initialized Scient project, removed on dispose. */
export async function temporaryProject(): Promise<{
  readonly root: string;
  [Symbol.asyncDispose](): Promise<void>;
}> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-annotations-")),
  );
  await initializeScientProject({ root });
  return {
    root,
    [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

function escapePdfText(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

/** A small valid PDF with one page per entry, each line drawn in Helvetica. */
export function textPdf(pages: ReadonlyArray<ReadonlyArray<string>>): Uint8Array {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((lines, index) => {
    const content = `BT /F1 12 Tf 72 720 Td 14 TL ${lines
      .map((line) => `(${escapePdfText(line)}) Tj T*`)
      .join(" ")} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  });
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

export async function writeProjectFile(
  root: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const target = NodePath.join(root, ...relativePath.split("/"));
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  await NodeFSP.writeFile(target, bytes);
}

/** An anchor as a reader would store it for `quote` at `start` of a page whose text is `text`. */
export function readerAnchor(input: {
  readonly page?: number;
  readonly text: string;
  readonly quote: string;
}): ScientPdfAnnotationAnchor {
  const start = input.text.indexOf(input.quote);
  if (start < 0) throw new Error("The quote is not in the page text.");
  const end = start + input.quote.length;
  const page: PdfTextPageSelector = {
    page: input.page ?? 1,
    viewBox: [0, 0, 612, 792],
    rotation: 0,
    userUnit: 1,
    pageTextHash: "0".repeat(64),
    start,
    end,
    quote: input.quote,
    prefix: input.text.slice(Math.max(0, start - 64), start),
    suffix: input.text.slice(end, end + 64),
  };
  return {
    extractor: { profile: PDF_TEXT_PROFILE, version: "test" },
    selector: { type: "text", pages: [page] },
  };
}
