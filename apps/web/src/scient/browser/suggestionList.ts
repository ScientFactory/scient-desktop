import type { BrowserHistoryPage } from "@t3tools/contracts";
import { resolveAddressBarInput } from "@t3tools/shared/preview";

const SEARCH_PROBE = "https://suggest.invalid/?q=";

export type BrowserSuggestion =
  | { readonly kind: "page"; readonly value: string; readonly title: string }
  | { readonly kind: "search"; readonly value: string };

/** Addresses can be private, so only plain searches ever reach a search engine. */
export function isPlainSearch(text: string) {
  try {
    return resolveAddressBarInput(text, `${SEARCH_PROBE}%s`).startsWith(SEARCH_PROBE);
  } catch {
    return false;
  }
}

/** Past pages first, then searches. What's already typed needs no suggestion: Enter does that. */
export function mergeSuggestions(
  text: string,
  pages: ReadonlyArray<BrowserHistoryPage>,
  searches: ReadonlyArray<string>,
): ReadonlyArray<BrowserSuggestion> {
  const typed = text.trim().toLowerCase();
  return [
    ...pages.map((page) => ({ kind: "page" as const, value: page.url, title: page.title })),
    ...searches
      .filter((search) => search.trim().toLowerCase() !== typed)
      .map((search) => ({ kind: "search" as const, value: search })),
  ];
}
