import { describe, expect, it, vi } from "vite-plus/test";
import type { PDFDocumentProxy } from "./pdfRuntime";
import { readPdfDocumentTextItems } from "./pdfDocumentTextEvidence";

function pdfDocument(
  pages: ReadonlyArray<ReadonlyArray<string | { readonly generated: true }>>,
): PDFDocumentProxy {
  return {
    numPages: pages.length,
    getPage: vi.fn(async (pageNumber: number) => ({
      getTextContent: async () => ({
        items: pages[pageNumber - 1]!.map((item) =>
          typeof item === "string" ? { str: item } : item,
        ),
      }),
    })),
  } as unknown as PDFDocumentProxy;
}

describe("PDF document text evidence", () => {
  it("reads every page in order and keeps only non-empty text items", async () => {
    const document = pdfDocument([["Page one", "", { generated: true }], ["Page two"]]);

    await expect(readPdfDocumentTextItems(document)).resolves.toEqual(["Page one", "Page two"]);
    expect(document.getPage).toHaveBeenCalledTimes(2);
    expect(document.getPage).toHaveBeenNthCalledWith(1, 1);
    expect(document.getPage).toHaveBeenNthCalledWith(2, 2);
  });

  it("returns no partial evidence when the document exceeds its page bound", async () => {
    const getPage = vi.fn();
    const document = { numPages: 2_001, getPage } as unknown as PDFDocumentProxy;

    await expect(readPdfDocumentTextItems(document)).resolves.toBeNull();
    expect(getPage).not.toHaveBeenCalled();
  });

  it("rejects rather than returning a partial prefix when a page cannot be read", async () => {
    const document = {
      numPages: 2,
      getPage: vi
        .fn()
        .mockResolvedValueOnce({ getTextContent: async () => ({ items: [{ str: "Page one" }] }) })
        .mockRejectedValueOnce(new Error("page unavailable")),
    } as unknown as PDFDocumentProxy;

    await expect(readPdfDocumentTextItems(document)).rejects.toThrow("page unavailable");
  });
});
