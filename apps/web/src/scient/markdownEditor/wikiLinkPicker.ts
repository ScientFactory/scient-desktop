import {
  compareRankedSearchResults,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedSearchResult,
} from "@t3tools/shared/searchRanking";
import * as Schema from "effect/Schema";

export const WIKI_LINK_RECENT_LIMIT = 6;
export const WIKI_LINK_PICKER_RESULT_LIMIT = 50;

export const WikiLinkRecentPaths = Schema.Array(Schema.String);

export interface ScientMarkdownWikiLinkCandidate {
  readonly path: string;
  readonly target: string;
}

export interface ScientMarkdownWikiLinkPickerSections {
  readonly recent: ReadonlyArray<ScientMarkdownWikiLinkCandidate>;
  readonly results: ReadonlyArray<ScientMarkdownWikiLinkCandidate>;
}

export const EMPTY_WIKI_LINK_CANDIDATES: ReadonlyArray<ScientMarkdownWikiLinkCandidate> = [];
export const EMPTY_WIKI_LINK_RECENT_PATHS: ReadonlyArray<string> = [];

export function wikiLinkRecentsStorageKey(environmentId: string, cwd: string): string {
  return `scient-next:markdown-wiki-link-recents:v1:${encodeURIComponent(environmentId)}:${encodeURIComponent(cwd)}`;
}

function normalizeProjectMarkdownPath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.length > 512 ||
    normalized.startsWith("/") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    !normalized.toLocaleLowerCase().endsWith(".md")
  ) {
    return null;
  }
  return normalized;
}

/** Promote one successfully linked project file into a bounded MRU list. */
export function promoteRecentWikiLinkPath(
  paths: ReadonlyArray<string>,
  selectedPath: string,
): ReadonlyArray<string> {
  const selected = normalizeProjectMarkdownPath(selectedPath);
  if (selected === null) return sanitizeRecentWikiLinkPaths(paths);
  return [
    selected,
    ...sanitizeRecentWikiLinkPaths(paths).filter((path) => path !== selected),
  ].slice(0, WIKI_LINK_RECENT_LIMIT);
}

/** Treat persisted recents as untrusted and keep only canonical, unique paths. */
export function sanitizeRecentWikiLinkPaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeProjectMarkdownPath(path);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length === WIKI_LINK_RECENT_LIMIT) break;
  }
  return result;
}

export function wikiLinkCandidateName(candidate: ScientMarkdownWikiLinkCandidate): string {
  return candidate.path.slice(candidate.path.lastIndexOf("/") + 1).replace(/\.md$/iu, "");
}

function candidateSearchScore(
  candidate: ScientMarkdownWikiLinkCandidate,
  query: string,
): number | null {
  const name = normalizeSearchQuery(wikiLinkCandidateName(candidate));
  const path = normalizeSearchQuery(candidate.path);
  const nameScore = scoreQueryMatch({
    value: name,
    query,
    exactBase: 0,
    prefixBase: 20,
    boundaryBase: 40,
    includesBase: 60,
    fuzzyBase: 100,
  });
  const pathScore = scoreQueryMatch({
    value: path,
    query,
    exactBase: 10,
    prefixBase: 30,
    boundaryBase: 50,
    includesBase: 80,
    fuzzyBase: 120,
  });
  if (nameScore === null) return pathScore;
  if (pathScore === null) return nameScore;
  return Math.min(nameScore, pathScore);
}

/**
 * Empty search keeps explicit recents separate from the ordinary file list.
 * Typed search ranks by filename/path quality; recency only breaks equal-score
 * matches, so an older exact match can never be buried by a weaker recent one.
 */
export function buildWikiLinkPickerSections(input: {
  readonly candidates: ReadonlyArray<ScientMarkdownWikiLinkCandidate>;
  readonly query: string;
  readonly recentPaths: ReadonlyArray<string>;
  readonly limit?: number;
}): ScientMarkdownWikiLinkPickerSections {
  const limit = Math.max(0, input.limit ?? WIKI_LINK_PICKER_RESULT_LIMIT);
  const candidatesByPath = new Map(
    input.candidates.map((candidate) => [candidate.path, candidate]),
  );
  const recentPaths = sanitizeRecentWikiLinkPaths(input.recentPaths).filter((path) =>
    candidatesByPath.has(path),
  );
  const recentPathSet = new Set(recentPaths);
  const query = normalizeSearchQuery(input.query);

  if (query.length === 0) {
    const recent = recentPaths.flatMap((path) => {
      const candidate = candidatesByPath.get(path);
      return candidate ? [candidate] : [];
    });
    const results = input.candidates
      .filter((candidate) => !recentPathSet.has(candidate.path))
      .toSorted((left, right) => left.path.localeCompare(right.path))
      .slice(0, limit);
    return { recent, results };
  }

  const recentOrder = new Map(recentPaths.map((path, index) => [path, index]));
  const ranked: Array<RankedSearchResult<ScientMarkdownWikiLinkCandidate>> = [];
  for (const candidate of input.candidates) {
    const score = candidateSearchScore(candidate, query);
    if (score === null) continue;
    const recency = recentOrder.get(candidate.path);
    ranked.push({
      item: candidate,
      score,
      tieBreaker:
        recency === undefined
          ? `1:${candidate.path}`
          : `0:${recency.toString().padStart(2, "0")}:${candidate.path}`,
    });
  }
  ranked.sort(compareRankedSearchResults);
  return { recent: [], results: ranked.slice(0, limit).map(({ item }) => item) };
}
