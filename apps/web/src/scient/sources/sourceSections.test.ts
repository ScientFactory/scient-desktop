import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sortScientSourceRecords, type ScientSourceSort } from "./filterSources";
import { scientSourceCardRows, scientSourceSections } from "./sourceSections";

type SourceSummary = ScientSourcesOverviewResult["records"][number];

function source(sourceId: string, overrides: Partial<SourceSummary> = {}): SourceSummary {
  return {
    sourceId,
    revision: 1,
    type: "article",
    title: sourceId,
    creators: [],
    issuedYear: 2024,
    identifiers: [],
    containerTitle: null,
    url: null,
    externalReferences: [],
    attachments: [],
    importedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

function addedAt(year: number, month: number, day: number, hour = 12): string {
  return new Date(year, month - 1, day, hour).toISOString();
}

function headings(sources: ReadonlyArray<SourceSummary>, sort: ScientSourceSort, now: number) {
  const sorted = sortScientSourceRecords(sources, sort);
  return scientSourceSections(sorted, sort, now).map((section) => [
    section.label,
    section.start,
    section.count,
  ]);
}

describe("sections from the sort", () => {
  it("buckets Last added by the local calendar, the week from Monday, unknown dates last", () => {
    // Sunday 15 November 2026; the week began on Monday the 9th.
    const now = new Date(2026, 10, 15, 18).getTime();
    expect(
      headings(
        [
          source("unknown", { importedAt: "not a date" }),
          source("october", { importedAt: addedAt(2026, 10, 31) }),
          source("sunday-before", { importedAt: addedAt(2026, 11, 8) }),
          source("monday", { importedAt: addedAt(2026, 11, 9, 0) }),
          source("this-morning", { importedAt: addedAt(2026, 11, 15, 8) }),
          source("ahead-of-clock", { importedAt: addedAt(2026, 11, 16) }),
        ],
        "last-added",
        now,
      ),
    ).toEqual([
      ["Today", 0, 2],
      ["This week", 2, 1],
      ["This month", 3, 1],
      ["Earlier", 4, 1],
      ["Date added unknown", 5, 1],
    ]);
  });

  it("keeps a week that began last month under This week", () => {
    // Thursday 1 October 2026; the week began on Monday 28 September.
    const now = new Date(2026, 9, 1, 10).getTime();
    expect(
      headings(
        [
          source("tuesday", { importedAt: addedAt(2026, 9, 29) }),
          source("sunday-before", { importedAt: addedAt(2026, 9, 27) }),
        ],
        "last-added",
        now,
      ),
    ).toEqual([
      ["This week", 0, 1],
      ["Earlier", 1, 1],
    ]);
  });

  it("heads each publication year, newest first, with No year last", () => {
    expect(
      headings(
        [
          source("a", { issuedYear: 2016 }),
          source("b", { issuedYear: null }),
          source("c", { issuedYear: 2021 }),
          source("d", { issuedYear: 2016 }),
        ],
        "publication-year",
        0,
      ),
    ).toEqual([
      ["2021", 0, 1],
      ["2016", 1, 2],
      ["No year", 3, 1],
    ]);
  });

  it("heads each journal once, whatever its case, under the first spelling sorted", () => {
    expect(
      headings(
        [
          source("b", { containerTitle: "nature" }),
          source("a", { containerTitle: "Nature" }),
          source("none", { containerTitle: null }),
          source("c", { containerTitle: "Science" }),
        ],
        "journal",
        0,
      ),
    ).toEqual([
      ["Nature", 0, 2],
      ["Science", 2, 1],
      ["No journal or proceedings", 3, 1],
    ]);
  });

  it("gives Title and Author no headings", () => {
    const sources = [source("a"), source("b")];
    expect(headings(sources, "title", 0)).toEqual([]);
    expect(headings(sources, "author", 0)).toEqual([]);
  });
});

describe("card rows", () => {
  const sources = ["s0", "s1", "s2", "s3", "s4"].map((id) => source(id));
  const sections = [
    { label: "2016", start: 0, count: 3 },
    { label: "2015", start: 3, count: 2 },
  ];

  function labels(columns: number) {
    return scientSourceCardRows(sources, sections, columns).map((row) =>
      row.cards.map((card) =>
        card.label
          ? `${card.label.section.label}${card.label.continued ? " (continued)" : ""}`
          : "",
      ),
    );
  }

  it("labels a section mid-row where it starts and again on each row it continues on", () => {
    expect(labels(2)).toEqual([["2016", ""], ["2016 (continued)", "2015"], ["2015 (continued)"]]);
  });

  it("labels every card of a single column", () => {
    expect(labels(1)).toEqual([
      ["2016"],
      ["2016 (continued)"],
      ["2016 (continued)"],
      ["2015"],
      ["2015 (continued)"],
    ]);
  });

  it("labels nothing without sections", () => {
    const rows = scientSourceCardRows(sources, [], 3);
    expect(rows.map((row) => row.cards.length)).toEqual([3, 2]);
    expect(rows.flatMap((row) => row.cards).every((card) => card.label === null)).toBe(true);
  });
});
