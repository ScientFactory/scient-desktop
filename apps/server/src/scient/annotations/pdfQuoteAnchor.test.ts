import { describe, expect, it } from "@effect/vitest";

import { anchorPdfQuote, type PdfPageText } from "./pdfQuoteAnchor.ts";

const geometry = { viewBox: [0, 0, 612, 792] as const, rotation: 0, userUnit: 1 };
const page = (number: number, text: string): PdfPageText => ({ page: number, text, ...geometry });

describe("anchorPdfQuote", () => {
  it("finds a quote across whitespace, case, ligature and line-end hyphen differences", () => {
    const text = "The ﬁrst  result shows that infor-\nmation\nflows downstream.\n";
    const found = anchorPdfQuote(
      [page(1, text)],
      "the first result shows that information flows",
      "6.2.108",
    );
    expect(found._tag).toBe("Found");
    if (found._tag !== "Found") return;
    const [selected] = found.anchor.selector.pages;
    expect(selected!.quote).toBe("The ﬁrst  result shows that infor-\nmation\nflows");
    expect(text.slice(selected!.start, selected!.end)).toBe(selected!.quote);
    expect(selected!.suffix).toBe(" downstream.\n");
  });

  it("splits a quote that crosses a page break into consecutive page selectors", () => {
    const found = anchorPdfQuote(
      [page(2, "Results continue on the next\n"), page(1, "Intro.\n"), page(3, "page as shown.\n")],
      "continue on the next page as shown",
      "v",
    );
    expect(found._tag).toBe("Found");
    if (found._tag !== "Found") return;
    expect(found.anchor.selector.pages.map(({ page, quote }) => [page, quote])).toEqual([
      [2, "continue on the next"],
      [3, "page as shown"],
    ]);
  });

  it("reports a repeated quote as ambiguous unless a page picks one", () => {
    const pages = [page(1, "p < 0.05 overall.\n"), page(4, "Again p < 0.05 here.\n")];
    expect(anchorPdfQuote(pages, "p < 0.05", "v")).toEqual({ _tag: "Ambiguous", pages: [1, 4] });
    const picked = anchorPdfQuote(pages, "p < 0.05", "v", 4);
    expect(picked._tag === "Found" && picked.anchor.selector.pages[0]!.page).toBe(4);
    expect(anchorPdfQuote(pages, "not in the paper", "v")).toEqual({ _tag: "NotFound" });
  });
});
