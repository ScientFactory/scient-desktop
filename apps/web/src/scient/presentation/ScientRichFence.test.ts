import { describe, expect, it } from "vite-plus/test";

import { resolveScientRichFenceKind } from "./ScientRichFence";

describe("resolveScientRichFenceKind", () => {
  // One lookup: an exact name, a case-folded name and an alias stand for the alias table.
  it.each([
    ["mermaid", "mermaid"],
    ["Vega-Lite", "vega-lite"],
    ["plotly.js", "plotly"],
  ] as const)("recognizes %s", (language, expected) => {
    expect(resolveScientRichFenceKind(language)).toBe(expected);
  });

  it("does not capture ordinary code fences or low-level Vega", () => {
    expect(resolveScientRichFenceKind("json")).toBeNull();
    expect(resolveScientRichFenceKind("vega")).toBeNull();
    expect(resolveScientRichFenceKind("plotly-v3")).toBeNull();
    expect(resolveScientRichFenceKind("typescript")).toBeNull();
  });
});
