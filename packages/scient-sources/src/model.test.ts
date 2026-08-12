import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { assessSourceDuplicate } from "./duplicates.ts";
import { ScientSourceCandidate, type ScientSourceRecord } from "./model.ts";
import { normalizePersistentIdentifier, sourceMetadataDiagnostics } from "./normalize.ts";

const candidate = Schema.decodeUnknownSync(ScientSourceCandidate)({
  type: "article",
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
  externalReference: {
    system: "zotero",
    libraryId: "0",
    itemKey: "ABC123",
    itemVersion: 4,
    rawItemType: "journalArticle",
  },
  fieldProvenance: [],
  pdfAvailable: true,
  pdfFileName: "paper.pdf",
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
    externalReferences: [candidate.externalReference],
    attachments: [],
    fieldProvenance: [],
    importedAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("Scient source model", () => {
  it("normalizes DOI spellings before duplicate comparison", () => {
    expect(normalizePersistentIdentifier("DOI", "https://doi.org/10.1000/Example")).toBe(
      "doi:10.1000/example",
    );
  });

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
    expect(sourceMetadataDiagnostics(incomplete).map((item) => item.field)).toEqual([
      "title",
      "creators",
      "issuedYear",
      "identifiers",
    ]);
  });

  it("does not call sparse metadata a possible duplicate", () => {
    const sparseCandidate = {
      ...candidate,
      title: null,
      creators: [],
      identifiers: [],
    };
    const sparseRecord = record({
      title: null,
      creators: [],
      identifiers: [],
      externalReferences: [{ ...candidate.externalReference, itemKey: "DIFFERENT" }],
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
    const withoutYear = { ...candidate, issuedRaw: null, issuedYear: null, identifiers: [] };
    const existing = record({
      issuedRaw: null,
      issuedYear: null,
      identifiers: [],
      externalReferences: [{ ...candidate.externalReference, itemKey: "DIFFERENT" }],
    });

    expect(assessSourceDuplicate({ candidate: withoutYear, existing: [existing] }).kind).toBe(
      "new",
    );
  });
});
