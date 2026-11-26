import { describe, expect, it } from "@effect/vitest";

import type { MetadataRequest } from "../metadataHttp.ts";
import { searchWatchService } from "./watchSearch.ts";

const window = { from: "2026-11-19", to: "2026-11-26" };
const pace = <A>(run: () => Promise<A>) => run();

function serve(routes: Record<string, string>): {
  readonly request: MetadataRequest;
  readonly urls: URL[];
} {
  const urls: URL[] = [];
  return {
    urls,
    request: async (url) => {
      urls.push(url);
      const route = Object.keys(routes).find((path) => url.pathname.endsWith(path));
      return route ? { status: 200, body: routes[route]!, url } : { status: 503, body: "", url };
    },
  };
}

const EFETCH = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>43078099</PMID>
      <Article>
        <Journal><Title>Current biology</Title><JournalIssue><PubDate><Year>2026</Year></PubDate></JournalIssue></Journal>
        <ArticleDate DateType="Electronic"><Year>2026</Year><Month>11</Month><Day>20</Day></ArticleDate>
        <ArticleTitle>Ventral striatal dopamine increases after <i>hippocampal</i> sharp-wave ripples &amp; reward.</ArticleTitle>
        <Abstract><AbstractText>Ripples drive dopamine release.</AbstractText></Abstract>
        <AuthorList><Author><LastName>Janssen</LastName><Initials>MA</Initials></Author></AuthorList>
        <PublicationTypeList><PublicationType>Journal Article</PublicationType></PublicationTypeList>
      </Article>
    </MedlineCitation>
    <PubmedData><ArticleIdList><ArticleId IdType="doi">10.1016/J.CUB.2026.10.074</ArticleId></ArticleIdList></PubmedData>
  </PubmedArticle>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>43000001</PMID>
      <Article>
        <ArticleTitle>Replay and planning in humans</ArticleTitle>
        <Abstract>
          <AbstractText Label="BACKGROUND">Replay supports planning.</AbstractText>
          <AbstractText Label="RESULTS">It predicts choices.</AbstractText>
        </Abstract>
      </Article>
    </MedlineCitation>
  </PubmedArticle>
</PubmedArticleSet>`;

describe("searchWatchService", () => {
  it("reads PubMed by record-creation date, with plain and labelled abstracts", async () => {
    const { request, urls } = serve({
      "esearch.fcgi": JSON.stringify({
        esearchresult: { count: "2", idlist: ["43078099", "43000001"] },
      }),
      "efetch.fcgi": EFETCH,
    });
    const result = await searchWatchService("pubmed", "replay[tiab]", window, {
      request,
      keys: {},
      pace,
    });
    expect(urls[0]!.searchParams.get("datetype")).toBe("crdt");
    expect(urls[0]!.searchParams.get("mindate")).toBe("2026/11/19");
    expect(result.run).toMatchObject({ status: "complete", found: 2, total: 2 });
    expect(result.found[0]).toMatchObject({
      title: "Ventral striatal dopamine increases after hippocampal sharp-wave ripples & reward.",
      published: "2026-11-20",
      abstract: "Ripples drive dopamine release.",
      ids: { pmid: "43078099", doi: "10.1016/j.cub.2026.10.074" },
      venue: "Current biology",
      authors: ["Janssen MA"],
    });
    expect(result.found[1]!.abstract).toBe(
      "BACKGROUND: Replay supports planning. RESULTS: It predicts choices.",
    );
  });

  it("cleans the spaces OpenAlex leaves around names, which the stored run would refuse", async () => {
    const { request } = serve({
      "/works": JSON.stringify({
        meta: { count: 1 },
        results: [
          {
            id: "https://openalex.org/W1",
            title: " Working memory capacity in macaques ",
            publication_date: "2026-11-20",
            authorships: [{ author: { display_name: " Aditi Singh" } }],
            primary_location: { source: { display_name: "Neuron " } },
          },
        ],
      }),
    });
    const result = await searchWatchService("openalex", "memory", window, {
      request,
      keys: {},
      pace,
    });
    expect(result.found[0]).toMatchObject({
      title: "Working memory capacity in macaques",
      authors: ["Aditi Singh"],
      venue: "Neuron",
      ids: { openalex: "W1" },
    });
  });

  it("reports a service that does not answer as failed, without throwing", async () => {
    const result = await searchWatchService("openalex", "replay", window, {
      request: serve({}).request,
      keys: {},
      pace,
    });
    expect(result.run).toMatchObject({ service: "openalex", status: "failed", found: 0 });
    expect(result.found).toEqual([]);
  });
});
