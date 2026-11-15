import { describe, expect, it } from "@effect/vitest";

import { scientReviewVersionDifferences } from "./libraryReviewConflicts.ts";
import type {
  ScientReviewScreening,
  ScientReviewSearch,
  ScientSystematicReview,
} from "./systematicReview.ts";

const review = (parts: Partial<ScientSystematicReview>): ScientSystematicReview => ({
  formatVersion: 1,
  reviewId: "review_1",
  title: "Sepsis trials",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  updatedBy: "user",
  searches: [],
  otherSourceIds: [],
  duplicates: [],
  distinctPairs: [],
  screening: [],
  exclusionReasons: [],
  ...parts,
});

const decided = (
  sourceId: string,
  decision: ScientReviewScreening["decision"],
  more: Partial<ScientReviewScreening> = {},
): ScientReviewScreening => ({
  sourceId,
  stage: "title-abstract",
  decision,
  decidedAt: "2026-11-02T00:00:00.000Z",
  decidedBy: "user",
  ...more,
});

const search = (searchId: string, more: Partial<ScientReviewSearch> = {}): ScientReviewSearch => ({
  searchId,
  database: "PubMed",
  query: "sepsis",
  searchedOn: "2026-11-01",
  sourceIds: [],
  loggedAt: "2026-11-01T00:00:00.000Z",
  loggedBy: "user",
  ...more,
});

const differences = (here: ScientSystematicReview, other: ScientSystematicReview, offset = 0) =>
  scientReviewVersionDifferences({
    here,
    other,
    titleOf: (sourceId) => `Title of ${sourceId}`,
    offset,
  });

