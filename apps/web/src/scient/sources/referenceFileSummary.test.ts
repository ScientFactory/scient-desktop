import type { ScientSourceImportOperation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isReferenceFileName, referenceFileNotes } from "./referenceFileSummary";

type Item = ScientSourceImportOperation["items"][number];

const report = {
  format: "bibtex" as const,
  entryCount: 10,
  importCount: 10,
  alreadyInLibrary: 0,
  remaining: 0,
  unreadableCount: 0,
  unreadable: [],
  notKept: [],
  withoutCitationKey: 0,
};

const imported = (itemKey: string, fields: Partial<Item> = {}): Item => ({
  itemKey,
  state: "imported",
  sourceId: `source_${itemKey}`,
  message: null,
  ...fields,
});

describe("what a reference file import says went otherwise", () => {
  it("says nothing when every entry came in as the file says", () => {
    expect(referenceFileNotes({ report, items: [imported("a")] })).toEqual({
      notes: [],
      details: [],
    });
  });

  it("names a key this project already uses and the key the work got instead", () => {
    const items = [
      imported("a", {
        citationKeys: [{ citationKey: "smith2020", outcome: "taken" }],
        projectKey: "smith2020a",
      }),
    ];
    expect(
      referenceFileNotes({
        report,
        items,
        sourceTitle: (id) => (id === "source_a" ? "Tidal heating of Io" : null),
      }).notes,
    ).toEqual([
      "smith2020 already cites another source in this project, which keeps it; this project cites Tidal heating of Io as smith2020a",
    ]);
  });

  it("says nothing of an author list for a work that was already present", () => {
    const notes = referenceFileNotes({
      report: { ...report, incompleteAuthors: [{ sourceKey: "a", label: "a2021", named: 3 }] },
      items: [{ ...imported("a"), state: "skipped", duplicateKind: "same-identifier" }],
    }).notes;
    expect(notes).toEqual([]);
  });

  it("counts unreadable entries, PDFs not attached and fields not kept, and lists each", () => {
    const { notes, details } = referenceFileNotes({
      report: {
        ...report,
        unreadableCount: 1,
        unreadable: [{ line: 7, citationKey: "broken", reason: "This entry could not be read." }],
        notKept: [
          { field: "file", reason: "not found", entryCount: 2, citationKeys: ["a", "b"] },
          { field: "file", reason: "not a PDF", entryCount: 1, citationKeys: ["c"] },
          { field: "address", entryCount: 9, citationKeys: ["a", "b", "c", "d", "e"] },
        ],
        remaining: 240,
      },
      items: [],
    });
    expect(notes).toEqual([
      "1 entry could not be read",
      "3 linked PDFs were not attached",
      "Fields not kept: address (9)",
      "240 more new references in the file are not imported yet",
    ]);
    expect(details).toEqual([
      "Line 7 · broken: This entry could not be read.",
      "PDF not attached (not found): a, b",
      "PDF not attached (not a PDF): c",
      "address not kept: a, b, c, d, e and 4 more",
    ]);
  });

  it.each([
    ["refs.BIB", true],
    ["export.ris", true],
    ["zotero.json", true],
    ["endnote.xml", true],
    // regression: a dropped RIS or BibTeX .txt went through PDF intake
    ["pubmed-export.txt", true],
    ["paper.pdf", false],
  ])("recognises %s as a reference file: %s", (name, expected) => {
    expect(isReferenceFileName(name)).toBe(expected);
  });
});
