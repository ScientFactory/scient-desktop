import { describe, expect, it } from "@effect/vitest";

import {
  noteWithPassage,
  webPageCandidate,
  webPageIdentifiers,
  webPagePassage,
  type ScientSourceWebPage,
} from "./webPage.ts";

const page = (input: Partial<ScientSourceWebPage>): ScientSourceWebPage => ({
  url: "https://example.org/",
  title: null,
  selection: null,
  meta: [],
  ...input,
});

describe("web pages saved to the Library", () => {
  it("reads an article's Highwire Press tags", () => {
    const article = page({
      url: "https://journal.example/articles/42",
      title: "Journal site | Article",
      meta: [
        { name: "citation_title", content: "Early antibiotics in sepsis" },
        { name: "citation_author", content: "Lovelace, Ada" },
        { name: "citation_author", content: "Grace Hopper" },
        { name: "citation_publication_date", content: "2024/03/05" },
        { name: "citation_journal_title", content: "Critical Care" },
        { name: "citation_doi", content: "doi:10.1000/CC.2024.42" },
        { name: "citation_firstpage", content: "10" },
        { name: "citation_lastpage", content: "19" },
      ],
    });
    expect(webPageCandidate(article, "web_1")).toMatchObject({
      type: "article",
      title: "Early antibiotics in sepsis",
      creators: [
        { familyName: "Lovelace", givenName: "Ada", literalName: null },
        { familyName: null, givenName: null, literalName: "Grace Hopper" },
      ],
      issuedRaw: "2024-03-05",
      issuedYear: 2024,
      containerTitle: "Critical Care",
      pages: "10-19",
      url: "https://journal.example/articles/42",
      identifiers: [{ scheme: "doi", value: "10.1000/cc.2024.42" }],
    });
  });

  it("takes identifiers from DOI, PubMed and arXiv addresses when the page has no tags", () => {
    expect(webPageIdentifiers(page({ url: "https://doi.org/10.1000/abc.1" }))).toEqual([
      { scheme: "doi", value: "10.1000/abc.1" },
    ]);
    expect(webPageIdentifiers(page({ url: "https://pubmed.ncbi.nlm.nih.gov/31234567/" }))).toEqual([
      { scheme: "pmid", value: "31234567" },
    ]);
    expect(webPageIdentifiers(page({ url: "https://arxiv.org/abs/2401.01234v2" }))).toEqual([
      { scheme: "arxiv", value: "2401.01234" },
    ]);
    expect(
      webPageIdentifiers(
        page({ url: "https://publisher.example/doi/full/10.1002/anie.2024%2F01" }),
      ),
    ).toEqual([{ scheme: "doi", value: "10.1002/anie.2024/01" }]);
  });

  it("saves any other page as a web page with its own title", () => {
    expect(
      webPageCandidate(
        page({
          url: "https://blog.example/post",
          title: "  A post\nabout methods ",
          meta: [{ name: "og:site_name", content: "Lab blog" }],
        }),
        "web_2",
      ),
    ).toMatchObject({
      type: "web",
      title: "A post about methods",
      identifiers: [],
      containerTitle: "Lab blog",
      url: "https://blog.example/post",
    });
  });

  it("keeps the selected passage once in the note", () => {
    expect(
      webPagePassage("  First  line\nwraps.\n\n Second paragraph. ", "https://example.org/a"),
    ).toBe(
      "Selected on the web page https://example.org/a:\nFirst line wraps.\n\nSecond paragraph.",
    );
    expect(webPagePassage(" \n ", "https://example.org/a")).toBeNull();
    expect(noteWithPassage(null, "Quote")).toBe("Quote");
    expect(noteWithPassage("My note", "Quote")).toBe("My note\n\nQuote");
    expect(noteWithPassage("My note\n\nQuote", "Quote")).toBeNull();
  });
});
