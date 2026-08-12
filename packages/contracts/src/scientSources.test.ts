import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ScientSourcesLocalPdfUploadResult,
  ScientSourceAttachmentPreviewResult,
  ScientSourceMetadataUpdateRequest,
  ScientSourceRemovalRequest,
  ScientSourceRemovalResult,
} from "./scientSources.ts";

const decodeScientSourceAttachmentPreviewResult = Schema.decodeUnknownSync(
  ScientSourceAttachmentPreviewResult,
);
const decodeScientSourceMetadataUpdateRequest = Schema.decodeUnknownSync(
  ScientSourceMetadataUpdateRequest,
);
const decodeScientSourceRemovalRequest = Schema.decodeUnknownSync(ScientSourceRemovalRequest);
const decodeScientSourceRemovalResult = Schema.decodeUnknownSync(ScientSourceRemovalResult);
const decodeScientSourceLocalPdfUploadResult = Schema.decodeUnknownSync(
  ScientSourcesLocalPdfUploadResult,
);

describe("Scient sources contracts", () => {
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
