import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { assessSourceDuplicate } from "./duplicates.ts";
import {
  ScientSourceCandidate,
  scientSourceSummaryFromRecord,
  type ScientSourceRecord,
} from "./model.ts";
import { normalizePersistentIdentifier, sourceMetadataDiagnostics } from "./normalize.ts";
import { sourceCandidate } from "./testing/sourceFixtures.ts";

const decodeScientSourceCandidate = Schema.decodeUnknownSync(ScientSourceCandidate);
const candidate = decodeScientSourceCandidate(
  sourceCandidate({
    sourceKey: "ABC123",
    title: "A careful study",
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
    ],
    issuedRaw: "2026",
    issuedYear: 2026,
    identifiers: [{ scheme: "doi", value: "10.1000/Example" }],
    containerTitle: "Journal",
    language: "en",
    externalReferences: [
      {
        system: "zotero",
        libraryId: "0",
        itemKey: "ABC123",
        itemVersion: 4,
        rawItemType: "journalArticle",
      },
    ],
    pdfAvailable: true,
    pdfFileName: "paper.pdf",
    pdfAttachmentCount: 1,
  }),
);

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
    expect(summary.tags).toEqual(["reviewed"]);
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
    expect(normalizePersistentIdentifier("arXiv", "arXiv:2401.01234v3")).toBe("arxiv:2401.01234");
  });

  // regression: 4e05b272c1 feat(sources): complete reference intake workflows
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

  it("knows an arXiv paper filed by arXiv's DOI, which a registry called an article", () => {
    // Filed by its DOI at arXiv (typed "article" by the DOI registry); the same paper comes
    // again as arXiv's preprint, by its arXiv ID.
    const preprint = {
      ...candidate,
      sourceKey: "local_pdf",
      type: "preprint" as const,
      identifiers: [{ scheme: "arxiv", value: "1706.03762" }],
      externalReferences: [],
    };
    const filed = record({
      identifiers: [{ scheme: "doi", value: "https://doi.org/10.48550/arXiv.1706.03762" }],
      externalReferences: [],
    });
    expect(assessSourceDuplicate({ candidate: preprint, existing: [filed] })).toMatchObject({
      kind: "same-identifier",
      matchingSourceIds: ["source_123"],
    });
    // A type a person chose stands: their article is not taken for the preprint.
    const typedByHand = {
      ...filed,
      fieldProvenance: [{ field: "type", origin: "user" as const, sourceField: null }],
    };
    expect(assessSourceDuplicate({ candidate: preprint, existing: [typedByHand] })).toMatchObject({
      kind: "new",
      matchingSourceIds: ["source_123"],
    });
    // A published version that names the same arXiv ID is still another source.
    const published = record({
      type: "conference-paper",
      identifiers: [
        { scheme: "doi", value: "10.18653/v1/N19-1423" },
        { scheme: "arxiv", value: "1706.03762" },
      ],
      externalReferences: [],
    });
    expect(assessSourceDuplicate({ candidate: preprint, existing: [published] })).toMatchObject({
      kind: "new",
      matchingSourceIds: ["source_123"],
    });
  });

  it("does not take a title that is only the file's name for the work's", () => {
    const sha256 = "a".repeat(64);
    const filed = record({
      externalReferences: [],
      attachments: [
        {
          attachmentId: "pdf_1",
          kind: "pdf",
          fileName: "paper.pdf",
          mediaType: "application/pdf",
          sha256,
          byteLength: 10,
          relativePath: `files/sha256/aa/${sha256}.pdf`,
          importedAt: "2026-08-12T00:00:00.000Z",
        },
      ],
    });
    // The same PDF, which names no title: its file name is no reason to keep the two apart.
    const unnamed = {
      ...candidate,
      sourceKey: "local_pdf",
      type: "other" as const,
      title: "1706.03762",
      identifiers: [],
      externalReferences: [],
      fieldProvenance: [{ field: "title", origin: "local-pdf" as const, sourceField: "file-name" }],
    };
    expect(
      assessSourceDuplicate({ candidate: unnamed, existing: [filed], pdfSha256: sha256 }),
    ).toMatchObject({ kind: "same-pdf", matchingSourceIds: ["source_123"] });
    expect(sourceMetadataDiagnostics(unnamed).map((diagnostic) => diagnostic.field)).toContain(
      "title",
    );
  });

  it.each([
    ["openalex", "https://openalex.org/W2741809807", "W2741809807"],
    ["s2", "corpusid:13756489", "CorpusId:13756489"],
  ])("knows the same %s work without its authors or year", (scheme, given, stored) => {
    const sparse = { creators: [], issuedRaw: null, issuedYear: null, externalReferences: [] };
    expect(
      assessSourceDuplicate({
        candidate: {
          ...candidate,
          ...sparse,
          sourceKey: "DIFFERENT",
          identifiers: [{ scheme, value: given }],
        },
        existing: [record({ ...sparse, identifiers: [{ scheme, value: stored }] })],
      }),
    ).toMatchObject({ kind: "same-identifier", matchingSourceIds: ["source_123"] });
  });

  // regression: 4e05b272c1 feat(sources): complete reference intake workflows
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

  it("checks each entry against the records that share a key with it, not every record", () => {
    let reads = 0;
    const counted = (index: number, doi: string, title = `Study number ${index}`) => {
      const value = record({
        sourceId: `source_${index}`,
        title,
        identifiers: [{ scheme: "doi", value: doi }],
        externalReferences: [],
      });
      const { identifiers } = value;
      return Object.defineProperty(value, "identifiers", {
        get: () => {
          reads += 1;
          return identifiers;
        },
      });
    };
    const existing = Array.from({ length: 2_000 }, (_, index) =>
      index === 10 || index === 1_500
        ? counted(index, "10.1000/shared", "Shared work")
        : counted(index, `10.1000/${index}`),
    );
    const entry = (index: number, doi: string, title = `Study number ${index}`) => ({
      ...candidate,
      sourceKey: `entry-${index}`,
      title,
      identifiers: [{ scheme: "doi", value: doi }],
      externalReferences: [],
    });
    for (let index = 0; index < 100; index += 1) {
      expect(
        assessSourceDuplicate({ candidate: entry(5_000 + index, `10.1000/new-${index}`), existing })
          .kind,
      ).toBe("new");
    }
    expect(assessSourceDuplicate({ candidate: entry(700, "10.1000/700"), existing })).toMatchObject(
      { kind: "same-identifier", matchingSourceIds: ["source_700"] },
    );
    // Two records share the identifier: neither is taken, and both are named in list order.
    expect(
      assessSourceDuplicate({ candidate: entry(1, "10.1000/shared", "Shared work"), existing }),
    ).toMatchObject({ kind: "new", matchingSourceIds: ["source_10", "source_1500"] });
    expect(reads).toBeLessThan(existing.length * 4);
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
