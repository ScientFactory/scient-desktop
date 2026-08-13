import { describe, expect, it } from "@effect/vitest";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";

import { localPdfSourceInternals } from "./LocalPdfSourceAdapter.ts";

describe("local PDF source adapter", () => {
  it("uses only one unambiguous DOI or explicitly labelled PMID", () => {
    expect(localPdfSourceInternals.uniqueDoi("doi: 10.1000/Example.")).toBe("10.1000/example");
    expect(localPdfSourceInternals.uniqueDoi("10.1371/journal. 10.1371/journal.pone.0203316")).toBe(
      "10.1371/journal.pone.0203316",
    );
    expect(localPdfSourceInternals.uniqueDoi("10.1000/first and 10.1000/second")).toBeNull();
    expect(localPdfSourceInternals.uniquePmid("PMID: 12345678")).toBe("12345678");
    expect(localPdfSourceInternals.uniquePmid("An unrelated number 12345678")).toBeNull();
  });

  it("accepts PDF creator arrays without losing later metadata extraction", () => {
    expect(
      localPdfSourceInternals.embeddedCreators([
        "Kevin Chen",
        "Mia Djulbegovic",
        "Ritu Agarwal",
        "Sarwat I. Chaudhry",
      ]),
    ).toEqual([
      expect.objectContaining({ literalName: "Kevin Chen" }),
      expect.objectContaining({ literalName: "Mia Djulbegovic" }),
      expect.objectContaining({ literalName: "Ritu Agarwal" }),
      expect.objectContaining({ literalName: "Sarwat I. Chaudhry" }),
    ]);
    expect(
      localPdfSourceInternals.embeddedCreators([
        "Claire Morley, Maria Unwin, Gregory M. Peterson, Jim Stankovich, Leigh Kinsman",
      ]),
    ).toHaveLength(5);
  });

  it("merges exact DOI metadata while preserving local provenance and the PDF identity", () => {
    const fallback: ScientSourceCandidate = {
      sourceKey: "local_abc",
      type: "other",
      customType: null,
      title: "Uploaded file",
      creators: [],
      issuedRaw: null,
      issuedYear: null,
      identifiers: [{ scheme: "doi", value: "10.1000/example" }],
      abstract: null,
      containerTitle: null,
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      language: null,
      url: "https://doi.org/10.1000/example",
      tags: [],
      externalReferences: [],
      fieldProvenance: [{ field: "identifiers", origin: "local-pdf", sourceField: "first-pages" }],
      pdfAvailable: true,
      pdfFileName: "paper.pdf",
      pdfAttachmentCount: 1,
    };

    const candidate = localPdfSourceInternals.candidateFromCsl({
      sourceKey: fallback.sourceKey,
      csl: {
        type: "article-journal",
        title: "Resolved article",
        author: [{ given: "Ada", family: "Lovelace" }],
        issued: { "date-parts": [[2026, 8, 12]] },
        DOI: "10.1000/example",
        ISSN: ["1234-5678"],
        "container-title": "Journal of Reliable Sources",
      },
      fallback,
    });

    expect(candidate).toMatchObject({
      sourceKey: fallback.sourceKey,
      type: "article",
      title: "Resolved article",
      issuedYear: 2026,
      pdfFileName: "paper.pdf",
      externalReferences: [],
      containerTitle: "Journal of Reliable Sources",
    });
    expect(candidate.identifiers).toEqual(
      expect.arrayContaining([
        { scheme: "doi", value: "10.1000/example" },
        { scheme: "issn", value: "1234-5678" },
      ]),
    );
    expect(candidate.fieldProvenance).toEqual(
      expect.arrayContaining([
        { field: "identifiers", origin: "local-pdf", sourceField: "first-pages" },
        { field: "title", origin: "doi", sourceField: "title" },
      ]),
    );
  });

  it("recognizes the journal-article type returned by DOI content negotiation", () => {
    const fallback: ScientSourceCandidate = {
      sourceKey: "local_journal_article",
      type: "other",
      customType: null,
      title: "Uploaded file",
      creators: [],
      issuedRaw: null,
      issuedYear: null,
      identifiers: [],
      abstract: null,
      containerTitle: null,
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      language: null,
      url: null,
      tags: [],
      externalReferences: [],
      fieldProvenance: [],
      pdfAvailable: true,
      pdfFileName: "paper.pdf",
      pdfAttachmentCount: 1,
    };

    const candidate = localPdfSourceInternals.candidateFromCsl({
      sourceKey: fallback.sourceKey,
      csl: { type: "journal-article", title: "Resolved article" },
      fallback,
    });

    expect(candidate.type).toBe("article");
    expect(candidate.customType).toBeNull();
  });
});
