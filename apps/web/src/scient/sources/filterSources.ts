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
  { value: "journal", label: "Journal" },
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

// One collator: `localeCompare` with options builds one per call, 0.5 s per sort of 20,000 rows.
const textCollator = new Intl.Collator(undefined, { sensitivity: "base" });

/** Equal for the sort is the same section: case and accents aside. */
export function sameScientSourceText(left: string, right: string): boolean {
  return textCollator.compare(left, right) === 0;
}

/** Numbers newest first, text A–Z; null last. */
function compareSortKeys(left: number | string | null, right: number | string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return typeof left === "number" && typeof right === "number"
    ? right - left
    : textCollator.compare(String(left), String(right));
}

export function scientSourceJournal(source: SourceSummary): string | null {
  return source.containerTitle?.trim() || null;
}

/** When the source was added, in epoch milliseconds; null when its date cannot be read. */
export function scientSourceAddedTime(source: SourceSummary): number | null {
  const time = Date.parse(source.importedAt);
  return Number.isNaN(time) ? null : time;
}

function sortKey(source: SourceSummary, sort: ScientSourceSort): number | string | null {
  switch (sort) {
    case "last-added":
      return scientSourceAddedTime(source);
    case "publication-year":
      return source.issuedYear;
    case "journal":
      return scientSourceJournal(source);
    case "title":
      return source.title ?? "";
    case "author": {
      const creator = source.creators[0];
      return creator?.familyName ?? creator?.literalName ?? creator?.givenName ?? "";
    }
  }
}

/** A source without the sorted value goes last; title, then source ID, break ties. */
export function sortScientSourceRecords(
  sources: ReadonlyArray<SourceSummary>,
  sort: ScientSourceSort,
): ReadonlyArray<SourceSummary> {
  return sources
    .map((source) => ({ source, key: sortKey(source, sort) }))
    .sort((left, right) => {
      const comparison = compareSortKeys(left.key, right.key);
      if (comparison !== 0) return comparison;
      const titleComparison = textCollator.compare(
        left.source.title ?? "",
        right.source.title ?? "",
      );
      if (titleComparison !== 0) return titleComparison;
      return left.source.sourceId.localeCompare(right.source.sourceId);
    })
    .map((entry) => entry.source);
}
