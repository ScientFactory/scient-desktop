import { describe, expect, it } from "vite-plus/test";

import { filterLibraryCitations, type LibraryCitationCandidate } from "./libraryCitations";

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
});
