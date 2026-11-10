import {
  SCIENT_SOURCE_FULL_TEXT_PROFILE,
  type ScientSourceExtractedFullText,
} from "@scientfactory/scient-sources/full-text";
import { describe, expect, it } from "@effect/vitest";

import { makeSourceFullTextCache } from "./SourceFullTextCache.ts";

function text(index: number, pages: number, pageText: string): ScientSourceExtractedFullText {
  return {
    formatVersion: 1,
    outcome: "extracted",
    sha256: index.toString(16).padStart(64, "0"),
    byteLength: 1,
    profile: SCIENT_SOURCE_FULL_TEXT_PROFILE,
    extractor: { name: "pdfjs", version: "test" },
    extractedAt: "2026-11-11T00:00:00.000Z",
    pageCount: pages,
    complete: true,
    pages: Array.from({ length: pages }, (_, page) => ({
      page: page + 1,
      text: pageText,
      viewBox: [0, 0, 612, 792] as const,
      rotation: 0,
      userUnit: 1,
    })),
  };
}

describe("source full-text cache", () => {
  it("stays bounded for scans and for many short pages", () => {
    const cache = makeSourceFullTextCache({ maxCost: 1_000_000, maxEntries: 200 });
    for (let index = 0; index < 1_000; index += 1) cache.add(text(index, 100, ""));
    expect(cache.stats()).toMatchObject({ entries: 200, pages: 0 });

    for (let index = 1_000; index < 2_000; index += 1) cache.add(text(index, 100, "a"));
    const { pages, cost } = cache.stats();
    expect(cost).toBeLessThanOrEqual(1_000_000);
    expect(pages).toBeLessThan(5_000);
  });
});
