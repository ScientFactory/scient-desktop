import { describe, expect, it } from "@effect/vitest";
import { ZoteroLibraryPage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { zoteroItemToCandidate, zoteroItemWithChildrenToCandidate } from "./ZoteroLocalAdapter.ts";

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
      ]),
    );
    expect(candidate.fieldProvenance).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "abstract" }),
        expect.objectContaining({ field: "publisher" }),
      ]),
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
      items: [candidate],
      start: 0,
      nextStart: 1,
      total: 1,
      hasMore: false,
    };
    const wireCodec = Schema.toCodecJson(ZoteroLibraryPage);
    const encoded = Schema.encodeUnknownSync(wireCodec)(page);

    expect(Schema.decodeUnknownSync(wireCodec)(encoded)).toStrictEqual(page);

    const itemWithoutAttachmentCount = { ...candidate } as Record<string, unknown>;
    delete itemWithoutAttachmentCount.pdfAttachmentCount;
    expect(() =>
      Schema.decodeUnknownSync(wireCodec)(
        JSON.stringify({
          ...page,
          items: [itemWithoutAttachmentCount],
        }),
      ),
    ).toThrow();
  });
});
