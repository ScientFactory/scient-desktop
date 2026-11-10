import { describe, expect, it } from "@effect/vitest";

import {
  applyScientSourceTagChanges,
  compileScientSourceFilter,
  scientSourceTagCounts,
  type ScientSourceFilterable,
} from "./organize.ts";

function source(
  sourceId: string,
  overrides: Partial<ScientSourceFilterable> = {},
): ScientSourceFilterable {
  return {
    sourceId,
    type: "article",
    title: `Title ${sourceId}`,
    creators: [],
    issuedYear: 2020,
    identifiers: [],
    containerTitle: null,
    tags: [],
    attachments: [],
    ...overrides,
  };
}

describe("Library filters", () => {
  const sources = [
    source("a", { tags: ["Methods", "RCT"], attachments: [{ kind: "pdf" }] }),
    source("b", { tags: ["methods"], type: "book", title: "Sepsis handbook" }),
    source("c", { title: "Sepsis outcomes" }),
  ];
  const organization = {
    collections: [
      {
        collectionId: "collection_1",
        name: "Chapter 2",
        sourceIds: ["b", "c"],
        updatedAt: "2026-11-10T00:00:00.000Z",
        updatedBy: "user" as const,
      },
    ],
  };
  const ids = (filter: Parameters<typeof compileScientSourceFilter>[0]) => {
    const matches = compileScientSourceFilter(filter, organization);
    return sources.filter((entry) => matches(entry)).map((entry) => entry.sourceId);
  };

  it.each([
    ["tags match without regard to case and all must match", { tags: ["METHODS"] }, ["a", "b"]],
    ["several tags narrow", { tags: ["methods", "rct"] }, ["a"]],
    ["collection limits to its members", { collectionId: "collection_1" }, ["b", "c"]],
    ["an unknown collection matches nothing", { collectionId: "collection_gone" }, []],
    ["type", { type: "book" as const }, ["b"]],
    ["has a PDF", { hasPdf: true }, ["a"]],
    ["text terms all appear, tags included", { text: "sepsis METHODS" }, ["b"]],
    [
      "filters combine",
      { collectionId: "collection_1", text: "sepsis", type: "article" as const },
      ["c"],
    ],
  ])("%s", (_label, filter, expected) => {
    expect(ids(filter)).toEqual(expected);
  });

  it("counts tags once per source, keeping the first spelling", () => {
    expect(scientSourceTagCounts(sources)).toEqual([
      { tag: "Methods", count: 2 },
      { tag: "RCT", count: 1 },
    ]);
  });

  it("adds tags without duplicating existing spellings and removes them in any case", () => {
    expect(
      applyScientSourceTagChanges({
        tags: ["Methods", "RCT"],
        add: ["methods", " sepsis "],
        remove: ["rct"],
      }),
    ).toEqual(["Methods", "sepsis"]);
  });
});
