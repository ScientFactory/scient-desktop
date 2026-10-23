import { expect, it } from "vite-plus/test";
import { scientMathRanges } from "./scientMathRanges";

it("preserves authored source and offsets without shielding currency or shell identifiers", () => {
  const source = "Cost $5 and $10; $HOME/$USER; use $x_i$ or \\(y^2\\).";
  const ranges = scientMathRanges(source);
  expect(ranges.map((range) => range.source)).toEqual(["$x_i$", "\\(y^2\\)"]);
  for (const range of ranges) expect(source.slice(range.start, range.end)).toBe(range.source);
});

it("shields only closed math fences and leaves ordinary code alone", () => {
  expect(scientMathRanges("```math\nx_i")).toEqual([]);
  expect(scientMathRanges("```ts\n$x_i$\n```")).toEqual([]);
  expect(scientMathRanges("```math\nx_i\n```").map((range) => range.source)).toEqual([
    "```math\nx_i\n```",
  ]);
});
