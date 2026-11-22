import { describe, expect, it } from "vite-plus/test";

import { footnoteLabels, scientFormulaRanges } from "./scientFormulaRanges";

describe("scientFormulaRanges", () => {
  it("returns formulas in source order, including an unused footnote's", () => {
    expect(scientFormulaRanges("[^a]: $z$\n\n$a$ hi [^a] $b$")).toEqual([
      { start: 6, end: 9 },
      { start: 11, end: 14 },
      { start: 23, end: 26 },
    ]);
    expect(scientFormulaRanges("Explain.\n\n[^a]: $$x$$")).toEqual([{ start: 16, end: 21 }]);
  });

  it("reads a footnote label within its own line, so the scan stays linear", () => {
    // A label that could run to the next `]` made `"[^a\n".repeat(n)` quadratic.
    expect([...footnoteLabels("[^a\nb]: x\n> [^c]: y\n[^d e]: z")]).toEqual(["c"]);
    const unfinished = "[^a\n".repeat(20_000);
    expect(scientFormulaRanges(unfinished)).toEqual([]);
    expect(scientFormulaRanges(`${unfinished}$x$`)).toEqual([
      { start: unfinished.length, end: unfinished.length + 3 },
    ]);
  });
});