describe("differences between two versions of a review", () => {
  it("lists a record the two decided differently with both decisions, and leaves out one they decided alike", () => {
    const agreed = decided("agreed", "include");
    const result = differences(
      review({
        otherSourceIds: ["agreed", "split"],
        screening: [agreed, decided("split", "include")],
      }),
      review({
        otherSourceIds: ["agreed", "split"],
        screening: [
          // The same decision made again on another computer is not a difference.
          { ...agreed, decidedAt: "2026-11-09T00:00:00.000Z", decidedBy: "agent" },
          decided("split", "exclude", {
            reason: "Wrong population",
            decidedAt: "2026-11-05T00:00:00.000Z",
            decidedBy: "agent",
          }),
        ],
      }),
    );

    expect(result.decisions).toEqual({ differing: 1, onlyHere: 0, onlyOther: 0 });
    expect(result.rows).toEqual([
      {
        kind: "decision",
        sourceId: "split",
        title: "Title of split",
        stage: "title-abstract",
        here: { decision: "include", decidedAt: "2026-11-02T00:00:00.000Z", decidedBy: "user" },
        other: {
          decision: "exclude",
          reason: "Wrong population",
          decidedAt: "2026-11-05T00:00:00.000Z",
          decidedBy: "agent",
        },
      },
    ]);
  });

  it("lists a record decided in one version only, one reopened in the other, and a record only one has", () => {
    const result = differences(
      review({
        otherSourceIds: ["shared", "mine"],
        screening: [decided("shared", "include"), decided("mine", "maybe")],
      }),
      review({
        otherSourceIds: ["shared", "theirs"],
        screening: [
          decided("shared", "include"),
          decided("shared", "include", { cleared: true }),
          decided("theirs", "exclude", { stage: "full-text", reason: "Wrong outcome" }),
        ],
      }),
    );

    expect(result.decisions).toEqual({ differing: 0, onlyHere: 2, onlyOther: 1 });
    expect(result.records).toEqual({ onlyHere: 1, onlyOther: 1 });
    expect(
      result.rows.map((row) =>
        row.kind === "decision"
          ? [row.sourceId, row.stage, row.here?.decision ?? null, row.other?.decision ?? null]
          : row.kind === "record"
            ? [row.sourceId, row.in]
            : row,
      ),
    ).toEqual([
      ["shared", "title-abstract", "include", null],
      ["mine", "title-abstract", "maybe", null],
      ["theirs", "full-text", null, "exclude"],
      ["mine", "here"],
      ["theirs", "other"],
    ]);
  });

  it("lists a search only one version ran, one reworded and one with other records, not one that is the same", () => {
    const same = search("search_same", { sourceIds: ["a"] });
    const result = differences(
      review({
        searches: [
          same,
          search("search_reworded", { sourceIds: ["a"] }),
          search("search_grown", { sourceIds: ["a", "b"] }),
          search("search_mine", { database: "Embase" }),
          search("search_logged_here", { database: "Scopus", sourceIds: ["a"] }),
        ],
      }),
      review({
        searches: [
          // Logged again with nothing changed: not a difference.
          { ...same, loggedAt: "2026-11-09T00:00:00.000Z" },
          // The same search logged apart on the other copy (another ID): one search, as it
          // is to Combine, and not a difference.
          search("search_logged_there", { database: "Scopus", sourceIds: ["a"] }),
          search("search_reworded", { query: "sepsis AND trial", sourceIds: ["a"] }),
          search("search_grown", { sourceIds: ["a"] }),
        ],
      }),
    );

    expect(result.searches).toEqual({ differing: 2, onlyHere: 1, onlyOther: 0 });
    expect(result.rows.filter((row) => row.kind === "search")).toMatchObject([
      {
        here: { searchId: "search_reworded", query: "sepsis", recordsOnlyThisSide: 0 },
        other: { searchId: "search_reworded", query: "sepsis AND trial", recordsOnlyThisSide: 0 },
      },
      {
        here: { searchId: "search_grown", records: 2, recordsOnlyThisSide: 1 },
        other: { searchId: "search_grown", records: 1, recordsOnlyThisSide: 0 },
      },
      { here: { searchId: "search_mine", database: "Embase" }, other: null },
    ]);
    expect(result.records).toEqual({ onlyHere: 1, onlyOther: 0 });
  });

  it("names the other parts of a review that differ, and says nothing differs when only history does", () => {
    const base = review({
      otherSourceIds: ["a", "b"],
      duplicates: [
        {
          sourceId: "b",
          duplicateOf: "a",
          decidedAt: "2026-11-02T00:00:00.000Z",
          decidedBy: "user",
        },
      ],
      retrieval: [
        {
          sourceId: "a",
          outcome: "sought",
          recordedAt: "2026-11-02T00:00:00.000Z",
          recordedBy: "user",
        },
      ],
    });

    expect(
      differences(
        base,
        review({
          ...base,
          title: "Sepsis trials, laptop",
          question: "Does early treatment help?",
          exclusionReasons: ["Wrong population"],
          duplicates: [],
          distinctPairs: [["a", "b"]],
          retrieval: [
            ...base.retrieval!,
            {
              sourceId: "a",
              outcome: "retrieved",
              recordedAt: "2026-11-03T00:00:00.000Z",
              recordedBy: "user",
            },
          ],
        }),
      ),
    ).toMatchObject({
      alsoDiffering: ["title", "question", "exclusion-reasons", "duplicates", "retrieval"],
      rows: [],
    });
    expect(
      differences(base, { ...base, updatedAt: "2026-11-09T00:00:00.000Z", updatedBy: "agent" }),
    ).toEqual({
      decisions: { differing: 0, onlyHere: 0, onlyOther: 0 },
      searches: { differing: 0, onlyHere: 0, onlyOther: 0 },
      records: { onlyHere: 0, onlyOther: 0 },
      alsoDiffering: [],
      rows: [],
      nextOffset: null,
    });
  });

  it("serves the rows a page at a time, with the counts of all of them on every page", () => {
    const ids = Array.from({ length: 101 }, (_, index) => `source_${index}`);
    const here = review({});
    const other = review({ otherSourceIds: ids });

    const first = differences(here, other);
    expect(first.records.onlyOther).toBe(101);
    expect(first.rows).toHaveLength(100);
    const last = differences(here, other, first.nextOffset!);
    expect(last.records.onlyOther).toBe(101);
    expect(last.rows).toMatchObject([{ kind: "record", sourceId: "source_100", in: "other" }]);
    expect(last.nextOffset).toBeNull();
  });
});
