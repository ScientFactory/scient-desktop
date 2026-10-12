import { describe, expect, it } from "vite-plus/test";
import { latexGapHeightIndex } from "./latexGapHeightIndex";

describe("paragraph presentation heights", () => {
  it("counts only gaps inside each source range, including repeated positions", () => {
    const gaps = [
      { position: 20, height: 3 },
      { position: 5, height: 8 },
      { position: 20, height: 2 },
      { position: 30, height: 4 },
    ];
    const indexed = latexGapHeightIndex(gaps);
    for (const [from, to] of [
      [0, 40],
      [5, 20],
      [5, 30],
      [20, 30],
      [30, 30],
    ])
      expect(indexed(from!, to!)).toBe(
        gaps.reduce(
          (sum, gap) => sum + (gap.position > from! && gap.position < to! ? gap.height : 0),
          0,
        ),
      );
    expect(latexGapHeightIndex([])(0, 100)).toBe(0);
  });
});
