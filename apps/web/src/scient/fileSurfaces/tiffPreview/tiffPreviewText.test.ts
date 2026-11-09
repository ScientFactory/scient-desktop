import { describe, expect, it } from "vite-plus/test";

import { tiffAxisSteps, tiffRangeText, tiffRangeWidth } from "./tiffPreviewText";

describe("tiffRangeText", () => {
  it.each([
    [[31, 431], "uint", "31–431"],
    [[1_000, 65_535], "uint", "1,000–65,535"],
    [[-0.85, 0.65], "float", "−0.85 to 0.65"],
    [[-976, 3_095], "int", "−976 to 3,095"],
    [[-3, -1], "int", "−3 to −1"],
    [[1.234e-7, 0.5], "float", "1.23e-7–0.5"],
    [[0, 2.5e12], "float", "0–2.50e12"],
  ] as const)("writes %j as %s %s", (range, format, text) => {
    expect(tiffRangeText(range, format)).toBe(text);
  });

  it.each([
    [{ bits: 8, format: "uint" }, [255, 255]],
    [{ bits: 16, format: "uint" }, [65_535, 65_535]],
    [{ bits: 16, format: "int" }, [-32_768, -32_768]],
    [{ bits: 32, format: "float" }, [-1.234e-12, -1.234e-12]],
    [{ bits: 32, format: "float" }, [-999_900, -0.001234]],
  ] as const)("reserves room for the widest %j range", (info, range) => {
    expect(tiffRangeText(range, info.format).length).toBeLessThanOrEqual(tiffRangeWidth(info));
  });
});

describe("tiffAxisSteps", () => {
  it("steps each named axis by its own stride, in C, Z, T order", () => {
    const axes = [
      { name: "Z", size: 5 },
      { name: "C", size: 2 },
      { name: "T", size: 1 },
    ] as const;
    // Plane 7 is z=2, c=1 when Z is fastest.
    expect(tiffAxisSteps(7, axes)).toEqual([
      { name: "C", index: 1, size: 2, stride: 5 },
      { name: "Z", index: 2, size: 5, stride: 1 },
    ]);
  });
});
