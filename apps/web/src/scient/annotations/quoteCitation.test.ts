import { describe, expect, it } from "vitest";

import { resolveQuoteCitation } from "./quoteCitation";

// Two chapters of one book carry the book's PDF; the book itself has no key yet.
const chapterOne = { sourceId: "src_ch1", title: "Chapter 1", citationKey: "doe2024a" };
const chapterTwo = { sourceId: "src_ch2", title: "Chapter 2", citationKey: "doe2024b" };
const book = { sourceId: "src_book", title: "The book" };

describe("whom a quote from a PDF cites", () => {
  it("cites exactly the source the PDF was opened from, or nothing when it has no key", () => {
    const sources = [chapterOne, chapterTwo, book];
    expect(resolveQuoteCitation(sources, "src_ch2")).toEqual({
      kind: "cite",
      citationKey: "doe2024b",
    });
    expect(resolveQuoteCitation(sources, "src_book")).toEqual({ kind: "none" });
    expect(resolveQuoteCitation([chapterOne], "src_elsewhere")).toEqual({ kind: "none" });
  });

  it("cites the one keyed source when the PDF was opened from elsewhere", () => {
    expect(resolveQuoteCitation([book, chapterOne], null)).toEqual({
      kind: "cite",
      citationKey: "doe2024a",
    });
    expect(resolveQuoteCitation([book], null)).toEqual({ kind: "none" });
    expect(resolveQuoteCitation([], null)).toEqual({ kind: "none" });
  });

  it("asks which source to cite when several keyed sources share the PDF", () => {
    expect(resolveQuoteCitation([chapterOne, book, chapterTwo], null)).toEqual({
      kind: "choose",
      choices: [
        { sourceId: "src_ch1", citationKey: "doe2024a", title: "Chapter 1" },
        { sourceId: "src_ch2", citationKey: "doe2024b", title: "Chapter 2" },
      ],
    });
  });
});
