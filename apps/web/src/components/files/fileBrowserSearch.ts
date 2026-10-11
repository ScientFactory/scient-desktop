export const FILE_SEARCH_QUERY_MAX_LENGTH = 256;

/** Keep stale-query detection aligned with the exact bounded query sent to the server. */
export function resolveFileBrowserSearchValue(value: string): {
  readonly query: string;
  readonly normalizedQuery: string;
} {
  const query = value.slice(0, FILE_SEARCH_QUERY_MAX_LENGTH);
  return { query, normalizedQuery: query.trim() };
}
