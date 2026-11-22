import { describe, expect, it } from "vite-plus/test";

import { pdfPageForLabel } from "./pdfPageLabel";

describe("pdfPageForLabel", () => {
  it("finds the page printed with the label, not the page with that number", () => {
    const labels = ["Cover", "i", "ii", "1", "2", "3", "4"];
    expect(pdfPageForLabel("4", labels, 7)).toEqual({ _tag: "Found", page: 7 });
    expect(pdfPageForLabel("II", labels, 7)).toEqual({ _tag: "Found", page: 3 });
  });

  it("uses the page number when the PDF has no labels", () => {
    expect(pdfPageForLabel("4", null, 10)).toEqual({ _tag: "Found", page: 4 });
    expect(pdfPageForLabel("345", null, 20)).toEqual({ _tag: "Missing" });
    expect(pdfPageForLabel("xii", null, 20)).toEqual({ _tag: "Missing" });
  });

  it("says when the label is missing or names more than one page", () => {
    expect(pdfPageForLabel("9", ["1", "2"], 2)).toEqual({ _tag: "Missing" });
    expect(pdfPageForLabel("1", ["1", "2", "1", "2"], 4)).toEqual({ _tag: "Repeated", page: 1 });
  });
});
