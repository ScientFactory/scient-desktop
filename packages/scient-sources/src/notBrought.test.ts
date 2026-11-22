import { describe, expect, it } from "@effect/vitest";

import type { ScientSourceImportOperation } from "./model.ts";
import { notBroughtAmount, notBroughtName, summarizeNotBrought } from "./notBrought.ts";

type Item = ScientSourceImportOperation["items"][number];

const item = (sourceId: string, notBrought: NonNullable<Item["notBrought"]>): Item => ({
  itemKey: `KEY${sourceId}`,
  state: "imported",
  sourceId,
  message: null,
  notBrought,
});

describe("what an import did not bring, in words", () => {
  it("adds up each thing across the import, most references first, with their sources", () => {
    const lines = summarizeNotBrought({
      items: [
        item("s1", [
          { kind: "field", name: "place", count: 1 },
          { kind: "highlights", count: 12 },
        ]),
        item("s2", [
          { kind: "field", name: "place", count: 1 },
          { kind: "file", name: "text/html", count: 2 },
        ]),
        item("s3", [{ kind: "highlights", count: 3 }]),
        // A duplicate that was skipped brought nothing, so nothing of it is "not brought".
        { ...item("s4", [{ kind: "field", name: "edition", count: 1 }]), state: "skipped" },
      ],
      notBrought: [{ kind: "notes-alone", count: 5 }],
    });
    expect(
      lines.map((line) => [notBroughtName(line), notBroughtAmount(line), line.sourceIds]),
    ).toEqual([
      ["Highlights and comments on PDFs", "15 on 2 references", ["s1", "s3"]],
      ["Place of publication", "2 references", ["s1", "s2"]],
      ["Web page snapshots", "2 on 1 reference", ["s2"]],
      ["Notes that belong to no reference", "5", []],
    ]);
  });

  it("says which references were already here, for a Zotero import only, and when Zotero was not asked", () => {
    const skipped = (
      sourceId: string,
      duplicateKind: NonNullable<Item["duplicateKind"]>,
    ): Item => ({
      itemKey: `KEY${sourceId}`,
      state: "skipped",
      duplicateKind,
      sourceId,
      message: null,
    });
    const items = [
      // The same DOI or the same PDF under another origin: nothing of Zotero's copy came.
      skipped("s1", "same-identifier"),
      skipped("s2", "same-pdf"),
      // Imported from this very Zotero item before: nothing new to say. And a possible match
      // is for the person to look at, not a reference said to be here.
      skipped("s3", "same-origin"),
      skipped("s4", "possible-metadata-match"),
    ];
    const lines = summarizeNotBrought({
      adapter: "zotero",
      items,
      notBrought: [{ kind: "alone-uncounted", count: 1 }],
    });
    expect(lines.map((line) => [line.kind, notBroughtAmount(line), line.sourceIds])).toEqual([
      ["already-here", "2 references", ["s1", "s2"]],
      ["alone-uncounted", "not counted", []],
    ]);
    expect(notBroughtName(lines[0]!)).toContain("already in your Library");
    // A reference file's own report says what it left out; this line is Zotero's.
    expect(summarizeNotBrought({ adapter: "file", items })).toEqual([]);
  });

  it("names a field Zotero's way when it has no better word, and every kind of thing", () => {
    const name = (kind: Parameters<typeof notBroughtName>[0]["kind"], value: string | null) =>
      notBroughtName({ kind, name: value });
    expect(name("field", "numPages")).toBe("Number of pages");
    expect(name("field", "programmingLanguage")).toBe("Programming language");
    expect(name("field", "legislativeBody")).toBe("Legislative body");
    expect(name("field", "PMCID")).toBe("PMCID");
    expect(name("extra", "volume-title")).toBe("Extra line “volume-title”");
    expect(name("extra", "(text)")).toBe("Other text in Extra");
    expect(name("file", "application/epub+zip")).toBe("EPUB files");
    expect(name("file", "application/x-research-info-systems")).toBe(
      "Files (application/x-research-info-systems)",
    );
    expect(name("pdf", "over-limit")).toBe("PDFs beyond the first 10 of a reference");
    expect(name("pdf", "unavailable")).toBe("PDFs Zotero could not hand over");
    expect(name("automatic-tags", null)).toBe("Automatic tags, which came in as ordinary tags");
  });
});
