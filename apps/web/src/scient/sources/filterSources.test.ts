import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterScientSourceSearchIndex, indexScientSourceSummaries } from "./filterSources";

type SourceSummary = ScientSourcesOverviewResult["records"][number];

function source(overrides: Partial<SourceSummary>): SourceSummary {
  return {
    sourceId: "source-1",
    revision: 1,
    type: "article",
    title: "Emergency medicine",
    creators: [
      {
        creatorType: "author",
        givenName: null,
        familyName: "Ioannidis",
        literalName: null,
      },
    ],
    issuedYear: 2024,
    identifiers: [{ scheme: "doi", value: "10.1000/example" }],
    containerTitle: "Science",
    url: null,
    externalReferences: [],
    attachments: [],
    importedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("Scient source search index", () => {
  const records = [
    source({ sourceId: "one" }),
    source({
      sourceId: "two",
      title: "Machine learning",
      creators: [
        {
          creatorType: "author",
          givenName: null,
          familyName: "Smith",
          literalName: null,
        },
      ],
      issuedYear: 2021,
      containerTitle: "Nature Medicine",
      identifiers: [{ scheme: "pmid", value: "12345" }],
    }),
  ];

  it("matches compact metadata without loading source details", () => {
    const index = indexScientSourceSummaries(records);
    expect(
      filterScientSourceSearchIndex(index, "ioannidis 2024").map((item) => item.sourceId),
    ).toEqual(["one"]);
    expect(
      filterScientSourceSearchIndex(index, "nature medicine").map((item) => item.sourceId),
    ).toEqual(["two"]);
    expect(
      filterScientSourceSearchIndex(index, "10.1000/example").map((item) => item.sourceId),
    ).toEqual(["one"]);
  });

  it("returns every indexed source for an empty query", () => {
    expect(filterScientSourceSearchIndex(indexScientSourceSummaries(records), "  ")).toEqual(
      records,
    );
  });

  it("reuses a precomputed metadata index across queries", () => {
    const index = indexScientSourceSummaries(records);
    expect(filterScientSourceSearchIndex(index, "smith").map((item) => item.sourceId)).toEqual([
      "two",
    ]);
    expect(filterScientSourceSearchIndex(index, "pmid 12345").map((item) => item.sourceId)).toEqual(
      ["two"],
    );
  });
});
