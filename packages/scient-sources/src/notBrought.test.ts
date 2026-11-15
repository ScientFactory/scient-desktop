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
