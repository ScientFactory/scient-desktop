import { describe, expect, it } from "vite-plus/test";

import { isReferenceFileName, summarizeReferenceFileReport } from "./referenceFileSummary";

const report = {
  format: "bibtex" as const,
  entryCount: 10,
  importCount: 6,
  alreadyInLibrary: 4,
  remaining: 0,
  unreadableCount: 0,
  unreadable: [],
  notKept: [],
  withoutCitationKey: 0,
};

describe("reference file import summary", () => {
  it("says nothing when every entry came in", () => {
    expect(summarizeReferenceFileReport("a.bib", report)).toBeNull();
  });

  it("says when the file had no references", () => {
    expect(summarizeReferenceFileReport("a.bib", { ...report, entryCount: 0 })?.title).toBe(
      "No references found in a.bib",
    );
  });

  it("offers to continue a large file", () => {
    expect(summarizeReferenceFileReport("a.bib", { ...report, remaining: 240 })).toEqual({
      title: "More references in a.bib",
      lines: ["6 of 246 new references were imported. Import the file again for the rest."],
      hasDetails: false,
      canContinue: true,
    });
  });

  it("lists unreadable entries and the most common fields not kept", () => {
    const fields = ["file", "address", "urldate", "edition", "series"].map((field, index) => ({
      field,
      entryCount: 10 - index,
      citationKeys: ["a"],
    }));
    expect(
      summarizeReferenceFileReport("a.bib", {
        ...report,
        unreadableCount: 1,
        unreadable: [{ line: 7, citationKey: "broken", reason: "This entry could not be read." }],
        notKept: fields,
      }),
    ).toEqual({
      title: "Not everything in a.bib came in",
      lines: [
        "1 entry could not be read.",
        "Fields not kept: file (10), address (9), urldate (8), edition (7), and 1 more.",
      ],
      hasDetails: true,
      canContinue: false,
    });
  });

  it("counts a linked-file field once across its reasons", () => {
    const linked = (reason: string, entryCount: number) => ({
      field: "file",
      reason,
      entryCount,
      citationKeys: ["a"],
    });
    expect(
      summarizeReferenceFileReport("a.bib", {
        ...report,
        notKept: [linked("not found", 2), linked("not a PDF", 1)],
      })?.lines,
    ).toEqual(["Fields not kept: file (3)."]);
  });

  it.each([
    ["refs.BIB", true],
    ["export.ris", true],
    ["zotero.json", true],
    ["endnote.xml", true],
    ["paper.pdf", false],
  ])("recognises %s as a reference file: %s", (name, expected) => {
    expect(isReferenceFileName(name)).toBe(expected);
  });
});
