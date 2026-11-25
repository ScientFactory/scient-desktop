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
  it("indexes and sorts a list once until its rows or the sort change", () => {
    const index = indexScientSourceSummaries(records);
    expect(indexScientSourceSummaries(records)).toBe(index);
    expect(indexScientSourceSummaries([...records])).not.toBe(index);
    // Each render filters into a new list of the same rows.
    const sorted = sortScientSourceRecords(filterScientSourceSearchIndex(index, ""), "title");
    expect(sortScientSourceRecords(filterScientSourceSearchIndex(index, ""), "title")).toBe(sorted);
    const byYear = sortScientSourceRecords(
      filterScientSourceSearchIndex(index, ""),
      "publication-year",
    );
    expect(byYear).not.toBe(sorted);
    const fewer = sortScientSourceRecords(filterScientSourceSearchIndex(index, "smith"), "title");
    expect(fewer.map((item) => item.sourceId)).toEqual(["two"]);
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

it("sorts recently added sources newest first and an unreadable date last", () => {
  const sorted = sortScientSourceRecords(
    [
      source({ sourceId: "unknown", importedAt: "not a date" }),
      source({ sourceId: "old", importedAt: "2026-08-01T00:00:00.000Z" }),
      source({ sourceId: "new", importedAt: "2026-08-15T00:00:00.000Z" }),
    ],
    "last-added",
  );
  expect(sorted.map((item) => item.sourceId)).toEqual(["new", "old", "unknown"]);
});

it("sorts by journal A–Z, case aside, with title as tie-breaker and no journal last", () => {
  const sorted = sortScientSourceRecords(
    [
      source({ sourceId: "none", containerTitle: "  ", title: "A" }),
      source({ sourceId: "science", containerTitle: "Science", title: "A" }),
      source({ sourceId: "nature-b", containerTitle: "nature", title: "B" }),
      source({ sourceId: "nature-a", containerTitle: "Nature ", title: "A" }),
    ],
    "journal",
  );
  expect(sorted.map((item) => item.sourceId)).toEqual(["nature-a", "nature-b", "science", "none"]);
});
