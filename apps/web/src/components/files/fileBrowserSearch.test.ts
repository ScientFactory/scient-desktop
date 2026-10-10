import { describe, expect, it } from "vite-plus/test";

import { FILE_SEARCH_QUERY_MAX_LENGTH, resolveFileBrowserSearchValue } from "./fileBrowserSearch";

describe("resolveFileBrowserSearchValue", () => {
  it("compares search readiness against the same bounded query sent to the server", () => {
    const value = ` ${"a".repeat(FILE_SEARCH_QUERY_MAX_LENGTH)}ignored`;
    const result = resolveFileBrowserSearchValue(value);

    expect(result.query).toBe(value.slice(0, FILE_SEARCH_QUERY_MAX_LENGTH));
    expect(result.normalizedQuery).toBe(result.query.trim());
    expect(result.normalizedQuery).not.toBe(value.trim());
  });
});
