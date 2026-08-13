import { describe, expect, it } from "@effect/vitest";

import { resolveScientificSourceLanguage } from "./sourceLanguage";

describe("scientific source language overrides", () => {
  it("classifies .m source as MATLAB instead of the inherited Wolfram default", () => {
    expect(resolveScientificSourceLanguage("analysis.m")).toBe("matlab");
    expect(resolveScientificSourceLanguage("nested/ANALYSIS.M")).toBe("matlab");
  });

  it("leaves unrelated language inference unchanged", () => {
    expect(resolveScientificSourceLanguage("analysis.py")).toBeUndefined();
  });
});
