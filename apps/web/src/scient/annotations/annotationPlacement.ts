import type { ScientPdfAnnotation } from "@t3tools/contracts";

export interface PageRange {
  readonly start: number;
  readonly end: number;
}

function uniqueIndex(haystack: string, needle: string): number {
  if (!needle) return -1;
  const first = haystack.indexOf(needle);
  return first !== -1 && haystack.indexOf(needle, first + 1) === -1 ? first : -1;
}

/**
 * Where an annotation's part on one page sits in that page's rendered text.
 * Stored offsets are kept when they still select the stored quote; otherwise
 * the quote is searched on the page, with its context first, and must occur
 * once. Never guesses between repeats.
 */
export function annotationRangeOnPage(
  annotation: ScientPdfAnnotation,
  page: number,
  text: string,
): PageRange | null {
  const stored = annotation.anchor.selector.pages.find((entry) => entry.page === page);
  if (!stored) return null;
  if (text.slice(stored.start, stored.end) === stored.quote) {
    return { start: stored.start, end: stored.end };
  }
  const withContext = uniqueIndex(text, stored.prefix + stored.quote + stored.suffix);
  if (withContext !== -1) {
    const start = withContext + stored.prefix.length;
    return { start, end: start + stored.quote.length };
  }
  const bare = uniqueIndex(text, stored.quote);
  return bare === -1 ? null : { start: bare, end: bare + stored.quote.length };
}
