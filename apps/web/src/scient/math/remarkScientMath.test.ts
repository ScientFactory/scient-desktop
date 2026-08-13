import { describe, expect, it } from "vite-plus/test";
import remarkMath from "remark-math";

import { isScientMathCodeClassName, remarkScientMath } from "./remarkScientMath";

describe("remarkScientMath", () => {
  it("is a remark-math tuple that keeps single-dollar inline math on", () => {
    expect(remarkScientMath[0]).toBe(remarkMath);
    expect(remarkScientMath[1]).toEqual({ singleDollarTextMath: true });
  });
});

describe("isScientMathCodeClassName", () => {
  it("accepts the classes remark-math emits", () => {
    expect(isScientMathCodeClassName("language-math")).toBe(true);
    expect(isScientMathCodeClassName("language-math math-inline")).toBe(true);
    expect(isScientMathCodeClassName("language-math math-display")).toBe(true);
    expect(isScientMathCodeClassName("hljs language-math")).toBe(true);
  });

  it("rejects other languages and near-matches", () => {
    expect(isScientMathCodeClassName("language-mathml")).toBe(false);
    expect(isScientMathCodeClassName("language-ts")).toBe(false);
    expect(isScientMathCodeClassName("mylanguage-math")).toBe(false);
    expect(isScientMathCodeClassName("math-inline")).toBe(false);
    expect(isScientMathCodeClassName("")).toBe(false);
  });

  it("rejects a missing class name", () => {
    expect(isScientMathCodeClassName(undefined)).toBe(false);
  });
});
