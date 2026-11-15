import { describe, expect, it } from "vite-plus/test";

import {
  citationGroupKeys,
  filterLibraryCitations,
  libraryLatexCitationSuggestions,
  type LibraryCitationCandidate,
} from "./libraryCitations";

const candidates: ReadonlyArray<LibraryCitationCandidate> = [
  { sourceId: "a", citationKey: "lovelace1843notes", label: "Lovelace 1843", title: "Notes" },
  {
    sourceId: "b",
    citationKey: "turing1950computing",
    label: "Turing 1950",
    title: "Computing machinery and intelligence",
  },
  {
    sourceId: "c",
    citationKey: "hopper1952education",
    label: "Hopper 1952",
    title: "The education of a computer",
  },
];

describe("Library citations", () => {
  it("ranks a key prefix first, then author, year and title matches", () => {
    expect(filterLibraryCitations(candidates, "tur").map((item) => item.sourceId)).toEqual(["b"]);
    expect(filterLibraryCitations(candidates, "1952").map((item) => item.sourceId)).toEqual(["c"]);
    expect(filterLibraryCitations(candidates, "machinery").map((item) => item.sourceId)).toEqual([
      "b",
    ]);
    expect(filterLibraryCitations(candidates, "")).toHaveLength(3);
    expect(filterLibraryCitations(candidates, "zzz")).toEqual([]);
  });

  it("suggests sources for a typed LaTeX citation with author, year and title beside the key", () => {
    expect(libraryLatexCitationSuggestions(candidates, "machinery")).toEqual([
      {
        key: "turing1950computing",
        detail: "Turing 1950 · Computing machinery and intelligence",
      },
    ]);
    // A source without an author or a year is labelled by its key, which is not said twice.
    expect(
      libraryLatexCitationSuggestions(
        [{ sourceId: "d", citationKey: "anon", label: "anon", title: null }],
        "",
      ),
    ).toEqual([{ key: "anon", detail: "" }]);
  });

  it("reads every key in a Pandoc citation group", () => {
    expect(citationGroupKeys("@a, p. 4; -@b.c; see @d:e")).toEqual(["a", "b.c", "d:e"]);
    expect(citationGroupKeys("mail me at x@y.org")).toEqual([]);
  });
});
