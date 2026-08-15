import { describe, expect, it } from "vite-plus/test";

import { resolveScientRichFenceKind } from "./ScientRichFence";

describe("resolveScientRichFenceKind", () => {
  it.each([
    ["mermaid", "mermaid"],
    ["MERMAID", "mermaid"],
    ["vega-lite", "vega-lite"],
    ["Vega-Lite", "vega-lite"],
    ["vegalite", "vega-lite"],
    ["vl", "vega-lite"],
  ] as const)("recognizes %s", (language, expected) => {
    expect(resolveScientRichFenceKind(language)).toBe(expected);
  });

  it("does not capture ordinary code fences or low-level Vega", () => {
    expect(resolveScientRichFenceKind("json")).toBeNull();
    expect(resolveScientRichFenceKind("vega")).toBeNull();
    expect(resolveScientRichFenceKind("typescript")).toBeNull();
  });
});
