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

function searchableSourceText(source: SourceSummary): string {
  return [
    source.title,
    source.containerTitle,
    source.issuedYear === null ? null : String(source.issuedYear),
    ...source.creators.flatMap((creator) => [
      creator.givenName,
      creator.familyName,
      creator.literalName,
    ]),
    ...source.identifiers.flatMap((identifier) => [
      identifier.scheme,
      identifier.value,
      ...(identifier.scheme.toLocaleLowerCase() === "doi"
        ? [`https://doi.org/${identifier.value}`, `https://dx.doi.org/${identifier.value}`]
        : []),
    ]),
    ...source.externalReferences.flatMap((reference) => [
      reference.system,
      reference.itemKey,
      reference.rawItemType,
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLocaleLowerCase();
}

export function indexScientSourceSummaries(
  sources: ReadonlyArray<SourceSummary>,
): ReadonlyArray<ScientSourceSearchEntry> {
  return sources.map((source) => ({ source, searchable: searchableSourceText(source) }));
}

export function filterScientSourceSearchIndex(
  entries: ReadonlyArray<ScientSourceSearchEntry>,
  query: string,
): ReadonlyArray<SourceSummary> {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return entries.map((entry) => entry.source);
  return entries
    .filter((entry) => terms.every((term) => entry.searchable.includes(term)))
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
