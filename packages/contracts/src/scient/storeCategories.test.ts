import { describe, expect, it } from "vite-plus/test";
import { storeCategories } from "./storeCategories.ts";

describe("store category placement", () => {
  it("uses explicit subject overrides before coarse marketplace categories", () => {
    expect(storeCategories("boltz-api-cli", "Developer Tools")).toEqual(["chemistry", "biology"]);
    expect(storeCategories("zotero", "Productivity")).toEqual(["writing", "papers"]);
    expect(storeCategories("ngs-analysis", undefined)).toEqual(["biology"]);
  });
  it("normalizes store categories and leaves unknown categories unplaced", () => {
    expect(storeCategories("unknown", " Data & Analytics ")).toEqual(["data"]);
    expect(storeCategories("unknown", "database")).toEqual(["data"]);
    expect(storeCategories("unknown", "new category")).toEqual([]);
  });
});
