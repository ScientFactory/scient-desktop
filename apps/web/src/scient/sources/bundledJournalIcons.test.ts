import { describe, expect, it } from "vite-plus/test";

import { bundledJournalIcon } from "./bundledJournalIcons";

type JournalRecord = Parameters<typeof bundledJournalIcon>[0];

function article(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return { type: "article", containerTitle: null, identifiers: [], url: null, ...overrides };
}

describe("bundled journal artwork", () => {
  it("resolves synchronously from title or normalized ISSN without a page or DOI", () => {
    const titleIcon = bundledJournalIcon(article({ containerTitle: "Nature" }));
    const issnIcon = bundledJournalIcon(
      article({ identifiers: [{ scheme: " ISSN ", value: " 0028 0836 " }] }),
    );

    expect(titleIcon).not.toBeNull();
    expect(issnIcon).toBe(titleIcon);
    expect(titleIcon?.url).not.toMatch(/^https?:/);
    expect(titleIcon).not.toBeInstanceOf(Promise);
  });

  it("normalizes curated abbreviations without guessing from a prefix or ambiguous abbreviation", () => {
    expect(bundledJournalIcon(article({ containerTitle: "  NAT.\u00a0MED.  " }))).toBe(
      bundledJournalIcon(article({ containerTitle: "Nature Medicine" })),
    );
    expect(bundledJournalIcon(article({ containerTitle: "Nature Medicine Advances" }))).toBeNull();
    expect(bundledJournalIcon(article({ containerTitle: "Front Med" }))).toBeNull();
  });

  it("only interprets ISSN identifiers as journal identities", () => {
    expect(
      bundledJournalIcon(article({ identifiers: [{ scheme: "doi", value: "0028-0836" }] })),
    ).toBeNull();
    expect(
      bundledJournalIcon(
        article({ identifiers: [{ scheme: "doi", value: "10.1038/nature12345" }] }),
      ),
    ).toBeNull();
  });

  it("accepts agreeing print/electronic ISSNs but rejects conflicting journals sharing a mark", () => {
    const identifiers = [
      { scheme: "issn", value: "1078-8956" },
      { scheme: "eissn", value: "1546-170x" },
    ];
    const matching = bundledJournalIcon(
      article({ containerTitle: "Nature Medicine", identifiers }),
    );
    expect(matching).not.toBeNull();
    expect(bundledJournalIcon(article({ identifiers }))).toBe(matching);
    expect(
      bundledJournalIcon(
        article({
          identifiers: [...identifiers, { scheme: "issn", value: "2041-1723" }],
          url: "https://www.nature.com/articles/example",
        }),
      ),
    ).toBeNull();
    expect(
      bundledJournalIcon(
        article({
          containerTitle: "Nature Communications",
          identifiers,
          url: "https://nature.com",
        }),
      ),
    ).toBeNull();
  });

  it("never lets a title override a valid unrecognized ISSN", () => {
    expect(
      bundledJournalIcon(
        article({
          containerTitle: "Nature",
          identifiers: [{ scheme: "issn", value: "1234-5678" }],
        }),
      ),
    ).toBeNull();
    expect(
      bundledJournalIcon(
        article({
          containerTitle: "Nature",
          identifiers: [{ scheme: "issn", value: "not-an-issn" }],
        }),
      )?.journalTitle,
    ).toBe("Nature");
  });

  it("prefers identified journals to publisher and indexing-platform fallbacks", () => {
    const icon = bundledJournalIcon(
      article({
        containerTitle: "Nature",
        identifiers: [{ scheme: "issn", value: "0028-0836" }],
        url: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
      }),
    );
    expect(icon?.journalTitle).toBe("Nature");
    expect(icon).toBe(bundledJournalIcon(article({ containerTitle: "Nature" })));
  });

  it("labels shared publisher artwork honestly instead of claiming journal-specific artwork", () => {
    const medicine = bundledJournalIcon(article({ containerTitle: "Nature Medicine" }));
    const digitalMedicine = bundledJournalIcon(article({ containerTitle: "npj Digital Medicine" }));
    const ai = bundledJournalIcon(article({ containerTitle: "NEJM AI" }));

    expect(medicine?.journalTitle).toBe("Nature (publisher)");
    expect(digitalMedicine).toBe(medicine);
    expect(ai?.journalTitle).toBe("NEJM Group (publisher)");
    expect(ai?.url).not.toBe(medicine?.url);
  });

  it("uses only generic publisher/platform marks for uncurated journal URLs", () => {
    expect(
      bundledJournalIcon(
        article({
          containerTitle: "An uncurated journal",
          url: "https://www.nature.com/articles/x",
        }),
      )?.journalTitle,
    ).toBe("Nature (publisher)");
    expect(
      bundledJournalIcon(article({ url: "https://pubmed.ncbi.nlm.nih.gov/123/" }))?.journalTitle,
    ).toBe("PubMed (platform)");
    expect(bundledJournalIcon(article({ url: "https://elifesciences.org/articles/1" }))).toBeNull();
  });

  it("does not match spoofed hosts, malformed URLs, non-web protocols, or unknown identities", () => {
    for (const url of [
      "https://nature.com.example.org/article",
      "https://notnature.com/article",
      "https://nature.com@example.org/article",
      "not a URL",
      "ftp://nature.com/article",
      "https://constructor/",
      null,
    ]) {
      expect(bundledJournalIcon(article({ containerTitle: "Unknown journal", url }))).toBeNull();
    }
  });

  it("never treats another source type as a journal article", () => {
    expect(
      bundledJournalIcon(
        article({
          type: "preprint",
          containerTitle: "Nature",
          identifiers: [{ scheme: "issn", value: "0028-0836" }],
          url: "https://nature.com",
        }),
      ),
    ).toBeNull();
  });
});
