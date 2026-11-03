import { describe, expect, it } from "vite-plus/test";

import { isPlainSearch, mergeSuggestions } from "./suggestionList";

describe("isPlainSearch", () => {
  it.each(["crispr", "crispr cas9 review", "מחקר איכותני", "what is 2+2"])("sends %s", (text) => {
    expect(isPlainSearch(text)).toBe(true);
  });

  it.each([
    "nature.com",
    "https://intranet.example/private?token=abc",
    "intranet.corp/payroll",
    "localhost:3000",
    "10.0.0.1/admin",
    "mailto:someone@example.com",
  ])("keeps %s to itself", (text) => {
    expect(isPlainSearch(text)).toBe(false);
  });
});

describe("mergeSuggestions", () => {
  const page = { url: "https://nature.com/", title: "Nature", lastVisitedAt: 1 };

  it("puts past pages first", () => {
    expect(mergeSuggestions("nat", [page], ["nature journal"])).toEqual([
      { kind: "page", value: "https://nature.com/", title: "Nature" },
      { kind: "search", value: "nature journal" },
    ]);
  });

  it("leaves out a search for exactly what's typed", () => {
    expect(mergeSuggestions(" CRISPR ", [], ["crispr", "crispr cas9"])).toEqual([
      { kind: "search", value: "crispr cas9" },
    ]);
  });
});
