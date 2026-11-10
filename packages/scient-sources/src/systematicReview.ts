import * as Schema from "effect/Schema";

import { ScientSourceActor, type ScientSourceCreator } from "./model.ts";

const NonEmptyString = Schema.String.check(
  Schema.isTrimmed({ toJsonSchema: () => [{}, true] }),
  Schema.isNonEmpty(),
);
const Name = NonEmptyString.check(Schema.isMaxLength(200));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const SourceIds = Schema.Array(NonEmptyString).pipe(Schema.check(Schema.isMaxLength(20_000)));
const BatchSourceIds = Schema.Array(NonEmptyString).pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
);
const Reason = NonEmptyString.check(Schema.isMaxLength(500));

export const ScientReviewStage = Schema.Literals(["title-abstract", "full-text"]);
export type ScientReviewStage = typeof ScientReviewStage.Type;

export const ScientReviewDecision = Schema.Literals(["include", "exclude", "maybe"]);
export type ScientReviewDecision = typeof ScientReviewDecision.Type;

export const ScientReviewSearch = Schema.Struct({
  searchId: NonEmptyString,
  database: Name,
  query: Schema.String.check(Schema.isMaxLength(10_000)),
  searchedOn: NonEmptyString.check(Schema.isMaxLength(40)),
  // What the database reported; sourceIds are the records brought into the Library from it.
  resultCount: Schema.optionalKey(Count),
  notes: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
  sourceIds: SourceIds,
  loggedAt: NonEmptyString,
  loggedBy: ScientSourceActor,
});
export type ScientReviewSearch = typeof ScientReviewSearch.Type;

export const ScientReviewScreening = Schema.Struct({
  sourceId: NonEmptyString,
  stage: ScientReviewStage,
  decision: ScientReviewDecision,
  reason: Schema.optionalKey(Reason),
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
  decidedAt: NonEmptyString,
  decidedBy: ScientSourceActor,
});
export type ScientReviewScreening = typeof ScientReviewScreening.Type;

export const ScientSystematicReview = Schema.Struct({
  formatVersion: Schema.Literal(1),
  reviewId: NonEmptyString,
  title: Name,
  question: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
  createdAt: NonEmptyString,
  updatedAt: NonEmptyString,
  updatedBy: ScientSourceActor,
  deletedAt: Schema.optionalKey(NonEmptyString),
  searches: Schema.Array(ScientReviewSearch),
  // Records found another way (citation chasing, a colleague, a website).
  otherSourceIds: SourceIds,
  duplicates: Schema.Array(
    Schema.Struct({
      sourceId: NonEmptyString,
      duplicateOf: NonEmptyString,
      decidedAt: NonEmptyString,
      decidedBy: ScientSourceActor,
    }),
  ),
  distinctPairs: Schema.Array(Schema.Tuple([NonEmptyString, NonEmptyString])),
  // Append-only; the latest entry per source and stage is the decision in force.
  screening: Schema.Array(ScientReviewScreening),
  exclusionReasons: Schema.Array(Reason).pipe(Schema.check(Schema.isMaxLength(50))),
});
export type ScientSystematicReview = typeof ScientSystematicReview.Type;

export const SCIENT_REVIEW_DEFAULT_EXCLUSION_REASONS = [
  "Wrong population",
  "Wrong intervention",
  "Wrong comparator",
  "Wrong outcome",
  "Wrong study design",
  "Not primary research",
  "Full text not available",
] as const;

const DecisionEntry = Schema.Struct({
  sourceId: NonEmptyString,
  decision: ScientReviewDecision,
  reason: Schema.optionalKey(Reason),
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
});

