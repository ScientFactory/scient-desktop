import {
  foldText,
  fullTextHasText,
  type FullTextSearchDocument,
  type ScientSourceExtractedFullText,
} from "@scientfactory/scient-sources/full-text";

// Costs are in UTF-16 units: raw and folded text, plus the objects kept per page and per entry.
const PAGE_COST = 128;
const ENTRY_COST = 1_024;

export interface SourceFullTextCacheEntry {
  readonly text: ScientSourceExtractedFullText;
  readonly document: FullTextSearchDocument;
}

/**
 * Least-recently-used cache of extracted text and its folded search pages,
 * bounded by entries and by cost. Text without any characters keeps no pages:
 * there is nothing to search or quote in it.
 */
export function makeSourceFullTextCache(
  limits: { readonly maxCost: number; readonly maxEntries: number } = {
    maxCost: 48_000_000,
    maxEntries: 4_096,
  },
) {
  const entries = new Map<string, SourceFullTextCacheEntry & { readonly cost: number }>();
  let cost = 0;

  const evict = (keep: string) => {
    for (const [key, entry] of entries) {
      if (cost <= limits.maxCost && entries.size <= limits.maxEntries) break;
      if (key === keep) continue;
      entries.delete(key);
      cost -= entry.cost;
    }
  };

  return {
    get: (sha256: string): SourceFullTextCacheEntry | undefined => entries.get(sha256),
    has: (sha256: string) => entries.has(sha256),
    add(text: ScientSourceExtractedFullText): SourceFullTextCacheEntry {
      const cached = entries.get(text.sha256);
      if (cached) {
        entries.delete(text.sha256);
        entries.set(text.sha256, cached);
        return cached;
      }
      const kept = fullTextHasText(text) ? text : { ...text, pages: [] };
      const pages = kept.pages.map((page) => ({
        page: page.page,
        folded: foldText(page.text, "search").text,
      }));
      const entry = {
        text: kept,
        document: { key: text.sha256, pages },
        cost:
          ENTRY_COST +
          kept.pages.reduce(
            (total, page, index) =>
              total + 2 * PAGE_COST + page.text.length + pages[index]!.folded.length,
            0,
          ),
      };
      entries.set(text.sha256, entry);
      cost += entry.cost;
      evict(text.sha256);
      return entry;
    },
    stats: () => ({
      entries: entries.size,
      pages: [...entries.values()].reduce((total, entry) => total + entry.text.pages.length, 0),
      cost,
    }),
  };
}
