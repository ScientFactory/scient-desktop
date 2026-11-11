import { describe, expect, it } from "vite-plus/test";

import { parseCslStyleIndex, searchCslCatalog } from "./catalog.ts";

// Rows recorded from https://www.zotero.org/styles-files/styles.json (2026-11-11).
const RECORDED_INDEX = [
  { name: "nature-communications", title: "Nature Communications", dependent: 1 },
  { name: "nature", title: "Nature", dependent: 0 },
  { name: "scientific-reports", title: "Scientific Reports", dependent: 1 },
  {
    name: "harvard-anglia-ruskin-university",
    title: "Anglia Ruskin University (author-date/Harvard)",
    titleShort: "ARU",
    dependent: 0,
  },
  {
    name: "harvard-cite-them-right",
    title: "Cite Them Right 12th edition (author-date/Harvard)",
    dependent: 0,
  },
  { name: "plos-one", title: "PLOS ONE", dependent: 1 },
  { name: "plos", title: "Public Library of Science", titleShort: "PLOS", dependent: 0 },
  { name: "../escape", title: "Not a style ID", dependent: 0 },
];

describe("searchCslCatalog", () => {
  const index = parseCslStyleIndex(RECORDED_INDEX)!;
  const ids = (query: string) => searchCslCatalog(index, query, 5).map((entry) => entry.id);

  it("finds a journal by its name, the journal itself before related journals", () => {
    expect(ids("nature")).toEqual(["nature", "nature-communications"]);
    expect(searchCslCatalog(index, "PLOS ONE", 1)).toEqual([
      { id: "plos-one", title: "PLOS ONE", titleShort: null, dependent: true, bundled: false },
    ]);
  });

  it("finds a style by its name, with the bundled style first", () => {
    expect(ids("Harvard")).toEqual(["harvard-cite-them-right", "harvard-anglia-ruskin-university"]);
    expect(ids("plos")).toEqual(["plos", "plos-one"]);
  });

  it("leaves out index rows whose ID could not name a file", () => {
    expect(index.map((entry) => entry.id)).not.toContain("../escape");
  });
});
