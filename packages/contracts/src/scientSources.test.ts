import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ScientSourcesLocalPdfUploadResult,
  ScientSourceDetailResult,
  ScientSourceAttachmentPreviewResult,
  ScientSourceJournalIconResult,
  ScientSourceMetadataRefreshRequest,
  ScientSourceMetadataUpdateRequest,
  ScientSourceRemovalRequest,
  ScientSourceRemovalResult,
  ScientSourcesOverviewResult,
  ZoteroLibraryRequest,
  ZoteroScopedImportRequest,
} from "./scientSources.ts";

const decodeScientSourceAttachmentPreviewResult = Schema.decodeUnknownSync(
  ScientSourceAttachmentPreviewResult,
);
const decodeScientSourceDetailResult = Schema.decodeUnknownSync(ScientSourceDetailResult);
const decodeScientSourcesOverviewResult = Schema.decodeUnknownSync(ScientSourcesOverviewResult);
const decodeScientSourceJournalIconResult = Schema.decodeUnknownSync(ScientSourceJournalIconResult);
const decodeScientSourceMetadataUpdateRequest = Schema.decodeUnknownSync(
  ScientSourceMetadataUpdateRequest,
);
const decodeScientSourceMetadataRefreshRequest = Schema.decodeUnknownSync(
  ScientSourceMetadataRefreshRequest,
);
const decodeScientSourceRemovalRequest = Schema.decodeUnknownSync(ScientSourceRemovalRequest);
const decodeScientSourceRemovalResult = Schema.decodeUnknownSync(ScientSourceRemovalResult);
const decodeScientSourceLocalPdfUploadResult = Schema.decodeUnknownSync(
  ScientSourcesLocalPdfUploadResult,
);
const decodeZoteroLibraryRequest = Schema.decodeUnknownSync(ZoteroLibraryRequest);
const decodeZoteroScopedImportRequest = Schema.decodeUnknownSync(ZoteroScopedImportRequest);

