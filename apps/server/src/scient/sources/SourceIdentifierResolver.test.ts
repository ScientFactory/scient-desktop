// @effect-diagnostics globalDate:off -- Fixed Date values make retrieval timestamps deterministic.
// @effect-diagnostics nodeBuiltinImport:off -- The test controls the native unref'ed lookup deadline.
import * as NodeTimersPromises from "node:timers/promises";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { ScientSourceCandidate } from "@scientfactory/scient-sources";

import type { MetadataRequest } from "./metadataHttp.ts";
import {
  applyResolvedSourceMetadata,
  cslIssuedDate,
  resolveSourceIdentifier,
  titlesAgree,
} from "./SourceIdentifierResolver.ts";

vi.mock("node:timers/promises", { spy: true });

const now = () => new Date("2026-11-10T12:00:00.000Z");

function respond(status: number, body: unknown, finalUrl?: string): MetadataRequest {
  return async (url) => ({
    status,
    body: typeof body === "string" ? body : JSON.stringify(body),
    url: new URL(finalUrl ?? url),
  });
}

const doi = [{ scheme: "doi", value: "https://doi.org/10.1000/ABC.123" }];
const pmid = [{ scheme: "pmid", value: "31452104" }];

describe("resolveSourceIdentifier", () => {
  it("maps doi.org CSL-JSON into source metadata", async () => {
    const request = vi.fn<MetadataRequest>(
      respond(200, {
        type: "article-journal",
        title: ["Measured outcomes in a cohort"],
        author: [
          { given: "Ada", family: "Lovelace" },
          { literal: "The Cohort Consortium" },
          { given: "" },
        ],
        issued: { "date-parts": [[2021, 3, 5]] },
        DOI: "10.1000/abc.123",
        ISSN: ["1234-5678"],
        "container-title": "Journal of Measurements",
        volume: 12,
        page: "1-9",
      }),
    );

    const resolution = await resolveSourceIdentifier(doi, { request, now });

    expect(request.mock.calls[0]?.[0].href).toBe("https://doi.org/10.1000/abc.123");
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      Accept: "application/vnd.citationstyles.csl+json",
    });
    expect(resolution).toEqual({
      status: "found",
      identifier: { scheme: "doi", value: "10.1000/abc.123" },
      retrievedAt: "2026-11-10T12:00:00.000Z",
      metadata: {
        type: "article",
        title: "Measured outcomes in a cohort",
        creators: [
          { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
          {
            creatorType: "author",
            givenName: null,
            familyName: null,
            literalName: "The Cohort Consortium",
          },
        ],
        issuedRaw: "2021-03-05",
        issuedYear: 2021,
        identifiers: [
          { scheme: "doi", value: "10.1000/abc.123" },
          { scheme: "issn", value: "1234-5678" },
        ],
        abstract: null,
        abstractSections: [],
        containerTitle: "Journal of Measurements",
        publisher: null,
        volume: "12",
        issue: null,
        pages: "1-9",
        language: null,
        url: "https://doi.org/10.1000/abc.123",
      },
    });
  });

  it.each([
    {
      name: "doi.org reports the DOI unregistered",
      request: respond(404, ""),
      status: "not-found",
    },
    {
      name: "the agency behind doi.org answers 404",
      request: respond(404, "", "https://api.crossref.org/works/10.1000/abc.123"),
      status: "unavailable",
    },
    {
      name: "the registry rate-limits the lookup",
      request: respond(429, ""),
      status: "unavailable",
    },
    { name: "the response is not JSON", request: respond(200, "<html>"), status: "unavailable" },
    {
      name: "the request fails",
      request: (() => Promise.reject(new Error("offline"))) satisfies MetadataRequest,
      status: "unavailable",
    },
  ])("returns $status when $name", async ({ request, status }) => {
    await expect(resolveSourceIdentifier(doi, { request, now })).resolves.toEqual({
      status,
      identifier: { scheme: "doi", value: "10.1000/abc.123" },
    });
  });

  it("treats a malformed DOI as not found without asking the registry", async () => {
    const request = vi.fn<MetadataRequest>();
    await expect(
      resolveSourceIdentifier([{ scheme: "doi", value: "not-a-doi" }], { request }),
    ).resolves.toEqual({ status: "not-found", identifier: { scheme: "doi", value: "not-a-doi" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("gives up as unavailable at the lookup deadline", async () => {
    const deadline = Promise.withResolvers<unknown>();
    using timer = vi.spyOn(NodeTimersPromises, "setTimeout").mockReturnValue(deadline.promise);
    const pending = resolveSourceIdentifier(doi, {
      request: () => new Promise(() => undefined),
      deadlineMs: 25,
    });
    expect(timer).toHaveBeenCalledWith(25, expect.any(Map), { ref: false });
    deadline.resolve(new Map([["10.1000/abc.123", { status: "unavailable" }]]));
    await expect(pending).resolves.toMatchObject({ status: "unavailable" });
  });

  it("prefers the DOI when a source also has a PMID", async () => {
    const request = vi.fn<MetadataRequest>(respond(404, ""));
    await resolveSourceIdentifier([...pmid, ...doi], { request });
    expect(request.mock.calls[0]?.[0].host).toBe("doi.org");
  });

  it("returns null without a DOI, PMID, arXiv ID or ISBN", async () => {
    await expect(
      resolveSourceIdentifier([{ scheme: "issn", value: "1234-5678" }]),
    ).resolves.toBeNull();
  });

  it("maps a PubMed summary into source metadata", async () => {
    const request = vi.fn<MetadataRequest>(
      respond(200, {
        result: {
          uids: ["31452104"],
          "31452104": {
            title: "A trial of measured outcomes.",
            authors: [{ name: "Lovelace A" }, { name: "Trial Collaborative Group" }],
            pubdate: "2019 Aug 26",
            fulljournalname: "The Journal of Trials",
            volume: "4",
            lang: ["eng"],
            articleids: [
              { idtype: "pubmed", value: "31452104" },
              { idtype: "doi", value: "10.1000/trial" },
            ],
          },
        },
      }),
    );

    const resolution = await resolveSourceIdentifier(pmid, { request, now });

    expect(request.mock.calls[0]?.[0].href).toContain("esummary.fcgi?db=pubmed&id=31452104");
    expect(resolution).toMatchObject({
      status: "found",
      identifier: { scheme: "pmid", value: "31452104" },
      metadata: {
        type: "article",
        title: "A trial of measured outcomes.",
        creators: [
          { givenName: "A", familyName: "Lovelace", literalName: null },
          { givenName: null, familyName: null, literalName: "Trial Collaborative Group" },
        ],
        issuedRaw: "2019 Aug 26",
        issuedYear: 2019,
        identifiers: [
          { scheme: "pmid", value: "31452104" },
          { scheme: "doi", value: "10.1000/trial" },
        ],
        containerTitle: "The Journal of Trials",
        language: "eng",
        url: "https://pubmed.ncbi.nlm.nih.gov/31452104/",
      },
    });
  });

  it.each([
    { name: "has no entry for it", body: { result: { uids: [] } } },
    {
      name: "reports an error entry",
      body: { result: { "31452104": { error: "cannot get document summary" } } },
    },
  ])("returns not-found when PubMed $name", async ({ body }) => {
    await expect(resolveSourceIdentifier(pmid, { request: respond(200, body) })).resolves.toEqual({
      status: "not-found",
      identifier: { scheme: "pmid", value: "31452104" },
    });
  });
});

describe("cslIssuedDate", () => {
  it.each([
    { issued: { "date-parts": [[2021, 13, null]] }, expected: { raw: "2021", year: 2021 } },
    { issued: { raw: "Spring 1999" }, expected: { raw: "Spring 1999", year: 1999 } },
  ])("reads $issued", ({ issued, expected }) => {
    expect(cslIssuedDate(issued)).toEqual(expected);
  });
});

describe("titlesAgree", () => {
  it.each([
    { claimed: "", resolved: "Anything at all", agree: true },
    {
      claimed: "Deep <i>learning</i> for café networks",
      resolved: "Deep learning for cafe networks: a review",
      agree: true,
    },
    {
      claimed: "Measured outcomes in a large cohort study",
      resolved: "Measured outcomes in a small cohort study",
      agree: true,
    },
    {
      claimed: "Protein folding in yeast cells",
      resolved: "Protein expression in mammalian neurons",
      agree: false,
    },
    { claimed: "On the", resolved: "Measured outcomes", agree: false },
    { claimed: "Cancer", resolved: "Cancer statistics, 2024", agree: false },
  ])("$claimed vs $resolved -> $agree", ({ claimed, resolved, agree }) => {
    expect(titlesAgree(claimed, resolved)).toBe(agree);
  });
});

describe("applyResolvedSourceMetadata", () => {
  it("keeps the agent's language, tags and abstract where the registry has none", () => {
    const candidate: ScientSourceCandidate = {
      sourceKey: "agent_key",
      type: "other",
      customType: "Guess",
      title: "Agent title",
      creators: [],
      issuedRaw: null,
      issuedYear: null,
      identifiers: [{ scheme: "doi", value: "10.1000/abc" }],
      abstract: "Agent abstract.",
      containerTitle: null,
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      language: "de",
      url: null,
      tags: ["reading"],
      externalReferences: [],
      fieldProvenance: [
        { field: "title", origin: "agent", sourceField: null },
        { field: "abstract", origin: "agent", sourceField: null },
      ],
      pdfAvailable: false,
      pdfFileName: null,
      pdfAttachmentCount: 0,
    };
    const identifier = { scheme: "doi", value: "10.1000/abc" };
    const applied = applyResolvedSourceMetadata(candidate, {
      status: "found",
      identifier,
      retrievedAt: "2026-11-10T12:00:00.000Z",
      metadata: {
        type: "article",
        title: "Registry title",
        creators: [],
        issuedRaw: null,
        issuedYear: null,
        identifiers: [identifier],
        abstract: null,
        abstractSections: [],
        containerTitle: null,
        publisher: null,
        volume: null,
        issue: null,
        pages: null,
        language: "en",
        url: "https://doi.org/10.1000/abc",
      },
    });

    expect(applied).toMatchObject({
      type: "article",
      customType: null,
      title: "Registry title",
      abstract: "Agent abstract.",
      language: "de",
      tags: ["reading"],
      url: "https://doi.org/10.1000/abc",
    });
    expect(applied.fieldProvenance).toEqual([
      { field: "abstract", origin: "agent", sourceField: null },
      {
        field: "type",
        origin: "doi",
        sourceField: "type",
        sourceIdentifier: identifier,
        retrievedAt: "2026-11-10T12:00:00.000Z",
      },
      {
        field: "title",
        origin: "doi",
        sourceField: "title",
        sourceIdentifier: identifier,
        retrievedAt: "2026-11-10T12:00:00.000Z",
      },
      {
        field: "url",
        origin: "doi",
        sourceField: "URL",
        sourceIdentifier: identifier,
        retrievedAt: "2026-11-10T12:00:00.000Z",
      },
    ]);
  });
});
