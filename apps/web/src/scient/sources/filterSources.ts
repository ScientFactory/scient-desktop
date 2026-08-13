import type { ScientSourcesOverviewResult } from "@t3tools/contracts";

type SourceSummary = ScientSourcesOverviewResult["records"][number];

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
    ...source.identifiers.flatMap((identifier) => [identifier.scheme, identifier.value]),
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
