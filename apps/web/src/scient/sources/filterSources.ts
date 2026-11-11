import {
  compileScientSourceFilter,
  scientSourceSearchText,
  type ScientSourceFilter,
  type ScientSourcesOrganization,
} from "@scientfactory/scient-sources";
import type { ScientSourcesOverviewResult } from "@t3tools/contracts";

type SourceSummary = ScientSourcesOverviewResult["records"][number];

export const SCIENT_SOURCE_SORT_OPTIONS = [
  { value: "last-added", label: "Last added" },
  { value: "publication-year", label: "Publication year" },
  { value: "title", label: "Title" },
  { value: "author", label: "Author" },
] as const;

export type ScientSourceSort = (typeof SCIENT_SOURCE_SORT_OPTIONS)[number]["value"];

export interface ScientSourceSearchEntry {
  readonly source: SourceSummary;
  readonly searchable: string;
}

export function indexScientSourceSummaries(
  sources: ReadonlyArray<SourceSummary>,
): ReadonlyArray<ScientSourceSearchEntry> {
  return sources.map((source) => ({ source, searchable: scientSourceSearchText(source) }));
}

export function filterScientSourceSearchIndex(
  entries: ReadonlyArray<ScientSourceSearchEntry>,
  query: string,
  filter: ScientSourceFilter = {},
  organization: Pick<ScientSourcesOrganization, "collections"> = { collections: [] },
): ReadonlyArray<SourceSummary> {
  const matches = compileScientSourceFilter({ ...filter, text: query }, organization);
  return entries
    .filter((entry) => matches(entry.source, entry.searchable))
    .map((entry) => entry.source);
}

function compareText(left: string | null, right: string | null): number {
  return (left ?? "").localeCompare(right ?? "", undefined, { sensitivity: "base" });
}

function compareNullableNumber(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

function sourceAuthor(source: SourceSummary): string | null {
  const creator = source.creators[0];
  return creator?.familyName ?? creator?.literalName ?? creator?.givenName ?? null;
}

export function sortScientSourceRecords(
  sources: ReadonlyArray<SourceSummary>,
  sort: ScientSourceSort,
): ReadonlyArray<SourceSummary> {
  return sources.toSorted((left, right) => {
    const comparison =
      sort === "publication-year"
        ? compareNullableNumber(left.issuedYear, right.issuedYear)
        : sort === "title"
          ? compareText(left.title, right.title)
          : sort === "author"
            ? compareText(sourceAuthor(left), sourceAuthor(right))
            : compareText(right.importedAt, left.importedAt);
    if (comparison !== 0) return comparison;

    const titleComparison = compareText(left.title, right.title);
    if (titleComparison !== 0) return titleComparison;
    return left.sourceId.localeCompare(right.sourceId);
  });
}
