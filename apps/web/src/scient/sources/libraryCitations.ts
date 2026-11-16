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
  /** The source's first PDF; absent when it has none, or for an entry that is no Library source. */
  readonly pdf?: { readonly attachmentId: string; readonly fileName: string };
  /**
   * Another of this project's keys for the source, kept after a merge (`alsoCitedAs`): a citation
   * using it opens the source, but a new citation is offered only the source's first key.
   */
  readonly alias?: true;
}

const MENU_LIMIT = 8;

/** Every key this project cites a Library source by: its first key and each one kept after a merge. */
export function libraryCitationCandidates(
  records: ScientSourcesOverviewResult["records"],
): ReadonlyArray<LibraryCitationCandidate> {
  return records.flatMap((record) => {
    if (!record.citationKey) return [];
    const creator = record.creators[0];
    const name = creator?.familyName ?? creator?.literalName ?? creator?.givenName ?? null;
    const label = [name, record.issuedYear].filter((part) => part !== null).join(" ");
    const pdf = record.attachments.find((attachment) => attachment.kind === "pdf");
    const candidate: LibraryCitationCandidate = {
      sourceId: record.sourceId,
      citationKey: record.citationKey,
      label: label || record.citationKey,
      title: record.title,
      ...(pdf ? { pdf: { attachmentId: pdf.attachmentId, fileName: pdf.fileName } } : {}),
    };
    const aliases = new Set(record.alsoCitedAs ?? []);
    aliases.delete(record.citationKey);
    return [
      candidate,
      ...[...aliases].map((key) => ({ ...candidate, citationKey: key, alias: true as const })),
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

/** Best matches for what follows `[@`, by key, then author and year, then title; first keys only. */
export function filterLibraryCitations(
  candidates: ReadonlyArray<LibraryCitationCandidate>,
  query: string,
  limit = MENU_LIMIT,
): ReadonlyArray<LibraryCitationCandidate> {
  const offered = candidates.filter((candidate) => !candidate.alias);
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return offered.slice(0, limit);
  const ranked: Array<RankedSearchResult<LibraryCitationCandidate>> = [];
  for (const candidate of offered) {
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

/** Said where a Library source is offered to a document that does not load the managed file. */
export const LIBRARY_BIBLIOGRAPHY_HINT =
  "Add \\bibliography{references} to this document so LaTeX finds Library sources.";

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
    candidate.alias || bibliographyKeys.has(candidate.citationKey)
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
