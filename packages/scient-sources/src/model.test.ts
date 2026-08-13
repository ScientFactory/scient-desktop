import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { assessSourceDuplicate } from "./duplicates.ts";
import {
  ScientSourceCandidate,
  scientSourceSummaryFromRecord,
  type ScientSourceRecord,
} from "./model.ts";
import { normalizePersistentIdentifier, sourceMetadataDiagnostics } from "./normalize.ts";

const decodeScientSourceCandidate = Schema.decodeUnknownSync(ScientSourceCandidate);
const candidate = decodeScientSourceCandidate({
  sourceKey: "ABC123",
  type: "article",
  customType: null,
  title: "A careful study",
  creators: [
    { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
  ],
  issuedRaw: "2026",
  issuedYear: 2026,
  identifiers: [{ scheme: "doi", value: "10.1000/Example" }],
  abstract: null,
  containerTitle: "Journal",
  publisher: null,
  volume: null,
  issue: null,
  pages: null,
  language: "en",
  url: null,
  tags: [],
  externalReferences: [
    {
      system: "zotero",
      libraryId: "0",
      itemKey: "ABC123",
      itemVersion: 4,
      rawItemType: "journalArticle",
    },
  ],
  fieldProvenance: [],
  pdfAvailable: true,
  pdfFileName: "paper.pdf",
  pdfAttachmentCount: 1,
});

function record(overrides: Partial<ScientSourceRecord> = {}): ScientSourceRecord {
  return {
    formatVersion: 1,
    sourceId: "source_123",
    projectId: "project_123",
    revision: 1,
    type: candidate.type,
    title: candidate.title,
    creators: candidate.creators,
    issuedRaw: candidate.issuedRaw,
    issuedYear: candidate.issuedYear,
    identifiers: candidate.identifiers,
    abstract: candidate.abstract,
    containerTitle: candidate.containerTitle,
    publisher: candidate.publisher,
    volume: candidate.volume,
    issue: candidate.issue,
    pages: candidate.pages,
    language: candidate.language,
    url: candidate.url,
    tags: candidate.tags,
    externalReferences: candidate.externalReferences,
    attachments: [],
    fieldProvenance: [],
    importedAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("Scient source model", () => {
  it("keeps large detail-only metadata out of ledger summaries", () => {
    const detail = record({
      abstract: "A very large abstract. ".repeat(1_000),
      tags: ["reviewed"],
      fieldProvenance: [{ field: "abstract", origin: "derived", sourceField: null }],
    });
    const summary = scientSourceSummaryFromRecord(detail);

    expect(summary).toMatchObject({ sourceId: "source_123", title: "A careful study" });
    expect(summary).not.toHaveProperty("abstract");
    expect(summary).not.toHaveProperty("tags");
    expect(summary).not.toHaveProperty("fieldProvenance");
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(detail).length / 10);
  });

  it("decodes structured abstract retrieval provenance across the public contract", () => {
    const enriched = decodeScientSourceCandidate({
      ...candidate,
      abstract: "Background\n\nReliable evidence.",
      abstractSections: [{ title: "Background", paragraphs: ["Reliable evidence."] }],
      fieldProvenance: [
        {
          field: "abstract",
          origin: "pubmed",
          sourceField: "efetch/AbstractText",
          sourceIdentifier: { scheme: "pmid", value: "12345678" },
          retrievedAt: "2026-08-13T10:00:00.000Z",
        },
      ],
    });

    expect(enriched.fieldProvenance[0]).toMatchObject({
      origin: "pubmed",
      sourceIdentifier: { scheme: "pmid", value: "12345678" },
      retrievedAt: "2026-08-13T10:00:00.000Z",
    });
  });

  it("normalizes DOI spellings before duplicate comparison", () => {
    expect(normalizePersistentIdentifier("DOI", "https://doi.org/10.1000/Example")).toBe(
      "doi:10.1000/example",
    );
  });

  it("normalizes PMCID and arXiv spellings before duplicate comparison", () => {
    expect(normalizePersistentIdentifier("PMCID", "PMCID: PMC1234567")).toBe("pmcid:pmc1234567");
    expect(normalizePersistentIdentifier("arXiv", "https://arxiv.org/pdf/2401.01234.pdf")).toBe(
      "arxiv:2401.01234",
    );
  });

  it.each(["doi", "pmid", "pmcid", "arxiv"])(
    "treats the work-level %s identifier as authoritative identity",
    (scheme) => {
      const identifiers = [{ scheme, value: `${scheme}-work-123` }];
      expect(
        assessSourceDuplicate({
          candidate: {
            ...candidate,
            sourceKey: `candidate-${scheme}`,
            identifiers,
            externalReferences: [],
          },
          existing: [record({ identifiers, externalReferences: [] })],
        }),
      ).toMatchObject({ kind: "same-identifier", matchingSourceIds: ["source_123"] });
    },
  );

  it.each(["issn", "isbn", "journal-id"])(
    "does not treat the container-level or unknown %s identifier as work identity",
    (scheme) => {
      const identifiers = [{ scheme, value: `${scheme}-shared-123` }];
      expect(
        assessSourceDuplicate({
          candidate: {
            ...candidate,
            sourceKey: `candidate-${scheme}`,
            title: "A different article",
            identifiers,
            externalReferences: [],
          },
          existing: [record({ identifiers, externalReferences: [] })],
        }),
      ).toMatchObject({ kind: "new", matchingSourceIds: [] });
    },
  );

  it("prefers exact Zotero origin over weaker duplicate signals", () => {
    expect(assessSourceDuplicate({ candidate, existing: [record()] })).toMatchObject({
      kind: "same-origin",
      matchingSourceIds: ["source_123"],
    });
  });

  it("does not silently turn incomplete metadata into authoritative-looking values", () => {
    const incomplete = {
      ...candidate,
      title: null,
      creators: [],
      issuedYear: null,
      identifiers: [],
    };
    expect(sourceMetadataDiagnostics(incomplete)).toEqual([
      { field: "title", severity: "warning", message: "Title wasn’t found." },
      { field: "creators", severity: "warning", message: "Creator wasn’t found." },
      { field: "issuedYear", severity: "info", message: "Publication year wasn’t found." },
      { field: "identifiers", severity: "info", message: "Persistent identifier wasn’t found." },
    ]);
  });

  it("does not call sparse metadata a possible duplicate", () => {
    const sparseCandidate = {
      ...candidate,
      title: null,
      creators: [],
      identifiers: [],
      sourceKey: "DIFFERENT",
    };
    const sparseRecord = record({
      title: null,
      creators: [],
      identifiers: [],
      externalReferences: [{ ...candidate.externalReferences[0]!, itemKey: "DIFFERENT" }],
    });

    expect(assessSourceDuplicate({ candidate: sparseCandidate, existing: [sparseRecord] })).toEqual(
      {
        kind: "new",
        matchingSourceIds: [],
        reason: "No existing source match was found.",
      },
    );
  });

  it("requires title, lead creator, and year for a possible metadata match", () => {
    const withoutYear = {
      ...candidate,
      sourceKey: "DIFFERENT",
      issuedRaw: null,
      issuedYear: null,
      identifiers: [],
    };
    const existing = record({
      issuedRaw: null,
      issuedYear: null,
      identifiers: [],
      externalReferences: [{ ...candidate.externalReferences[0]!, itemKey: "DIFFERENT" }],
    });

    expect(assessSourceDuplicate({ candidate: withoutYear, existing: [existing] }).kind).toBe(
      "new",
    );
  });
});