/** Every change to a review, the same for people and agents. */
export const ScientSystematicReviewAction = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("create-review"),
    title: Name,
    question: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
  }),
  Schema.Struct({
    action: Schema.Literal("update-review"),
    reviewId: NonEmptyString,
    title: Schema.optionalKey(Name),
    question: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
    exclusionReasons: Schema.optionalKey(
      Schema.Array(Reason).pipe(Schema.check(Schema.isMaxLength(50))),
    ),
  }),
  Schema.Struct({ action: Schema.Literal("delete-review"), reviewId: NonEmptyString }),
  Schema.Struct({ action: Schema.Literal("restore-review"), reviewId: NonEmptyString }),
  Schema.Struct({
    action: Schema.Literal("log-search"),
    reviewId: NonEmptyString,
    database: Name,
    query: Schema.String.check(Schema.isMaxLength(10_000)),
    searchedOn: NonEmptyString.check(Schema.isMaxLength(40)),
    resultCount: Schema.optionalKey(Count),
    notes: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
    sourceIds: Schema.optionalKey(SourceIds),
    collectionId: Schema.optionalKey(NonEmptyString),
  }),
  Schema.Struct({
    action: Schema.Literal("remove-search"),
    reviewId: NonEmptyString,
    searchId: NonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("add-sources"),
    reviewId: NonEmptyString,
    sourceIds: BatchSourceIds,
  }),
  Schema.Struct({
    action: Schema.Literal("remove-sources"),
    reviewId: NonEmptyString,
    sourceIds: BatchSourceIds,
  }),
  Schema.Struct({
    action: Schema.Literal("mark-duplicate"),
    reviewId: NonEmptyString,
    sourceId: NonEmptyString,
    duplicateOf: NonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("unmark-duplicate"),
    reviewId: NonEmptyString,
    sourceId: NonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("mark-distinct"),
    reviewId: NonEmptyString,
    sourceIds: Schema.Tuple([NonEmptyString, NonEmptyString]),
  }),
  Schema.Struct({
    action: Schema.Literal("screen"),
    reviewId: NonEmptyString,
    stage: ScientReviewStage,
    decisions: Schema.Array(DecisionEntry).pipe(
      Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("clear-decision"),
    reviewId: NonEmptyString,
    stage: ScientReviewStage,
    sourceId: NonEmptyString,
  }),
]);
export type ScientSystematicReviewAction = typeof ScientSystematicReviewAction.Type;

export const ScientPrismaCounts = Schema.Struct({
  identified: Schema.Struct({
    databases: Count,
    byDatabase: Schema.Array(Schema.Struct({ database: Schema.String, count: Count })),
    otherMethods: Count,
  }),
  removedBeforeScreening: Schema.Struct({ duplicates: Count, other: Count }),
  screened: Count,
  titleAbstract: Schema.Struct({
    included: Count,
    excluded: Count,
    maybe: Count,
    pending: Count,
  }),
  fullText: Schema.Struct({
    assessed: Count,
    excluded: Count,
    excludedByReason: Schema.Array(Schema.Struct({ reason: Schema.String, count: Count })),
    maybe: Count,
    pending: Count,
  }),
  included: Count,
});
export type ScientPrismaCounts = typeof ScientPrismaCounts.Type;

export const ScientSystematicReviewSummary = Schema.Struct({
  reviewId: NonEmptyString,
  title: Name,
  question: Schema.optionalKey(Schema.String),
  updatedAt: NonEmptyString,
  updatedBy: ScientSourceActor,
  searchCount: Count,
  prisma: ScientPrismaCounts,
});
export type ScientSystematicReviewSummary = typeof ScientSystematicReviewSummary.Type;

export const ScientSystematicReviewDetail = Schema.Struct({
  review: ScientSystematicReview,
  prisma: ScientPrismaCounts,
  mermaid: Schema.String,
  possibleDuplicates: Schema.Array(Schema.Tuple([NonEmptyString, NonEmptyString])),
  screeningSourceIds: Schema.Array(NonEmptyString),
});
export type ScientSystematicReviewDetail = typeof ScientSystematicReviewDetail.Type;

export const ScientSystematicReviewList = Schema.Struct({
  reviews: Schema.Array(ScientSystematicReviewSummary),
  issues: Schema.Array(Schema.String),
});
export type ScientSystematicReviewList = typeof ScientSystematicReviewList.Type;

export const ScientSystematicReviewChangeResult = Schema.Struct({
  outcome: Schema.Literals(["created", "updated", "unchanged", "deleted", "restored", "not-found"]),
  reviewId: Schema.NullOr(NonEmptyString),
  // Ids the change named that are not in the Library, or not in this review, and were skipped.
  skippedSourceIds: Schema.optionalKey(Schema.Array(NonEmptyString)),
  searchId: Schema.optionalKey(NonEmptyString),
  message: Schema.optionalKey(Schema.String),
});
export type ScientSystematicReviewChangeResult = typeof ScientSystematicReviewChangeResult.Type;

export interface ScientReviewSourceFacts {
  readonly sourceId: string;
  readonly title: string | null;
  readonly creators: ReadonlyArray<ScientSourceCreator>;
  readonly issuedYear: number | null;
}

