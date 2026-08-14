import { describe, expect, it } from "@effect/vitest";

import { resolveScientificSourceLanguage } from "./sourceLanguage";

describe("scientific source language overrides", () => {
  it("classifies .m source as MATLAB instead of the inherited Wolfram default", () => {
    expect(resolveScientificSourceLanguage("analysis.m")).toBe("matlab");
    expect(resolveScientificSourceLanguage("nested/ANALYSIS.M")).toBe("matlab");
  });

  it("classifies the spelled-out .latex extension the renderer never learned", () => {
    expect(resolveScientificSourceLanguage("paper.latex")).toBe("tex");
    expect(resolveScientificSourceLanguage("chapters/INTRO.LATEX")).toBe("tex");
  });

  it("leaves unrelated language inference unchanged", () => {
    expect(resolveScientificSourceLanguage("analysis.py")).toBeUndefined();
    // Extensions the inherited renderer already maps to `tex` stay its business.
    expect(resolveScientificSourceLanguage("main.tex")).toBeUndefined();
    expect(resolveScientificSourceLanguage("main.ltx")).toBeUndefined();
  });
});
