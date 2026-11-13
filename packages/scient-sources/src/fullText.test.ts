import { describe, expect, it } from "@effect/vitest";

import {
  foldText,
  fullTextPassage,
  locateFullTextQuote,
  parseFullTextQuery,
  searchFullText,
  type FullTextSearchDocument,
} from "./fullText.ts";

function searchDocument(key: string, pages: ReadonlyArray<string>): FullTextSearchDocument {
  return {
    key,
    pages: pages.map((text, index) => ({ page: index + 1, folded: foldText(text, "search").text })),
  };
}

describe("full-text folding", () => {
  it("maps every folded unit back to the stored character it came from", () => {
    const source = "Eﬀect of  co-\nhorts “here”";
    const folded = foldText(source, "quote");
    expect(folded.text).toBe('Effect of cohorts "here"');
    expect(folded.origin).toHaveLength(folded.text.length);
    expect(source[folded.origin[folded.text.indexOf("h")]!]).toBe("h");
    expect(source[folded.origin[folded.text.indexOf('"')]!]).toBe("“");
  });

  it("joins line-end hyphenation only before a lowercase continuation", () => {
    expect(foldText("frag-\nment", "search").text).toBe("fragment");
    expect(foldText("COVID-\n19", "search").text).toBe("covid 19");
    expect(foldText("drug-\nDrug", "search").text).toBe("drug drug");
    expect(foldText("Café Über", "search").text).toBe("cafe uber");
  });
});

describe("full-text quotes", () => {
  const pages = [
    { page: 1, text: "Introduction\nThe cohort was large." },
    { page: 2, text: "Mortality fell by 12%\nin treated pa-\ntients over two years." },
  ];

  it("returns the exact stored location of a verbatim quote", () => {
    expect(locateFullTextQuote(pages, "Mortality fell by 12%")).toEqual({
      _tag: "Found",
      match: "exact",
      ranges: [{ page: 2, start: 0, end: 21 }],
      text: "Mortality fell by 12%",
      prefix: "Introduction\nThe cohort was large.\n",
      suffix: "\nin treated pa-\ntients over two years.",
    });
  });

  it("matches a quote typed without the PDF's line breaks and hyphenation", () => {
    const located = locateFullTextQuote(pages, "fell by 12% in treated patients");
    expect(located).toMatchObject({
      _tag: "Found",
      match: "normalized",
      ranges: [{ page: 2, start: 10, end: 43 }],
      text: "fell by 12%\nin treated pa-\ntients",
    });
  });

  it("finds a quote that crosses into the next page, never as exact", () => {
    const located = locateFullTextQuote(pages, "was large. Mortality fell");
    expect(located).toMatchObject({
      _tag: "Found",
      match: "normalized",
      ranges: [
        { page: 1, start: 24, end: 34 },
        { page: 2, start: 0, end: 14 },
      ],
    });
  });

  it("never joins text across an unread page or a gap in page numbers", () => {
    const quote = "The drug is effective.";
    const failedMiddle = [
      { page: 1, text: "The drug is " },
      { page: 2, text: "" },
      { page: 3, text: "effective." },
    ];
    expect(locateFullTextQuote(failedMiddle, quote)).toEqual({ _tag: "NotFound" });
    const omitted = [
      { page: 1, text: "The drug is " },
      { page: 3, text: "effective." },
    ];
    expect(locateFullTextQuote(omitted, quote)).toEqual({ _tag: "NotFound" });
  });

  it("never guesses between repeats and reports what is absent", () => {
    const repeated = [{ page: 1, text: "We saw no effect. Later, we saw no effect." }];
    expect(locateFullTextQuote(repeated, "saw  no effect")).toEqual({
      _tag: "Ambiguous",
      match: "normalized",
    });
    expect(locateFullTextQuote(repeated, "saw no effect.")).toEqual({
      _tag: "Ambiguous",
      match: "exact",
    });
    expect(locateFullTextQuote(pages, "Mortality rose by 12%")).toEqual({ _tag: "NotFound" });
  });
});

describe("full-text search", () => {
  const documents = [
    searchDocument("trial", [
      "Methods. We randomised 400 patients with sepsis to early antibiotics.",
      "Results. Early antibiotics reduced mortality in septic shock. Mortality was 21%.",
    ]),
    searchDocument("cohort", [
      "A cohort of 1,000 patients. Mortality was recorded at one year.",
      "Sepsis was rare.",
    ]),
    searchDocument("unrelated", ["Protein folding in yeast."]),
  ];

  it("ranks the passage holding all rare terms first and returns one best page per document", () => {
    const hits = searchFullText(documents, parseFullTextQuery("antibiotics mortality"), {
      limit: 10,
      perDocument: 1,
    });
    expect(hits.map((hit) => [hit.key, hit.page])).toEqual([
      ["trial", 2],
      ["cohort", 1],
    ]);
    expect(hits[0]!.matchedTerms).toEqual(["antibiotics", "mortality"]);
  });

  it("requires quoted phrases and matches long terms as word prefixes", () => {
    expect(
      searchFullText(documents, parseFullTextQuery('"septic shock"'), {
        limit: 10,
        perDocument: 3,
      }).map((hit) => hit.key),
    ).toEqual(["trial"]);
    expect(
      searchFullText(documents, parseFullTextQuery("randomis"), { limit: 10, perDocument: 3 }).map(
        (hit) => hit.key,
      ),
    ).toEqual(["trial"]);
  });

  it("maps a hit back to stored offsets and a one-line passage", () => {
    const page = "Results. Early antibiotics\nreduced mortality in septic shock.";
    const [hit] = searchFullText(
      [searchDocument("trial", [page])],
      parseFullTextQuery("antibiotics"),
      {
        limit: 1,
        perDocument: 1,
      },
    );
    const passage = fullTextPassage(page, hit!);
    expect(page.slice(passage.start, passage.end)).toBe("antibiotics");
    expect(passage.passage).toBe("Results. Early antibiotics reduced mortality in septic shock.");
  });

  it("reveals the tightest occurrence of the query, not the window of repeated terms", () => {
    const page =
      "We used a two-layer box model with a sill. Methods. The stratified layer was sampled " +
      "weekly. Discussion. Mixing limits nutrient supply to the upper layer.";
    const reveal = (query: string, text: string) => {
      const [hit] = searchFullText([searchDocument("fjord", [text])], parseFullTextQuery(query), {
        limit: 1,
        perDocument: 1,
      });
      const passage = fullTextPassage(text, hit!);
      return { quote: text.slice(passage.start, passage.end), passage: passage.passage };
    };
    const contiguous = reveal("stratified layer", page);
    expect(contiguous.quote).toBe("stratified layer");
    expect(contiguous.passage).toContain("two-layer box model");
    expect(contiguous.passage).toContain("the upper layer.");
    const apart = "Each layer was sampled. Later the column was stratified again.";
    expect(reveal("stratified layer", apart).quote).toBe(
      "layer was sampled. Later the column was stratified",
    );
  });
});