export function scientReviewRecordIds(review: ScientSystematicReview): ReadonlyArray<string> {
  return [
    ...new Set([
      ...review.searches.flatMap((search) => search.sourceIds),
      ...review.otherSourceIds,
    ]),
  ];
}

/** The decision in force for each source at one stage. */
export function scientReviewDecisions(
  review: ScientSystematicReview,
  stage: ScientReviewStage,
): ReadonlyMap<string, ScientReviewScreening> {
  const decisions = new Map<string, ScientReviewScreening>();
  for (const entry of review.screening) {
    if (entry.stage === stage) decisions.set(entry.sourceId, entry);
  }
  return decisions;
}

/**
 * Records that reach title and abstract screening: in the review, still in the Library and not
 * marked as a duplicate of another record.
 */
export function scientReviewScreeningIds(
  review: ScientSystematicReview,
  presentSourceIds: ReadonlySet<string>,
): ReadonlyArray<string> {
  const duplicates = new Set(review.duplicates.map((entry) => entry.sourceId));
  return scientReviewRecordIds(review).filter(
    (sourceId) => presentSourceIds.has(sourceId) && !duplicates.has(sourceId),
  );
}

/** Records waiting for a decision at a stage, in the order they entered the review. */
export function scientReviewPendingIds(
  review: ScientSystematicReview,
  stage: ScientReviewStage,
  presentSourceIds: ReadonlySet<string>,
): ReadonlyArray<string> {
  const screening = scientReviewScreeningIds(review, presentSourceIds);
  const decided = scientReviewDecisions(review, stage);
  if (stage === "title-abstract") return screening.filter((sourceId) => !decided.has(sourceId));
  const titleAbstract = scientReviewDecisions(review, "title-abstract");
  return screening.filter(
    (sourceId) => titleAbstract.get(sourceId)?.decision === "include" && !decided.has(sourceId),
  );
}

/** PRISMA 2020 flow counts. Duplicates the Library merged on import count as removed duplicates. */
export function scientPrismaCounts(
  review: ScientSystematicReview,
  presentSourceIds: ReadonlySet<string>,
): ScientPrismaCounts {
  const byDatabase = new Map<string, number>();
  let notBroughtIn = 0;
  let searchRecordCount = 0;
  for (const search of review.searches) {
    const found = search.resultCount ?? search.sourceIds.length;
    byDatabase.set(search.database, (byDatabase.get(search.database) ?? 0) + found);
    notBroughtIn += Math.max(0, found - search.sourceIds.length);
    searchRecordCount += search.sourceIds.length;
  }
  const fromSearches = new Set(review.searches.flatMap((search) => search.sourceIds));
  const otherOnly = [...new Set(review.otherSourceIds)].filter((id) => !fromSearches.has(id));
  const records = scientReviewRecordIds(review);
  const markedDuplicates = new Set(
    review.duplicates
      .map((entry) => entry.sourceId)
      .filter((sourceId) => records.includes(sourceId)),
  );
  const missing = records.filter(
    (sourceId) => !presentSourceIds.has(sourceId) && !markedDuplicates.has(sourceId),
  ).length;
  const screening = scientReviewScreeningIds(review, presentSourceIds);
  const titleAbstract = scientReviewDecisions(review, "title-abstract");
  const fullText = scientReviewDecisions(review, "full-text");
  const count = (
    decisions: ReadonlyMap<string, ScientReviewScreening>,
    ids: ReadonlyArray<string>,
    decision: ScientReviewDecision,
  ) => ids.filter((sourceId) => decisions.get(sourceId)?.decision === decision).length;
  const assessed = screening.filter(
    (sourceId) => titleAbstract.get(sourceId)?.decision === "include",
  );
  const reasons = new Map<string, number>();
  for (const sourceId of assessed) {
    const entry = fullText.get(sourceId);
    if (entry?.decision !== "exclude") continue;
    const reason = entry.reason ?? "No reason given";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  return {
    identified: {
      databases: [...byDatabase.values()].reduce((total, value) => total + value, 0),
      byDatabase: [...byDatabase].map(([database, value]) => ({ database, count: value })),
      otherMethods: otherOnly.length,
    },
    removedBeforeScreening: {
      duplicates: searchRecordCount - fromSearches.size + markedDuplicates.size,
      other: notBroughtIn + missing,
    },
    screened: screening.length,
    titleAbstract: {
      included: assessed.length,
      excluded: count(titleAbstract, screening, "exclude"),
      maybe: count(titleAbstract, screening, "maybe"),
      pending: screening.filter((sourceId) => !titleAbstract.has(sourceId)).length,
    },
    fullText: {
      assessed: assessed.length,
      excluded: count(fullText, assessed, "exclude"),
      excludedByReason: [...reasons]
        .map(([reason, value]) => ({ reason, count: value }))
        .toSorted((left, right) => right.count - left.count),
      maybe: count(fullText, assessed, "maybe"),
      pending: assessed.filter((sourceId) => !fullText.has(sourceId)).length,
    },
    included: count(fullText, assessed, "include"),
  };
}

function titleKey(title: string | null): string | null {
  const key = (title ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return key.length >= 12 ? key : null;
}

/**
 * Pairs that may be the same work: the same normalized title. Year and authors may differ, as
 * between a preprint and its article. Pairs already decided either way are left out.
 */
export function scientReviewPossibleDuplicates(
  review: ScientSystematicReview,
  sources: ReadonlyArray<ScientReviewSourceFacts>,
): ReadonlyArray<readonly [string, string]> {
  const order = new Map(scientReviewRecordIds(review).map((sourceId, index) => [sourceId, index]));
  const marked = new Set(review.duplicates.map((entry) => entry.sourceId));
  const distinct = new Set(review.distinctPairs.map((pair) => pair.toSorted().join("\0")));
  const byTitle = new Map<string, string[]>();
  // In the order records entered the review, so the earlier record comes first in a pair.
  const ordered = sources
    .filter((source) => order.has(source.sourceId))
    .toSorted((left, right) => order.get(left.sourceId)! - order.get(right.sourceId)!);
  for (const source of ordered) {
    if (marked.has(source.sourceId)) continue;
    const key = titleKey(source.title);
    if (!key) continue;
    byTitle.set(key, [...(byTitle.get(key) ?? []), source.sourceId]);
  }
  const pairs: Array<readonly [string, string]> = [];
  for (const group of byTitle.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const pair = [group[left]!, group[right]!] as const;
        if (!distinct.has([...pair].toSorted().join("\0"))) pairs.push(pair);
      }
    }
  }
  return pairs;
}

