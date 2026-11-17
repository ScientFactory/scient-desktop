import type { ScientReviewDecision } from "@scientfactory/scient-sources";
import type { ScientSystematicReviewConflictsResult } from "@t3tools/contracts";

export type ReviewVersionDifferences = NonNullable<
  ScientSystematicReviewConflictsResult["differences"]
>;
type Row = ReviewVersionDifferences["rows"][number];
type DecisionSide = Extract<Row, { kind: "decision" }>["here"];
type SearchSide = Extract<Row, { kind: "search" }>["here"];

export const REVIEW_VERSION_LABELS = {
  here: "This version",
  other: "The other version",
  more: "Show more",
  unreadable: "The differences between these two versions could not be read.",
  untitled: "Untitled source",
} as const;

export const DECISION_LABELS: Readonly<Record<ScientReviewDecision, string>> = {
  include: "Included",
  exclude: "Excluded",
  maybe: "Maybe",
};

export const STAGE_WORDS = {
  "title-abstract": "title and abstract",
  "full-text": "full text",
} as const;

export const reviewDate = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed);
};
export const plural = (value: number, one: string, many: string) =>
  `${value.toLocaleString()} ${value === 1 ? one : many}`;

const ALSO_WORDS: Readonly<Record<ReviewVersionDifferences["alsoDiffering"][number], string>> = {
  deleted: "whether the review is deleted",
  title: "the title",
  question: "the question",
  "exclusion-reasons": "the exclusion reasons",
  duplicates: "the records marked as duplicates",
  retrieval: "the full-text retrieval records",
};

/** All that differs, as counts, before any row; also said when nothing in the rows differs. */
export function differenceCounts(differences: ReviewVersionDifferences): string {
  const { decisions, searches, records } = differences;
  const counts = [
    [decisions.differing, "decision that differs", "decisions that differ"],
    [decisions.onlyHere, "decision only in this version", "decisions only in this version"],
    [
      decisions.onlyOther,
      "decision only in the other version",
      "decisions only in the other version",
    ],
    [searches.differing, "search that differs", "searches that differ"],
    [searches.onlyHere, "search only in this version", "searches only in this version"],
    [searches.onlyOther, "search only in the other version", "searches only in the other version"],
    [records.onlyHere, "record only in this version", "records only in this version"],
    [records.onlyOther, "record only in the other version", "records only in the other version"],
  ] as const;
  const parts = counts.flatMap(([value, one, many]) =>
    value > 0 ? [plural(value, one, many)] : [],
  );
  const also = differences.alsoDiffering.map((part) => ALSO_WORDS[part]);
  return [
    parts.length > 0
      ? `What differs: ${parts.join(", ")}.`
      : "The two versions have the same decisions, searches and records.",
    also.length > 0
      ? `Also different: ${also.join(", ")}.`
      : parts.length === 0
        ? "They differ only in their history, or in the details of the sources saved with each."
        : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Which version alone has it; null when both do. */
const onlyIn = (here: unknown, other: unknown) =>
  here !== null && other !== null
    ? null
    : here !== null
      ? "in this version only"
      : "in the other version only";

/** What a row is about, and how the two versions stand on it. */
export function rowHeading(row: Row): {
  readonly key: string;
  readonly title: string;
  readonly standing: string;
} {
  switch (row.kind) {
    case "decision": {
      const only = onlyIn(row.here, row.other);
      const stage = STAGE_WORDS[row.stage];
      return {
        key: `decision:${row.stage}:${row.sourceId}`,
        title: row.title?.trim() || REVIEW_VERSION_LABELS.untitled,
        standing: only ? `Decided at ${stage} ${only}` : `Decided differently at ${stage}`,
      };
    }
    case "search": {
      const search = (row.here ?? row.other)!;
      const only = onlyIn(row.here, row.other);
      return {
        key: `search:${search.searchId}`,
        title: search.database,
        standing: only ? `A search ${only}` : "A search with different details or records",
      };
    }
    case "record":
      return {
        key: `record:${row.sourceId}`,
        title: row.title?.trim() || REVIEW_VERSION_LABELS.untitled,
        standing: `A record in ${row.in === "here" ? "this version" : "the other version"} only`,
      };
  }
}

/** One version's decision on a record: the decision and reason, when, an agent's marked, the note. */
export function decisionText(side: DecisionSide): string {
  if (!side) return "";
  return [
    [
      DECISION_LABELS[side.decision],
      side.reason,
      reviewDate(side.decidedAt),
      side.decidedBy === "agent" ? "by agent" : "",
    ]
      .filter(Boolean)
      .join(" · "),
    side.note ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * One version's entry of a search, as the review's own list words it. `only` words the records
 * the other version's entry lacks, and is null when the other version has no such entry.
 */
export function searchText(side: SearchSide, only: string | null): string {
  if (!side) return "";
  return [
    [
      side.database,
      side.searchedOn,
      side.resultCount === undefined ? "" : `${side.resultCount.toLocaleString()} results`,
      `${plural(side.records, "record", "records")}${
        only && side.recordsOnlyThisSide > 0
          ? ` (${side.recordsOnlyThisSide.toLocaleString()} ${only})`
          : ""
      }`,
      side.loggedBy === "agent" ? "by agent" : "",
    ]
      .filter(Boolean)
      .join(" · "),
    side.query,
    side.notes ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}