describe("Scient sources contracts", () => {
  it("keeps overview summaries compact while details retain complete source metadata", () => {
    const detail = {
      formatVersion: 1 as const,
      sourceId: "source_123",
      projectId: "project_123",
      revision: 1,
      type: "article" as const,
      customType: null,
      title: "A source",
      creators: [],
      issuedRaw: "2026",
      issuedYear: 2026,
      identifiers: [],
      abstract: "Complete abstract.",
      containerTitle: "Journal",
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      language: "en",
      url: null,
      tags: ["reviewed"],
      externalReferences: [],
      attachments: [],
      fieldProvenance: [],
      importedAt: "2026-08-13T00:00:00.000Z",
    };
    expect(decodeScientSourceDetailResult(detail).abstract).toBe("Complete abstract.");
    const overview = decodeScientSourcesOverviewResult({
      projectState: "initialized",
      issues: [],
      records: [
        {
          sourceId: detail.sourceId,
          revision: detail.revision,
          type: detail.type,
          title: detail.title,
          creators: detail.creators,
          issuedYear: detail.issuedYear,
          identifiers: detail.identifiers,
          containerTitle: detail.containerTitle,
          url: detail.url,
          externalReferences: detail.externalReferences,
          attachments: detail.attachments,
          importedAt: detail.importedAt,
        },
      ],
      activeOperation: null,
      recordDiagnostics: [],
    });
    expect(overview.records[0]).not.toHaveProperty("abstract");
  });

  it("keeps Zotero collection scopes explicit and recursive by choice", () => {
    expect(
      decodeZoteroLibraryRequest({
        scope: {
          kind: "collection",
          collectionKey: "ABCD2345",
          includeSubcollections: true,
        },
        query: "trial",
        start: 0,
        limit: 50,
      }),
    ).toMatchObject({ scope: { kind: "collection", includeSubcollections: true } });
    expect(
      decodeZoteroScopedImportRequest({
        root: "/project",
        operationId: "operation_1",
        scope: { kind: "library" },
      }),
    ).toMatchObject({ scope: { kind: "library" } });
  });

  it("requires the source revision when refreshing metadata", () => {
    expect(
      decodeScientSourceMetadataRefreshRequest({
        root: "/project",
        sourceId: "source_123",
        expectedRevision: 4,
      }),
    ).toEqual({
      root: "/project",
      sourceId: "source_123",
      expectedRevision: 4,
    });
  });

  it("round-trips a generic local-file preflight result through the public contract", () => {
    const decoded = decodeScientSourceLocalPdfUploadResult({
      item: {
        candidate: {
          sourceKey: "pdf_abcdef",
          type: "article",
          customType: null,
          title: "A local article",
          creators: [],
          issuedRaw: "2026",
          issuedYear: 2026,
          identifiers: [{ scheme: "doi", value: "10.1000/example" }],
          abstract: null,
          containerTitle: "Journal",
          publisher: null,
          volume: null,
          issue: null,
          pages: null,
          language: "en",
          url: "https://doi.org/10.1000/example",
          tags: [],
          externalReferences: [],
          fieldProvenance: [
            { field: "title", origin: "local-pdf", sourceField: "document-info/title" },
          ],
          pdfAvailable: true,
          pdfFileName: "article.pdf",
          pdfAttachmentCount: 1,
        },
        duplicate: { kind: "new", matchingSourceIds: [], reason: "No match." },
        metadataDiagnostics: [],
      },
    });

    expect(decoded.item.candidate).toMatchObject({
      sourceKey: "pdf_abcdef",
      externalReferences: [],
      pdfFileName: "article.pdf",
    });
  });

  it("carries the authoritative attachment path with a signed preview URL", () => {
    expect(
      decodeScientSourceAttachmentPreviewResult({
        relativeUrl: "/api/assets/source-token",
        expiresAt: 1_786_000_000_000,
        absolutePath: "/project/.scient/sources/files/sha256/ab/abcdef.pdf",
      }),
    ).toMatchObject({
      relativeUrl: "/api/assets/source-token",
      absolutePath: "/project/.scient/sources/files/sha256/ab/abcdef.pdf",
    });
  });

  it("keeps journal presentation optional while carrying a signed icon URL when available", () => {
    expect(decodeScientSourceJournalIconResult({ icon: null })).toEqual({ icon: null });
    expect(
      decodeScientSourceJournalIconResult({
        icon: {
          relativeUrl: "/api/assets/journal-icon-token",
          expiresAt: 1_786_000_000_000,
          journalTitle: "PLOS Medicine",
        },
      }),
    ).toMatchObject({ icon: { journalTitle: "PLOS Medicine" } });
  });

  it("round-trips bounded editable metadata without accepting protected source fields", () => {
    const decoded = decodeScientSourceMetadataUpdateRequest({
      root: "/project",
      sourceId: "source_123",
      expectedRevision: 2,
      metadata: {
        type: "article",
        title: "Corrected title",
        creators: [],
        issuedRaw: "2026",
        issuedYear: 2026,
        identifiers: [{ scheme: "doi", value: "10.1000/test" }],
        abstract: null,
        containerTitle: "Journal",
        publisher: null,
        volume: null,
        issue: null,
        pages: null,
        language: "en",
        url: null,
        tags: [],
      },
    });

    expect(decoded).toMatchObject({ sourceId: "source_123", expectedRevision: 2 });
    expect(decoded.metadata).not.toHaveProperty("attachments");
    expect(decoded.metadata).not.toHaveProperty("externalReferences");
  });

  it("requires optimistic concurrency and reports attachment cleanup", () => {
    expect(
      decodeScientSourceRemovalRequest({
        root: "/project",
        sourceId: "source_123",
        expectedRevision: 3,
      }),
    ).toEqual({ root: "/project", sourceId: "source_123", expectedRevision: 3 });
    expect(
      decodeScientSourceRemovalResult({
        outcome: "removed",
        sourceId: "source_123",
        revision: 3,
        removedAttachmentCount: 1,
        retainedAttachmentCount: 0,
      }),
    ).toMatchObject({ outcome: "removed", revision: 3, removedAttachmentCount: 1 });
  });
});
