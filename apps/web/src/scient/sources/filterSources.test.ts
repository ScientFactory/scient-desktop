import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterScientSourceSearchIndex,
  indexScientSourceSummaries,
  sortScientSourceRecords,
} from "./filterSources";

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
    expect(
      filterScientSourceSearchIndex(index, "https://doi.org/10.1000/example").map(
        (item) => item.sourceId,
      ),
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
  it("sorts by newest publication year and keeps undated sources last", () => {
    const sorted = sortScientSourceRecords(
      [
        source({ sourceId: "undated", issuedYear: null }),
        source({ sourceId: "older", issuedYear: 2021 }),
        source({ sourceId: "newer", issuedYear: 2025 }),
      ],
      "publication-year",
    );
    expect(sorted.map((item) => item.sourceId)).toEqual(["newer", "older", "undated"]);
  });
});

it("sorts by title and uses source ID as a deterministic tie-breaker", () => {
  const sorted = sortScientSourceRecords(
    [
      source({ sourceId: "z", title: "Same title" }),
      source({ sourceId: "a", title: "Same title" }),
      source({ sourceId: "first", title: "Alpha" }),
    ],
    "title",
  );
  expect(sorted.map((item) => item.sourceId)).toEqual(["first", "a", "z"]);
});

it("sorts recently added sources newest first", () => {
  const sorted = sortScientSourceRecords(
    [
      source({ sourceId: "old", importedAt: "2026-08-01T00:00:00.000Z" }),
      source({ sourceId: "new", importedAt: "2026-08-15T00:00:00.000Z" }),
    ],
    "last-added",
  );
  expect(sorted.map((item) => item.sourceId)).toEqual(["new", "old"]);
});
