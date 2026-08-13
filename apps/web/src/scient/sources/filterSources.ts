import type { ScientSourcesOverviewResult } from "@t3tools/contracts";

type SourceSummary = ScientSourcesOverviewResult["records"][number];

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

export function filterScientSourceSummaries(
  sources: ReadonlyArray<SourceSummary>,
  query: string,
): ReadonlyArray<SourceSummary> {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return sources;
  return sources.filter((source) => {
    const searchable = searchableSourceText(source);
    return terms.every((term) => searchable.includes(term));
  });
}
