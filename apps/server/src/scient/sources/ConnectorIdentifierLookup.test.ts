// @effect-diagnostics globalDate:off -- A fixed Date makes retrieval timestamps deterministic.
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import { describe, expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";

import type { MetadataRequest } from "./metadataHttp.ts";
import {
  applyResolvedSourceMetadata,
  resolveSourceIdentifier,
  type SourceIdentifierResolverOptions,
} from "./SourceIdentifierResolver.ts";

const now = () => new Date("2026-11-10T12:00:00.000Z");
const pace: NonNullable<SourceIdentifierResolverOptions["pace"]> = (run) => run();

interface Asked {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
}

/** Recorded registry answers by host and path; anything else is a 404. */
function registries(answers: Record<string, unknown>) {
  const asked: Array<Asked> = [];
  const request: MetadataRequest = async (url, headers) => {
    asked.push({ url, headers });
    const answer = answers[`${url.host}${url.pathname}`];
    return answer === undefined
      ? { status: 404, body: "", url }
      : { status: 200, body: JSON.stringify(answer), url };
  };
  return { asked, request };
}

const openAlexWork = {
  id: "https://openalex.org/W2741809807",
  doi: "https://doi.org/10.1038/s41586-020-2649-2",
  title: "Array programming with NumPy (as OpenAlex spells it)",
  publication_year: 2020,
  type: "article",
  authorships: [{ author: { display_name: "Charles R. Harris" } }],
};
const numpyCsl = {
  type: "article-journal",
  title: "Array programming with NumPy",
  author: [{ given: "Charles R.", family: "Harris" }],
  issued: { "date-parts": [[2020, 9, 16]] },
  DOI: "10.1038/s41586-020-2649-2",
  "container-title": "Nature",
};

const emptyCandidate: ScientSourceCandidate = {
  sourceKey: "connector",
  type: "other",
  customType: null,
  title: null,
  creators: [],
  issuedRaw: null,
  issuedYear: null,
  identifiers: [{ scheme: "openalex", value: "W2741809807" }],
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
  pdfAvailable: false,
  pdfFileName: null,
  pdfAttachmentCount: 0,
};

describe("connector identifiers in the resolver", () => {
  it("follows an OpenAlex work to its DOI's registry record, with the user's key", async () => {
    const { asked, request } = registries({
      "api.openalex.org/works/W2741809807": openAlexWork,
      "doi.org/10.1038/s41586-020-2649-2": numpyCsl,
    });
    const resolution = await resolveSourceIdentifier(
      [{ scheme: "openalex", value: "https://openalex.org/w2741809807" }],
      { request, now, pace, keys: { openAlex: Redacted.make("oa-key") } },
    );

    expect(asked[0]?.url.searchParams.get("api_key")).toBe("oa-key");
    expect(asked[1]?.url.href).toBe("https://doi.org/10.1038/s41586-020-2649-2");
    expect(resolution).toMatchObject({
      status: "found",
      origin: "doi",
      identifier: { scheme: "openalex", value: "W2741809807" },
      metadata: {
        title: "Array programming with NumPy",
        containerTitle: "Nature",
        identifiers: [
          { scheme: "doi", value: "10.1038/s41586-020-2649-2" },
          { scheme: "openalex", value: "W2741809807" },
        ],
      },
    });
    if (resolution?.status !== "found") throw new Error("Expected a found work.");
    const candidate = applyResolvedSourceMetadata(emptyCandidate, resolution);
    expect(candidate.fieldProvenance).toContainEqual(
      expect.objectContaining({ field: "title", origin: "doi", sourceField: "title" }),
    );
  });

  it("says an OpenAlex work that does not exist is not found", async () => {
    const { request } = registries({});
    await expect(
      resolveSourceIdentifier([{ scheme: "openalex", value: "W1" + "0".repeat(9) }], {
        request,
        pace,
      }),
    ).resolves.toEqual({
      status: "not-found",
      identifier: { scheme: "openalex", value: "W1000000000" },
    });
  });

  it("keeps a Semantic Scholar record without a registry ID as the catalogue gives it", async () => {
    const paperId = "649def34f8be52c8b66281af98ae884c09aef38b";
    const { asked, request } = registries({
      [`api.semanticscholar.org/graph/v1/paper/${paperId}`]: {
        title: "Attention is All you Need",
        year: 2017,
        venue: "Neural Information Processing Systems",
        authors: [{ name: "Ashish Vaswani" }],
        externalIds: { CorpusId: 13756489 },
      },
    });
    const resolution = await resolveSourceIdentifier([{ scheme: "s2", value: paperId }], {
      request,
      now,
      pace,
      keys: { semanticScholar: Redacted.make("s2-key") },
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.headers["x-api-key"]).toBe("s2-key");
    expect(resolution).toMatchObject({
      status: "found",
      origin: "semantic-scholar",
      metadata: {
        title: "Attention is All you Need",
        issuedYear: 2017,
        creators: [{ givenName: "Ashish", familyName: "Vaswani" }],
        containerTitle: "Neural Information Processing Systems",
        identifiers: [{ scheme: "s2", value: paperId }],
      },
    });
  });

  it("sends the user's NCBI key with a PubMed lookup", async () => {
    const { asked, request } = registries({
      "eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi": {
        result: { "31452104": { title: "A trial." } },
      },
    });
    await resolveSourceIdentifier([{ scheme: "pmid", value: "31452104" }], {
      request,
      keys: { ncbi: Redacted.make("ncbi-key") },
    });
    expect(asked[0]?.url.searchParams.get("api_key")).toBe("ncbi-key");
  });
});
