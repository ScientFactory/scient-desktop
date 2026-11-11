import * as Schema from "effect/Schema";

import type { ScientSourceIdentifier } from "./model.ts";
import { normalizePersistentIdentifier } from "./normalize.ts";

const NonEmptyString = Schema.String.check(
  Schema.isTrimmed({ toJsonSchema: () => [{}, true] }),
  Schema.isNonEmpty(),
);

export const ScientSourceStudyDesign = Schema.Literals([
  "randomized-trial",
  "meta-analysis",
  "systematic-review",
  "cohort",
  "case-control",
  "case-report",
  "review",
  "other",
]);
export type ScientSourceStudyDesign = typeof ScientSourceStudyDesign.Type;

/** An arXiv category (primary or cross-list) or an OpenAlex topic with its score. */
export const ScientSourceTopic = Schema.Struct({
  scheme: Schema.Literals(["arxiv", "openalex"]),
  id: NonEmptyString,
  name: NonEmptyString,
  score: Schema.optionalKey(Schema.Number),
  primary: Schema.optionalKey(Schema.Boolean),
});
export type ScientSourceTopic = typeof ScientSourceTopic.Type;

const Terms = Schema.Array(Schema.String).pipe(Schema.check(Schema.isMaxLength(64)));

/**
 * Registry categories for one source, kept apart from its record so a lookup never makes a
 * revision. `basis` names the identifiers they were looked up by; when the record's identifiers
 * change, the entry no longer applies and is looked up again.
 */
export const ScientSourceCategories = Schema.Struct({
  basis: NonEmptyString,
  checkedAt: NonEmptyString,
  pmid: Schema.optionalKey(NonEmptyString),
  studyDesign: Schema.optionalKey(ScientSourceStudyDesign),
  /** PubMed publication types as PubMed names them. */
  publicationTypes: Schema.optionalKey(Terms),
  /** The study-design MeSH headings PubMed indexed the paper under. */
  designHeadings: Schema.optionalKey(Terms),
  topics: Schema.optionalKey(
    Schema.Array(ScientSourceTopic).pipe(Schema.check(Schema.isMaxLength(32))),
  ),
  /** A registry could not be reached; the lookup is tried again after this time. */
  retryAfter: Schema.optionalKey(NonEmptyString),
});
export type ScientSourceCategories = typeof ScientSourceCategories.Type;

export const ScientSourceCategoriesDocument = Schema.Struct({
  formatVersion: Schema.Literal(1),
  sources: Schema.Record(Schema.String, ScientSourceCategories),
});
export type ScientSourceCategoriesDocument = typeof ScientSourceCategoriesDocument.Type;

/** What lists show and filter on. */
export const ScientSourceCategorySummary = Schema.Struct({
  studyDesign: Schema.optionalKey(ScientSourceStudyDesign),
  topics: Schema.optionalKey(
    Schema.Array(Schema.Struct({ scheme: ScientSourceTopic.fields.scheme, name: NonEmptyString })),
  ),
});
export type ScientSourceCategorySummary = typeof ScientSourceCategorySummary.Type;

const BASIS_SCHEMES = new Set(["doi", "pmid", "arxiv", "openalex"]);

/** The identifiers categories are looked up by, or null when a source has none of them. */
export function scientSourceCategoryBasis(
  identifiers: ReadonlyArray<ScientSourceIdentifier>,
): string | null {
  const keys = [
    ...new Set(
      identifiers.flatMap((identifier) => {
        const scheme = identifier.scheme.trim().toLowerCase();
        return BASIS_SCHEMES.has(scheme) && identifier.value.trim()
          ? [normalizePersistentIdentifier(scheme, identifier.value)]
          : [];
      }),
    ),
  ].toSorted();
  return keys.length > 0 ? keys.join("|") : null;
}

export function scientSourceCategorySummary(
  categories: ScientSourceCategories | undefined,
): ScientSourceCategorySummary | null {
  if (!categories) return null;
  const topics = (categories.topics ?? []).map(({ scheme, name }) => ({ scheme, name }));
  if (!categories.studyDesign && topics.length === 0) return null;
  return {
    ...(categories.studyDesign ? { studyDesign: categories.studyDesign } : {}),
    ...(topics.length > 0 ? { topics } : {}),
  };
}

const PUBLICATION_TYPE_DESIGNS: ReadonlyArray<readonly [ScientSourceStudyDesign, RegExp]> = [
  ["meta-analysis", /^meta-analysis$/iu],
  ["systematic-review", /^systematic review$/iu],
  [
    "randomized-trial",
    /^(?:randomized controlled trial|equivalence trial|pragmatic clinical trial)/iu,
  ],
  ["case-report", /^case reports$/iu],
  ["review", /^(?:review|scoping review)$/iu],
];

const HEADING_DESIGNS: ReadonlyArray<readonly [ScientSourceStudyDesign, RegExp]> = [
  ["case-control", /^case-control studies$/iu],
  ["cohort", /^(?:cohort|prospective|retrospective|longitudinal) studies$/iu],
];

/** The MeSH headings that name a study design, of all those PubMed indexed a paper under. */
export function isStudyDesignHeading(heading: string): boolean {
  return HEADING_DESIGNS.some(([, pattern]) => pattern.test(heading.trim()));
}

/**
 * PubMed's publication types decide first, as they describe the paper itself; MeSH design
 * headings (cohort, case-control) only when no type does, as on a review they describe the
 * studies reviewed.
 */
export function studyDesignFromPubmed(
  publicationTypes: ReadonlyArray<string>,
  headings: ReadonlyArray<string>,
): ScientSourceStudyDesign {
  for (const [design, pattern] of PUBLICATION_TYPE_DESIGNS) {
    if (publicationTypes.some((type) => pattern.test(type.trim()))) return design;
  }
  for (const [design, pattern] of HEADING_DESIGNS) {
    if (headings.some((heading) => pattern.test(heading.trim()))) return design;
  }
  return "other";
}

export function scientSourceTopicKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/** Study design and topic counts across the Library, most common first. */
export function scientSourceCategoryCounts(
  sources: ReadonlyArray<{ readonly categories?: ScientSourceCategorySummary | undefined }>,
): {
  readonly studyDesigns: ReadonlyArray<{
    readonly studyDesign: ScientSourceStudyDesign;
    readonly count: number;
  }>;
  readonly topics: ReadonlyArray<{ readonly topic: string; readonly count: number }>;
} {
  const designs = new Map<ScientSourceStudyDesign, number>();
  const topics = new Map<string, { topic: string; count: number }>();
  for (const source of sources) {
    const design = source.categories?.studyDesign;
    if (design) designs.set(design, (designs.get(design) ?? 0) + 1);
    const seen = new Set<string>();
    for (const topic of source.categories?.topics ?? []) {
      const key = scientSourceTopicKey(topic.name);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = topics.get(key);
      if (entry) entry.count += 1;
      else topics.set(key, { topic: topic.name, count: 1 });
    }
  }
  return {
    studyDesigns: [...designs]
      .map(([studyDesign, count]) => ({ studyDesign, count }))
      .toSorted((left, right) => right.count - left.count),
    topics: [...topics.values()].toSorted(
      (left, right) =>
        right.count - left.count ||
        left.topic.localeCompare(right.topic, undefined, { sensitivity: "base" }),
    ),
  };
}
