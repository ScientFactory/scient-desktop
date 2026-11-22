/** Where a printed page label is in a PDF. */
export type PdfPageLabelMatch =
  | { readonly _tag: "Found"; readonly page: number }
  /** Several pages carry the label (each part restarting at 1, say): the first is shown. */
  | { readonly _tag: "Repeated"; readonly page: number }
  | { readonly _tag: "Missing" };

/**
 * The page a printed label names, from the PDF's own page labels (pdf.js `getPageLabels`), or
 * its page number when the PDF has none. Labels compare without regard to case, so `xii`
 * finds a page labelled `XII`.
 */
export function pdfPageForLabel(
  label: string,
  labels: ReadonlyArray<string> | null,
  pageCount: number,
): PdfPageLabelMatch {
  const wanted = label.trim();
  if (labels === null || labels.length === 0) {
    const page = /^[0-9]+$/u.test(wanted) ? Number(wanted) : 0;
    return page >= 1 && page <= pageCount ? { _tag: "Found", page } : { _tag: "Missing" };
  }
  let pages = labels.flatMap((value, index) => (value.trim() === wanted ? [index + 1] : []));
  if (pages.length === 0) {
    const folded = wanted.toLowerCase();
    pages = labels.flatMap((value, index) =>
      value.trim().toLowerCase() === folded ? [index + 1] : [],
    );
  }
  const [first] = pages;
  if (first === undefined) return { _tag: "Missing" };
  return pages.length === 1 ? { _tag: "Found", page: first } : { _tag: "Repeated", page: first };
}