function mermaidLabel(lines: ReadonlyArray<string>): string {
  return `"${lines.map((line) => line.replaceAll('"', "'")).join("<br/>")}"`;
}

/** A PRISMA 2020 flow diagram as Mermaid, for documents and agents. */
export function scientPrismaMermaid(prisma: ScientPrismaCounts): string {
  const databases = prisma.identified.byDatabase.map(
    (entry) => `${entry.database} (n = ${entry.count})`,
  );
  const reasons = prisma.fullText.excludedByReason.map(
    (entry) => `${entry.reason} (n = ${entry.count})`,
  );
  return [
    "flowchart TD",
    `  identified[${mermaidLabel([
      `Records identified from databases (n = ${prisma.identified.databases})`,
      ...databases,
      ...(prisma.identified.otherMethods > 0
        ? [`Records from other methods (n = ${prisma.identified.otherMethods})`]
        : []),
    ])}]`,
    `  removed[${mermaidLabel([
      "Records removed before screening:",
      `Duplicates (n = ${prisma.removedBeforeScreening.duplicates})`,
      `Other reasons (n = ${prisma.removedBeforeScreening.other})`,
    ])}]`,
    `  screened[${mermaidLabel([`Records screened (n = ${prisma.screened})`])}]`,
    `  excludedTa[${mermaidLabel([
      `Records excluded (n = ${prisma.titleAbstract.excluded})`,
      ...(prisma.titleAbstract.pending + prisma.titleAbstract.maybe > 0
        ? [`Awaiting decision (n = ${prisma.titleAbstract.pending + prisma.titleAbstract.maybe})`]
        : []),
    ])}]`,
    `  assessed[${mermaidLabel([`Reports assessed for eligibility (n = ${prisma.fullText.assessed})`])}]`,
    `  excludedFt[${mermaidLabel([
      `Reports excluded (n = ${prisma.fullText.excluded})`,
      ...reasons,
      ...(prisma.fullText.pending + prisma.fullText.maybe > 0
        ? [`Awaiting decision (n = ${prisma.fullText.pending + prisma.fullText.maybe})`]
        : []),
    ])}]`,
    `  included[${mermaidLabel([`Studies included in review (n = ${prisma.included})`])}]`,
    "  identified --> removed",
    "  identified --> screened",
    "  screened --> excludedTa",
    "  screened --> assessed",
    "  assessed --> excludedFt",
    "  assessed --> included",
  ].join("\n");
}
