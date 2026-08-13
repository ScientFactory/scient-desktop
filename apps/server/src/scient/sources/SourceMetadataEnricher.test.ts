// @effect-diagnostics globalDate:off -- Fixed Date values make provenance assertions deterministic.
import { describe, expect, it, vi } from "@effect/vitest";
import type { ScientSourceCandidate, ScientSourceIdentifier } from "@scientfactory/scient-sources";

import {
  enrichScientSourceCandidate,
  sourceMetadataEnricherInternals,
  type AbstractResolvers,
} from "./SourceMetadataEnricher.ts";

function candidate(
  input: {
    readonly identifiers?: ReadonlyArray<ScientSourceIdentifier>;
    readonly abstract?: string | null;
  } = {},
): ScientSourceCandidate {
  return {
    sourceKey: "source_example",
    type: "article",
    customType: null,
    title: "An article",
    creators: [],
    issuedRaw: null,
    issuedYear: null,
    identifiers: [...(input.identifiers ?? [])],
    abstract: input.abstract ?? null,
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
    pdfAvailable: false,
    pdfFileName: null,
    pdfAttachmentCount: 0,
  };
}

function resolverSet(overrides: Partial<AbstractResolvers> = {}): AbstractResolvers {
  return {
    pubmed: async () => null,
    crossref: async () => null,
    europePmc: async () => null,
    ...overrides,
  };
}

describe("source metadata abstract enrichment", () => {
  it("preserves explicit PubMed abstract sections", () => {
    const parsed = sourceMetadataEnricherInternals.parsePubmedAbstract(`
      <PubmedArticleSet><PubmedArticle><MedlineCitation><Article><Abstract>
        <AbstractText Label="BACKGROUND">First <i>paragraph</i>.</AbstractText>
        <AbstractText NlmCategory="METHODS">Second paragraph.</AbstractText>
      </Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>
    `);

    expect(parsed).toEqual({
      text: "BACKGROUND\n\nFirst paragraph.\n\nMETHODS\n\nSecond paragraph.",
      sections: [
        { title: "BACKGROUND", paragraphs: ["First paragraph."] },
        { title: "METHODS", paragraphs: ["Second paragraph."] },
      ],
    });
  });

  it("never replaces an abstract already supplied by an adapter or researcher", async () => {
    const pubmed = vi.fn(async () => null);
    const input = candidate({
      identifiers: [{ scheme: "pmid", value: "12345678" }],
      abstract: "Existing abstract.",
    });

    await expect(
      enrichScientSourceCandidate(input, { resolvers: resolverSet({ pubmed }) }),
    ).resolves.toBe(input);
    expect(pubmed).not.toHaveBeenCalled();
  });

  it("prefers PubMed for a PMID and records exact retrieval provenance", async () => {
    const input = candidate({
      identifiers: [
        { scheme: "pmid", value: "12345678" },
        { scheme: "doi", value: "10.1000/example" },
      ],
    });
    const result = await enrichScientSourceCandidate(input, {
      now: () => new Date("2026-08-13T10:00:00.000Z"),
      resolvers: resolverSet({
        pubmed: async (pmid) => ({
          abstract: "PubMed abstract.",
          sections: [{ title: null, paragraphs: ["PubMed abstract."] }],
          origin: "pubmed",
          sourceField: "efetch/AbstractText",
          sourceIdentifier: { scheme: "pmid", value: pmid },
        }),
        crossref: async (doi) => ({
          abstract: "Crossref abstract.",
          sections: [{ title: null, paragraphs: ["Crossref abstract."] }],
          origin: "crossref",
          sourceField: "works/{doi}/abstract",
          sourceIdentifier: { scheme: "doi", value: doi },
        }),
      }),
    });

    expect(result.abstract).toBe("PubMed abstract.");
    expect(result.fieldProvenance).toContainEqual({
      field: "abstract",
      origin: "pubmed",
      sourceField: "efetch/AbstractText",
      sourceIdentifier: { scheme: "pmid", value: "12345678" },
      retrievedAt: "2026-08-13T10:00:00.000Z",
    });
  });

  it("does not wait for lower-priority services after an authoritative match", async () => {
    const crossref = vi.fn(async () => null);
    const europePmc = vi.fn(async () => null);
    const enriched = await enrichScientSourceCandidate(
      candidate({
        identifiers: [
          { scheme: "pmid", value: "12345678" },
          { scheme: "doi", value: "10.1000/example" },
        ],
      }),
      {
        resolvers: resolverSet({
          pubmed: async (pmid) => ({
            abstract: "Authoritative abstract.",
            sections: [{ title: null, paragraphs: ["Authoritative abstract."] }],
            origin: "pubmed",
            sourceField: "efetch/AbstractText",
            sourceIdentifier: { scheme: "pmid", value: pmid },
          }),
          crossref,
          europePmc,
        }),
      },
    );

    expect(enriched.abstract).toBe("Authoritative abstract.");
    expect(crossref).not.toHaveBeenCalled();
    expect(europePmc).not.toHaveBeenCalled();
  });

  it("bounds optional enrichment when a metadata service never settles", async () => {
    const input = candidate({ identifiers: [{ scheme: "pmid", value: "12345678" }] });
    const startedAt = performance.now();
    const enriched = await enrichScientSourceCandidate(input, {
      deadlineMs: 25,
      resolvers: resolverSet({
        pubmed: () => new Promise(() => undefined),
        europePmc: async () => {
          throw new Error("The shared deadline should expire first.");
        },
      }),
    });

    expect(enriched).toBe(input);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it("falls back from an unavailable primary service without failing import", async () => {
    const input = candidate({
      identifiers: [{ scheme: "doi", value: "10.1000/example" }],
    });
    const enriched = await enrichScientSourceCandidate(input, {
      resolvers: resolverSet({
        crossref: async () => {
          throw new Error("offline");
        },
        europePmc: async (identifier) => ({
          abstract: "Europe PMC abstract.",
          sections: [{ title: null, paragraphs: ["Europe PMC abstract."] }],
          origin: "europe-pmc",
          sourceField: "core/abstractText",
          sourceIdentifier: identifier,
        }),
      }),
    });
    expect(enriched.abstract).toBe("Europe PMC abstract.");

    const unchanged = await enrichScientSourceCandidate(input, {
      resolvers: resolverSet({
        crossref: async () => {
          throw new Error("offline");
        },
        europePmc: async () => {
          throw new Error("offline");
        },
      }),
    });
    expect(unchanged).toBe(input);
  });

  it("rejects Europe PMC results whose identifier does not exactly match", () => {
    expect(
      sourceMetadataEnricherInternals.evidenceFromEuropePmc(
        { doi: "10.1000/different", abstractText: "Wrong article." },
        { scheme: "doi", value: "10.1000/example" },
      ),
    ).toBeNull();
  });
});
