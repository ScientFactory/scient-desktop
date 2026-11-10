import { describe, expect, it } from "@effect/vitest";
import { ZoteroLibraryPage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { zoteroItem } from "./Zotero.testkit.ts";
import { betterBibTexCitationKeys } from "./ZoteroLocalAdapter.ts";
import {
  zoteroDescendantCollectionKeys,
  zoteroItemMaterial,
  zoteroItemToCandidate,
  zoteroItemWithChildrenToCandidate,
  zoteroNoteToText,
} from "./ZoteroItems.ts";

describe("Zotero items", () => {
  it("includes nested collection descendants exactly once", () => {
    expect(
      new Set(
        zoteroDescendantCollectionKeys("ROOT2345", [
          { key: "ROOT2345", name: "Project", parentCollectionKey: null },
          { key: "CHLD2345", name: "Evidence", parentCollectionKey: "ROOT2345" },
          { key: "DEEP2345", name: "Included", parentCollectionKey: "CHLD2345" },
          { key: "OTHR2345", name: "Other", parentCollectionKey: null },
        ]),
      ),
    ).toEqual(new Set(["ROOT2345", "CHLD2345", "DEEP2345"]));
  });

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
        abstractNote:
          "<jats:sec><jats:title>Objective</jats:title><jats:p>Test &amp; verify.</jats:p></jats:sec>",
        tags: [{ tag: "important" }],
      },
    });

    expect(candidate).toMatchObject({
      type: "article",
      title: "A study",
      issuedYear: 2026,
      abstract: "Objective\n\nTest & verify.",
      abstractSections: [{ title: "Objective", paragraphs: ["Test & verify."] }],
      sourceKey: "ABCD2345",
      externalReferences: [
        {
          system: "zotero",
          itemKey: "ABCD2345",
          rawItemType: "journalArticle",
        },
      ],
    });
    expect(candidate.identifiers).toEqual([{ scheme: "doi", value: "10.1000/example" }]);
    expect(candidate.fieldProvenance).toEqual(
      expect.arrayContaining([
        { field: "title", origin: "zotero", sourceField: "title" },
        { field: "creators", origin: "zotero", sourceField: "creators" },
        { field: "identifiers.doi", origin: "zotero", sourceField: "DOI" },
        { field: "abstract", origin: "zotero", sourceField: "abstractNote" },
      ]),
    );
    expect(candidate.fieldProvenance).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "publisher" })]),
    );
  });

  it("reports every PDF while choosing one attachment deterministically", () => {
    const item = {
      key: "ABCD2345",
      version: 7,
      library: { type: "user", id: 0 },
      data: { key: "ABCD2345", version: 7, itemType: "journalArticle", title: "A study" },
    };
    const candidate = zoteroItemWithChildrenToCandidate(item, [
      {
        key: "PDF23456",
        version: 1,
        library: { type: "user", id: 0 },
        data: {
          key: "PDF23456",
          version: 1,
          itemType: "attachment",
          contentType: "application/pdf",
          filename: "supplement.pdf",
        },
      },
      {
        key: "NOTE2345",
        version: 1,
        library: { type: "user", id: 0 },
        data: { key: "NOTE2345", version: 1, itemType: "note" },
      },
      {
        key: "PDF34567",
        version: 1,
        library: { type: "user", id: 0 },
        data: {
          key: "PDF34567",
          version: 1,
          itemType: "attachment",
          contentType: "application/pdf",
          filename: "article.pdf",
        },
      },
    ]);

    expect(candidate).toMatchObject({
      pdfAvailable: true,
      pdfAttachmentCount: 2,
      pdfFileName: "article.pdf",
    });
  });

  it("preserves an unmapped Zotero item type as the custom source type", () => {
    const candidate = zoteroItemToCandidate({
      key: "ABCD2345",
      version: 7,
      library: { type: "user", id: 0 },
      data: {
        key: "ABCD2345",
        version: 7,
        itemType: "clinicalGuideline",
        title: "A clinical guideline",
      },
    });

    expect(candidate).toMatchObject({
      type: "other",
      customType: "clinicalGuideline",
    });
  });

  it("round-trips adapter output through the public Zotero library wire contract", () => {
    const candidate = zoteroItemToCandidate({
      key: "ABCD2345",
      version: 7,
      library: { type: "user", id: 0 },
      data: {
        key: "ABCD2345",
        version: 7,
        itemType: "journalArticle",
        title: "A study",
      },
    });
    const page: ZoteroLibraryPage = {
      scope: { kind: "library" },
      items: [candidate],
      start: 0,
      nextStart: 1,
      total: 1,
      hasMore: false,
    };
    const wireCodec = Schema.toCodecJson(ZoteroLibraryPage);
    const encoded = Schema.encodeUnknownSync(wireCodec)(page);

    expect(Schema.decodeSync(wireCodec)(encoded)).toStrictEqual(page);

    const itemWithoutAttachmentCount = { ...candidate } as Record<string, unknown>;
    delete itemWithoutAttachmentCount.pdfAttachmentCount;
    expect(() =>
      Schema.decodeSync(wireCodec)(
        JSON.stringify({
          ...page,
          items: [itemWithoutAttachmentCount],
        }),
      ),
    ).toThrow();
  });

  it("reads identifiers and the citation key that Zotero keeps in Extra", () => {
    const material = zoteroItemMaterial(
      zoteroItem("ABCD2345", {
        extra: "PMID: 31234567\nCitation Key: lovelace2026study\narXiv: 2601.00001",
      }),
      [],
    );

    expect(material.candidate.identifiers).toEqual([
      { scheme: "pmid", value: "31234567" },
      { scheme: "arxiv", value: "2601.00001" },
    ]);
    expect(material.candidate.fieldProvenance).toEqual(
      expect.arrayContaining([
        { field: "identifiers.pmid", origin: "zotero", sourceField: "extra" },
      ]),
    );
    expect(material.citationKey).toBe("lovelace2026study");
  });

  it("prefers Zotero's own citation key field over Extra", () => {
    const material = zoteroItemMaterial(
      zoteroItem("ABCD2345", { citationKey: "native2026", extra: "Citation Key: pinned2026" }),
      [],
    );

    expect(material.citationKey).toBe("native2026");
  });

  it("maps type-specific container and publisher fields", () => {
    expect(
      zoteroItemToCandidate(
        zoteroItem("ABCD2345", { itemType: "thesis", university: "University of Haifa" }),
      ).publisher,
    ).toBe("University of Haifa");
    expect(
      zoteroItemToCandidate(zoteroItem("ABCD2345", { itemType: "webpage", websiteTitle: "Nature" }))
        .containerTitle,
    ).toBe("Nature");
  });

  it("joins child notes as text and skips linked URLs as PDFs", () => {
    const material = zoteroItemMaterial(zoteroItem("ABCD2345"), [
      zoteroItem("NOTE3456", { itemType: "note", note: "<p>Second <em>note</em></p>" }),
      zoteroItem("NOTE2345", { itemType: "note", note: "<p>First &amp; <strong>key</strong></p>" }),
      zoteroItem("LINK2345", {
        itemType: "attachment",
        contentType: "application/pdf",
        linkMode: "linked_url",
      }),
    ]);

    expect(material.note).toBe("First & **key**\n\n---\n\nSecond *note*");
    expect(material.pdfs).toEqual([]);
  });

  it("turns note HTML lists and breaks into readable lines", () => {
    expect(zoteroNoteToText("<h1>Aims</h1><ul><li>one</li><li>two</li></ul>a<br>b")).toBe(
      "Aims\n\n- one\n\n- two\n\na\nb",
    );
  });
});

describe("Better BibTeX keys", () => {
  it("reads keys by item key, with or without a library prefix", () => {
    expect(
      betterBibTexCitationKeys(
        JSON.stringify({ result: { ABCD2345: "ada2026", "1:EFGH2345": "lovelace1843", X: "" } }),
      ),
    ).toEqual(
      new Map([
        ["ABCD2345", "ada2026"],
        ["EFGH2345", "lovelace1843"],
      ]),
    );
  });
});
