// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
// @effect-diagnostics globalDate:off -- Lookups take a fixed ISO clock, as stored entries do.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import { readScientSourceCategories } from "@scientfactory/scient-sources/categories-store";
import { SCIENT_SOURCE_RECORDS_DIRECTORY } from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";

import type { MetadataRequest } from "./metadataHttp.ts";
import { categorizeSources } from "./SourceCategories.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
});

async function project(
  sources: ReadonlyArray<{
    readonly sourceId: string;
    readonly identifiers: ReadonlyArray<{ scheme: string; value: string }>;
  }>,
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-categories-"));
  roots.push(root);
  await initializeScientProject({ root });
  const { projectId } = await readScientProjectIdentity(root);
  const directory = NodePath.join(root, SCIENT_SOURCE_RECORDS_DIRECTORY);
  await NodeFSP.mkdir(directory, { recursive: true });
  for (const source of sources) {
    await NodeFSP.writeFile(
      NodePath.join(directory, `${source.sourceId}.json`),
      JSON.stringify({
        formatVersion: 1,
        sourceId: source.sourceId,
        projectId,
        revision: 1,
        type: "article",
        title: source.sourceId,
        creators: [],
        issuedRaw: null,
        issuedYear: 2024,
        identifiers: source.identifiers,
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
        attachments: [],
        fieldProvenance: [],
        importedAt: "2026-11-10T12:00:00.000Z",
      }),
    );
  }
  return root;
}

const pubmedArticle = (input: {
  pmid: string;
  doi: string;
  types: ReadonlyArray<string>;
  headings?: ReadonlyArray<string>;
  cites?: string;
}) => `<PubmedArticle><MedlineCitation><PMID Version="1">${input.pmid}</PMID><Article>
<PublicationTypeList>${input.types.map((type) => `<PublicationType UI="D1">${type}</PublicationType>`).join("")}</PublicationTypeList>
</Article><MeshHeadingList>${(input.headings ?? []).map((heading) => `<MeshHeading><DescriptorName UI="D2" MajorTopicYN="N">${heading}</DescriptorName></MeshHeading>`).join("")}<MeshHeading><DescriptorName UI="D3">Humans</DescriptorName></MeshHeading></MeshHeadingList>
</MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">${input.pmid}</ArticleId><ArticleId IdType="doi">${input.doi}</ArticleId></ArticleIdList>
${input.cites ? `<ReferenceList><Reference><ArticleIdList><ArticleId IdType="doi">${input.cites}</ArticleId></ArticleIdList></Reference></ReferenceList>` : ""}
</PubmedData></PubmedArticle>`;

const arxivFeed = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
<entry><id>http://arxiv.org/abs/2101.00001v2</id><title>A preprint</title>
<arxiv:primary_category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
<category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/><category term="stat.ML" scheme="http://arxiv.org/schemas/atom"/>
</entry></feed>`;

describe("Source categories", () => {
  it("finds PMIDs for DOIs, maps study designs, adds topics, and resumes after an outage", async () => {
    const root = await project([
      // Its PMID is found from its DOI.
      { sourceId: "trial", identifiers: [{ scheme: "doi", value: "10.1000/TRIAL" }] },
      // A review indexed under a cohort heading stays a review.
      { sourceId: "review", identifiers: [{ scheme: "pmid", value: "222" }] },
      { sourceId: "cohort", identifiers: [{ scheme: "pmid", value: "333" }] },
      { sourceId: "preprint", identifiers: [{ scheme: "arxiv", value: "arXiv:2101.00001" }] },
      { sourceId: "none", identifiers: [] },
    ]);
    const requests: URL[] = [];
    let openAlexUp = false;
    const request: MetadataRequest = async (url) => {
      requests.push(url);
      const ok = (body: string) => ({ status: 200, body, url });
      if (url.pathname.endsWith("/esearch.fcgi")) {
        expect(url.searchParams.get("term")).toBe('"10.1000/trial"[aid]');
        return ok(JSON.stringify({ esearchresult: { idlist: ["111"] } }));
      }
      if (url.pathname.endsWith("/efetch.fcgi")) {
        return ok(
          `<PubmedArticleSet>${[
            pubmedArticle({
              pmid: "111",
              doi: "10.1000/trial",
              types: ["Journal Article", "Randomized Controlled Trial"],
            }),
            pubmedArticle({
              pmid: "222",
              doi: "10.1000/review",
              types: ["Journal Article", "Review"],
              headings: ["Cohort Studies"],
              cites: "10.1000/trial",
            }),
            pubmedArticle({
              pmid: "333",
              doi: "10.1000/cohort",
              types: ["Journal Article"],
              headings: ["Prospective Studies"],
            }),
          ].join("")}</PubmedArticleSet>`,
        );
      }
      if (url.hostname === "api.openalex.org") {
        if (!openAlexUp) return { status: 503, body: "", url };
        return ok(
          JSON.stringify({
            results: [
              {
                id: "https://openalex.org/W1",
                doi: "https://doi.org/10.1000/trial",
                topics: [
                  { id: "https://openalex.org/T2", display_name: "Minor", score: 0.2 },
                  { id: "https://openalex.org/T1", display_name: "Sepsis care", score: 0.9 },
                ],
              },
            ],
          }),
        );
      }
      if (url.hostname === "export.arxiv.org") return ok(arxivFeed);
      throw new Error(`Unexpected request ${url.href}`);
    };
    const pace = <A>(run: () => Promise<A>) => run();
    const now = () => new Date("2026-11-11T00:00:00.000Z");

    expect(await categorizeSources(root, { request, pace, now })).toEqual({ categorized: 4 });
    const first = await readScientSourceCategories(root);
    expect(
      Object.fromEntries(
        Object.entries(first).map(([sourceId, entry]) => [
          sourceId,
          [entry.pmid, entry.studyDesign, entry.topics?.map((topic) => topic.name)],
        ]),
      ),
    ).toEqual({
      trial: ["111", "randomized-trial", undefined],
      review: ["222", "review", undefined],
      cohort: ["333", "cohort", undefined],
      preprint: [undefined, undefined, ["cs.LG", "stat.ML"]],
    });
    expect(first.trial?.retryAfter).toBeDefined();
    expect(first.preprint?.retryAfter).toBeUndefined();

    // Nothing is due again until the outage's retry time passes.
    requests.length = 0;
    expect(await categorizeSources(root, { request, pace, now })).toEqual({ categorized: 0 });
    expect(requests).toEqual([]);

    openAlexUp = true;
    const later = () => new Date("2026-11-12T00:00:00.000Z");
    await categorizeSources(root, { request, pace, now: later });
    const second = await readScientSourceCategories(root);
    expect(second.trial?.topics?.map((topic) => [topic.name, topic.score])).toEqual([
      ["Sepsis care", 0.9],
      ["Minor", 0.2],
    ]);
    expect(second.trial?.retryAfter).toBeUndefined();
    expect(second.preprint).toEqual(first.preprint);
  });
});
