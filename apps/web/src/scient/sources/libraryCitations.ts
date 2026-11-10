import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedSearchResult,
} from "@t3tools/shared/searchRanking";

/** One Library source a document can cite by its key. */
export interface LibraryCitationCandidate {
  readonly sourceId: string;
  readonly citationKey: string;
  /** Lead creator and year, e.g. "Lovelace 1843". */
  readonly label: string;
  readonly title: string | null;
}

const MENU_LIMIT = 8;

export function libraryCitationCandidates(
  records: ScientSourcesOverviewResult["records"],
): ReadonlyArray<LibraryCitationCandidate> {
  return records.flatMap((record) => {
    if (!record.citationKey) return [];
    const creator = record.creators[0];
    const name = creator?.familyName ?? creator?.literalName ?? creator?.givenName ?? null;
    const label = [name, record.issuedYear].filter((part) => part !== null).join(" ");
    return [
      {
        sourceId: record.sourceId,
        citationKey: record.citationKey,
        label: label || record.citationKey,
        title: record.title,
      },
    ];
  });
}

function score(candidate: LibraryCitationCandidate, query: string): number | null {
  const scores = [
    scoreQueryMatch({
      value: normalizeSearchQuery(candidate.citationKey),
      query,
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 30,
      includesBase: 50,
      fuzzyBase: 90,
    }),
    scoreQueryMatch({
      value: normalizeSearchQuery(candidate.label),
      query,
      exactBase: 5,
      prefixBase: 15,
      boundaryBase: 35,
      includesBase: 55,
    }),
    scoreQueryMatch({
      value: normalizeSearchQuery(candidate.title ?? ""),
      query,
      exactBase: 20,
      prefixBase: 40,
      boundaryBase: 60,
      includesBase: 80,
    }),
  ].filter((value): value is number => value !== null);
  return scores.length > 0 ? Math.min(...scores) : null;
}

/** Best matches for what follows `[@`, by key, then author and year, then title. */
export function filterLibraryCitations(
  candidates: ReadonlyArray<LibraryCitationCandidate>,
  query: string,
  limit = MENU_LIMIT,
): ReadonlyArray<LibraryCitationCandidate> {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return candidates.slice(0, limit);
  const ranked: Array<RankedSearchResult<LibraryCitationCandidate>> = [];
  for (const candidate of candidates) {
    const value = score(candidate, normalized);
    if (value === null) continue;
    insertRankedSearchResult(
      ranked,
      { item: candidate, score: value, tieBreaker: candidate.citationKey },
      limit,
    );
  }
  return ranked.map(({ item }) => item);
}

/** The keys named by a Pandoc citation group such as `@a, p. 4; -@b`. */
export function citationGroupKeys(source: string): ReadonlyArray<string> {
  return [...source.matchAll(/(?:^|[\s;[-])@([\p{L}\p{N}_](?:[\p{L}\p{N}_:.#-]*[\p{L}\p{N}_])?)/gu)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
}

/** Library sources for the LaTeX citation dialog, after the document's own .bib entries. */
export function libraryLatexCitationChoices(
  candidates: ReadonlyArray<LibraryCitationCandidate>,
  bibliographyKeys: ReadonlySet<string>,
): ReadonlyArray<{
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly command: "cite";
}> {
  return candidates.flatMap((candidate) =>
    bibliographyKeys.has(candidate.citationKey)
      ? []
      : [
          {
            key: candidate.citationKey,
            title: candidate.title ?? candidate.label,
            detail: `${candidate.label} · Library`,
            command: "cite" as const,
          },
        ],
  );
}
