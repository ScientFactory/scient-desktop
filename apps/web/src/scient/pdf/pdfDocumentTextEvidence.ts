import type { PDFDocumentProxy } from "./pdfRuntime";

const MAX_EVIDENCE_PAGES = 2_000;
const MAX_EVIDENCE_ITEMS = 500_000;
const MAX_EVIDENCE_TEXT_UNITS = 10_000_000;

/**
 * Read the immutable PDF text-item stream without materializing every page in
 * the viewer. Visual editing uses this as document-wide output evidence, so a
 * limit breach returns no evidence rather than blessing a partial prefix.
 */
export async function readPdfDocumentTextItems(
  document: PDFDocumentProxy,
): Promise<readonly string[] | null> {
  if (document.numPages < 1 || document.numPages > MAX_EVIDENCE_PAGES) return null;

  const items: string[] = [];
  let textUnits = 0;
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!("str" in item) || item.str.length === 0) continue;
      items.push(item.str);
      textUnits += item.str.length;
      if (items.length > MAX_EVIDENCE_ITEMS || textUnits > MAX_EVIDENCE_TEXT_UNITS) return null;
    }
  }
  return items;
}
