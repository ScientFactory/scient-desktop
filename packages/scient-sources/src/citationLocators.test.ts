import { describe, expect, it } from "vite-plus/test";

import {
  citationLocatorPage,
  latexCitationItems,
  pandocCitationItems,
} from "./citationLocators.ts";

describe("pandocCitationItems", () => {
  it("reads each item's key and locator, with prefixes and suppressed authors", () => {
    expect(pandocCitationItems("see @smith2020, p. 4; -@lee2021 chap. 2; @{doi:10.1/x}")).toEqual([
      { key: "smith2020", locator: "p. 4" },
      { key: "lee2021", locator: "chap. 2" },
      { key: "doi:10.1/x", locator: null },
    ]);
  });

  it("keeps inner punctuation in a key and drops a trailing one", () => {
    expect(pandocCitationItems("@doe:2020.v2, pp. 3-5")).toEqual([
      { key: "doe:2020.v2", locator: "pp. 3-5" },
    ]);
    expect(pandocCitationItems("@smith2020.")).toEqual([{ key: "smith2020", locator: null }]);
  });

  it("skips parts with no key and does not read an e-mail address as a citation", () => {
    expect(pandocCitationItems("compare; @a")).toEqual([{ key: "a", locator: null }]);
    expect(pandocCitationItems("mail me@example.org")).toEqual([]);
  });
});

describe("latexCitationItems", () => {
  it("gives the postnote to a lone key and to no key of a list", () => {
    expect(latexCitationItems("smith2020", ["p.~4"])).toEqual([
      { key: "smith2020", locator: "p.~4" },
    ]);
    expect(latexCitationItems("a, b", ["p.~4"])).toEqual([
      { key: "a", locator: null },
      { key: "b", locator: null },
    ]);
  });

  it("reads the last of two notes as the postnote and ignores empty ones", () => {
    expect(latexCitationItems("a", ["see", "pp.~4--5"])).toEqual([
      { key: "a", locator: "pp.~4--5" },
    ]);
    expect(latexCitationItems("a", ["see", ""])).toEqual([{ key: "a", locator: null }]);
    expect(latexCitationItems(" a ,, * ", [])).toEqual([{ key: "a", locator: null }]);
  });
});

describe("citationLocatorPage", () => {
  it("reads the first page a locator names", () => {
    expect(citationLocatorPage("p. 4")).toBe("4");
    expect(citationLocatorPage("pp.~12–15")).toBe("12");
    expect(citationLocatorPage("page 7")).toBe("7");
    expect(citationLocatorPage("S. 12")).toBe("12");
    expect(citationLocatorPage("p. xii")).toBe("xii");
    expect(citationLocatorPage("31")).toBe("31");
    expect(citationLocatorPage("31-33")).toBe("31");
  });

  it("finds no page in other locators", () => {
    expect(citationLocatorPage(null)).toBeNull();
    expect(citationLocatorPage("chap. 2")).toBeNull();
    expect(citationLocatorPage("sec. 3.1")).toBeNull();
    expect(citationLocatorPage("fig. 2")).toBeNull();
  });
});
