import type { ScientReviewDecision } from "@scientfactory/scient-sources";
import type { ScientSystematicReviewConflictsResult } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

export type ReviewVersionDifferences = NonNullable<
  ScientSystematicReviewConflictsResult["differences"]
>;
type Row = ReviewVersionDifferences["rows"][number];
type DecisionSide = Extract<Row, { kind: "decision" }>["here"];
type SearchSide = Extract<Row, { kind: "search" }>["here"];

export const REVIEW_VERSION_LABELS = {
  here: msg("This version"),
  other: msg("The other version"),
  more: msg("Show more"),
  unreadable: msg("The differences between these two versions could not be read."),
  untitled: msg("Untitled source"),
} as const;

export const DECISION_LABELS: Readonly<Record<ScientReviewDecision, string>> = {
  include: msg("Included", { $context: "screening decision" }),
  exclude: msg("Excluded", { $context: "screening decision" }),
  maybe: msg("Maybe", { $context: "screening decision" }),
};

export const STAGE_WORDS = {
  "title-abstract": msg("title and abstract", { $context: "screening stage" }),
  "full-text": msg("full text", { $context: "screening stage" }),
} as const;

export const reviewDate = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed);
};

const ALSO_WORDS: Readonly<Record<ReviewVersionDifferences["alsoDiffering"][number], string>> = {
  deleted: msg("whether the review is deleted"),
  title: msg("the title", { $context: "what differs between two versions of a review" }),
  question: msg("the question"),
  "exclusion-reasons": msg("the exclusion reasons"),
  duplicates: msg("the records marked as duplicates"),
  retrieval: msg("the full-text retrieval records"),
};

const count = (value: number) => value.toLocaleString();

/** All that differs, as counts, before any row; also said when nothing in the rows differs. */
export function differenceCounts(
  differences: ReviewVersionDifferences,
  resolve: MessageResolver = m,
): string {
  const { decisions, searches, records } = differences;
  const counts = [
    [
      decisions.differing,
      msg(
        "{count, plural, one {{shown} decision that differs} other {{shown} decisions that differ}}",
      ),
    ],
    [
      decisions.onlyHere,
      msg(
        "{count, plural, one {{shown} decision only in this version} other {{shown} decisions only in this version}}",
      ),
    ],
    [
      decisions.onlyOther,
      msg(
        "{count, plural, one {{shown} decision only in the other version} other {{shown} decisions only in the other version}}",
      ),
    ],
    [
      searches.differing,
      msg(
        "{count, plural, one {{shown} search that differs} other {{shown} searches that differ}}",
      ),
    ],
    [
      searches.onlyHere,
      msg(
        "{count, plural, one {{shown} search only in this version} other {{shown} searches only in this version}}",
      ),
    ],
    [
      searches.onlyOther,
      msg(
        "{count, plural, one {{shown} search only in the other version} other {{shown} searches only in the other version}}",
      ),
    ],
    [
      records.onlyHere,
      msg(
        "{count, plural, one {{shown} record only in this version} other {{shown} records only in this version}}",
      ),
    ],
    [
      records.onlyOther,
      msg(
        "{count, plural, one {{shown} record only in the other version} other {{shown} records only in the other version}}",
      ),
    ],
  ] as const;
  const parts = counts.flatMap(([value, words]) =>
    value > 0 ? [resolve(words, { count: value, shown: count(value) })] : [],
  );
  const also = differences.alsoDiffering.map((part) => resolve(ALSO_WORDS[part]));
  return [
    parts.length > 0
      ? resolve(msg("What differs: {parts}.", { parts: parts.join(", ") }))
      : resolve(msg("The two versions have the same decisions, searches and records.")),
    also.length > 0
      ? resolve(msg("Also different: {parts}.", { parts: also.join(", ") }))
      : parts.length === 0
        ? resolve(
            msg(
              "They differ only in their history, or in the details of the sources saved with each.",
            ),
          )
        : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Which version alone has it; null when both do. */
const onlyIn = (here: unknown, other: unknown): "here" | "other" | null =>
  here !== null && other !== null ? null : here !== null ? "here" : "other";

/** What a row is about, and how the two versions stand on it. */
export function rowHeading(
  row: Row,
  resolve: MessageResolver = m,
): {
  readonly key: string;
  readonly title: string;
  readonly standing: string;
} {
  switch (row.kind) {
    case "decision": {
      const only = onlyIn(row.here, row.other);
      const stage = resolve(STAGE_WORDS[row.stage]);
      return {
        key: `decision:${row.stage}:${row.sourceId}`,
        title: row.title?.trim() || resolve(REVIEW_VERSION_LABELS.untitled),
        standing:
          only === "here"
            ? resolve(msg("Decided at {stage} in this version only", { stage }))
            : only === "other"
              ? resolve(msg("Decided at {stage} in the other version only", { stage }))
              : resolve(msg("Decided differently at {stage}", { stage })),
      };
    }
    case "search": {
      const search = (row.here ?? row.other)!;
      const only = onlyIn(row.here, row.other);
      return {
        key: `search:${search.searchId}`,
        title: search.database,
        standing:
          only === "here"
            ? resolve(msg("A search in this version only"))
            : only === "other"
              ? resolve(msg("A search in the other version only"))
              : resolve(msg("A search with different details or records")),
      };
    }
    case "record":
      return {
        key: `record:${row.sourceId}`,
        title: row.title?.trim() || resolve(REVIEW_VERSION_LABELS.untitled),
        standing:
          row.in === "here"
            ? resolve(msg("A record in this version only"))
            : resolve(msg("A record in the other version only")),
      };
  }
}

/** One version's decision on a record: the decision and reason, when, an agent's marked, the note. */
export function decisionText(side: DecisionSide, resolve: MessageResolver = m): string {
  if (!side) return "";
  return [
    [
      resolve(DECISION_LABELS[side.decision]),
      side.reason,
      reviewDate(side.decidedAt),
      side.decidedBy === "agent" ? resolve(msg("by agent")) : "",
    ]
      .filter(Boolean)
      .join(" · "),
    side.note ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * One version's entry of a search, as the review's own list words it. `only` says which version
 * alone has the records the other version's entry lacks, and is null when the other version has
 * no such entry.
 */
export function searchText(
  side: SearchSide,
  only: "here" | "other" | null,
  resolve: MessageResolver = m,
): string {
  if (!side) return "";
  const records = { count: side.records, shown: count(side.records) };
  const onlyShown = count(side.recordsOnlyThisSide);
  return [
    [
      side.database,
      side.searchedOn,
      side.resultCount === undefined
        ? ""
        : resolve(msg("{count} results", { count: count(side.resultCount) })),
      only === "here" && side.recordsOnlyThisSide > 0
        ? resolve(
            msg(
              "{count, plural, one {{shown} record} other {{shown} records}} ({onlyShown} only in this version)",
              { ...records, onlyShown },
            ),
          )
        : only === "other" && side.recordsOnlyThisSide > 0
          ? resolve(
              msg(
                "{count, plural, one {{shown} record} other {{shown} records}} ({onlyShown} only in the other version)",
                { ...records, onlyShown },
              ),
            )
          : resolve(msg("{count, plural, one {{shown} record} other {{shown} records}}", records)),
      side.loggedBy === "agent" ? resolve(msg("by agent")) : "",
    ]
      .filter(Boolean)
      .join(" · "),
    side.query,
    side.notes ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}
