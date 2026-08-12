import { describe, expect, it } from "@effect/vitest";

import { zoteroItemToCandidate } from "./ZoteroLocalAdapter.ts";

describe("Zotero local adapter", () => {
  it("normalizes Zotero metadata without making Zotero the Scient schema", () => {
    const candidate = zoteroItemToCandidate({
      key: "ABCD2345",
      version: 7,
      library: { type: "user", id: 0 },
      data: {
        key: "ABCD2345",
        version: 7,
        itemType: "journalArticle",
        title: "A study",
        creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" }],
        date: "2026-03-10",
        DOI: "10.1000/example",
        tags: [{ tag: "important" }],
      },
    });

    expect(candidate).toMatchObject({
      type: "article",
      title: "A study",
      issuedYear: 2026,
      externalReference: {
        system: "zotero",
        itemKey: "ABCD2345",
        rawItemType: "journalArticle",
      },
    });
    expect(candidate.identifiers).toEqual([{ scheme: "doi", value: "10.1000/example" }]);
    expect(candidate.fieldProvenance).toEqual(
      expect.arrayContaining([
        { field: "title", origin: "zotero", sourceField: "title" },
        { field: "creators", origin: "zotero", sourceField: "creators" },
        { field: "identifiers.doi", origin: "zotero", sourceField: "DOI" },
      ]),
    );
    expect(candidate.fieldProvenance).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "abstract" }),
        expect.objectContaining({ field: "publisher" }),
      ]),
    );
  });
});
