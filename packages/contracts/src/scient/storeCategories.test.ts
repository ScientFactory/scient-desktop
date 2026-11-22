import { describe, expect, it } from "vite-plus/test";
import { storeCategories } from "./storeCategories.ts";

describe("store category placement", () => {
  it("uses explicit subject overrides before coarse marketplace categories", () => {
    expect(storeCategories("boltz-api-cli", "Developer Tools")).toEqual(["chemistry", "biology"]);
    expect(storeCategories("zotero", "Productivity")).toEqual(["papers"]);
    expect(storeCategories("ngs-analysis", undefined)).toEqual(["biology"]);
  });
  it("normalizes store categories and leaves unknown categories unplaced", () => {
    expect(storeCategories("unknown", " Data & Analytics ")).toEqual(["data"]);
    expect(storeCategories("unknown", "database")).toEqual(["data"]);
    expect(storeCategories("unknown", "new category")).toEqual([]);
  });
  it("keeps productivity plugins out of Files unless they are file services", () => {
    expect(storeCategories("semrush", "Productivity")).toEqual(["projects"]);
    expect(storeCategories("box", "productivity")).toEqual(["files"]);
    expect(storeCategories("commit-commands", "productivity")).toEqual(["code"]);
    expect(storeCategories("railway", "deployment")).toEqual(["code"]);
  });
});
