import { describe, expect, it } from "@effect/vitest";

import { doiIn, isPdf, paperFileName } from "./paperLookup.ts";

describe("paper lookup", () => {
  it("finds a DOI in links and citations, without trailing punctuation", () => {
    expect(doiIn("https://doi.org/10.1038/s41586-020-2649-2")).toBe("10.1038/s41586-020-2649-2");
    expect(doiIn("Nature 585 (2020), doi:10.1038/S41586-020-2649-2.")).toBe(
      "10.1038/s41586-020-2649-2",
    );
    expect(doiIn("https://www.sciencedirect.com/science/article/pii/S0092867420305687")).toBe(
      undefined,
    );
  });

  it("names the file after the first author, year and title, and accepts only real PDFs", () => {
    expect(
      paperFileName({
        doi: "10.1038/x",
        title: "Array programming with NumPy",
        year: 2020,
        firstAuthor: "Charles R. Harris",
        landingUrl: "https://doi.org/10.1038/x",
        openAccess: [],
      }),
    ).toBe("Harris-2020-Array-programming-with-NumPy.pdf");
    expect(isPdf(new TextEncoder().encode("%PDF-1.7\n"))).toBe(true);
    expect(isPdf(new TextEncoder().encode("<!doctype html>"))).toBe(false);
  });
});
