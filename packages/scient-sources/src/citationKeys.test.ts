import { describe, expect, it } from "@effect/vitest";

import {
  assignCitationKey,
  citationKeyFromZoteroExtra,
  generateCitationKeyBase,
  isValidCitationKey,
  normalizeImportedCitationKey,
  uniqueCitationKey,
} from "./citationKeys.ts";

const author = (familyName: string | null, literalName: string | null = null) => ({
  creatorType: "author",
  givenName: null,
  familyName,
  literalName,
});

describe("citation keys", () => {
  it.each([
    ["smith2020deep", true],
    ["Müller_2019:a.b-c", true],
    ["plus+sign", false],
    ["_leading", true],
    ["trailing.", false],
    ["has space", false],
    ["brace{", false],
    ["", false],
  ])("accepts only keys Pandoc and BibTeX can both read: %s", (key, valid) => {
    expect(isValidCitationKey(key)).toBe(valid);
  });

  it("keeps imported keys and drops only unreadable characters", () => {
    expect(normalizeImportedCitationKey("  Smith2020Deep  ")).toBe("Smith2020Deep");
    expect(normalizeImportedCitationKey("smith 2020{deep}.")).toBe("smith2020deep");
    expect(normalizeImportedCitationKey("{}")).toBeNull();
    expect(normalizeImportedCitationKey(undefined)).toBeNull();
  });

  it("reads a Better BibTeX key from a Zotero extra field", () => {
    expect(citationKeyFromZoteroExtra("PMID: 1\nCitation Key: lovelace1843notes\n")).toBe(
      "lovelace1843notes",
    );
    expect(citationKeyFromZoteroExtra("PMID: 1")).toBeNull();
  });

  it("generates author, year and first significant title word in ASCII", () => {
    expect(
      generateCitationKeyBase({
        creators: [
          { creatorType: "editor", givenName: null, familyName: "Editor", literalName: null },
          author("Gödel-Ørsted"),
        ],
        issuedYear: 1931,
        title: "On the formally undecidable propositions",
      }),
    ).toBe("godelorsted1931formally");
    expect(
      generateCitationKeyBase({
        creators: [author(null, "World Health Organization")],
        issuedYear: null,
        title: null,
      }),
    ).toBe("world");
    expect(generateCitationKeyBase({ creators: [], issuedYear: 2020, title: "The" })).toBe(
      "anon2020",
    );
  });

  it("adds a letter suffix on a case-insensitive clash", () => {
    expect(uniqueCitationKey("smith2020", new Set())).toBe("smith2020");
    expect(uniqueCitationKey("Smith2020", new Set(["smith2020", "smith2020a"]))).toBe("Smith2020b");
    const taken = new Set([
      "k",
      ...Array.from({ length: 26 }, (_, i) => `k${"abcdefghijklmnopqrstuvwxyz"[i]}`),
    ]);
    expect(uniqueCitationKey("k", taken)).toBe("kaa");
  });

  it("prefers an imported key and generates one otherwise", () => {
    const metadata = { creators: [author("Lovelace")], issuedYear: 1843, title: "Notes" };
    expect(assignCitationKey({ ...metadata, preferred: "LovelaceNotes", taken: new Set() })).toBe(
      "LovelaceNotes",
    );
    expect(
      assignCitationKey({
        ...metadata,
        preferred: "lovelacenotes",
        taken: new Set(["lovelacenotes"]),
      }),
    ).toBe("lovelacenotesa");
    expect(assignCitationKey({ ...metadata, preferred: "{}", taken: new Set() })).toBe(
      "lovelace1843notes",
    );
  });
});
