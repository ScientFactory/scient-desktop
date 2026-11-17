import { describe, expect, it } from "vite-plus/test";

import { bundledJournalIcon } from "./bundledJournalIcons";

type JournalRecord = Parameters<typeof bundledJournalIcon>[0];

function article(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return { type: "article", containerTitle: null, identifiers: [], url: null, ...overrides };
}

describe("bundled journal artwork", () => {
  it("resolves synchronously from title or normalized ISSN without a page or DOI", () => {
    const titleIcon = bundledJournalIcon(article({ containerTitle: "NEJM Evidence" }));
    const issnIcon = bundledJournalIcon(
      article({ identifiers: [{ scheme: " ISSN ", value: " 2766 5526 " }] }),
    );

    expect(titleIcon).not.toBeNull();
    expect(issnIcon).toBe(titleIcon);
    expect(titleIcon?.url).not.toMatch(/^https?:/);
    expect(titleIcon).not.toBeInstanceOf(Promise);
  });

  it("normalizes curated abbreviations without guessing from a prefix or ambiguous abbreviation", () => {
    expect(bundledJournalIcon(article({ containerTitle: "  NEJM.\u00a0EVID.  " }))).toBe(
      bundledJournalIcon(article({ containerTitle: "NEJM Evidence" })),
    );
    expect(bundledJournalIcon(article({ containerTitle: "NEJM Evidence Advances" }))).toBeNull();
    expect(bundledJournalIcon(article({ containerTitle: "Front Med" }))).toBeNull();
  });

  it("only interprets ISSN identifiers as journal identities", () => {
    expect(
      bundledJournalIcon(article({ identifiers: [{ scheme: "doi", value: "2766-5526" }] })),
    ).toBeNull();
    expect(
      bundledJournalIcon(
        article({ identifiers: [{ scheme: "doi", value: "10.1038/nature12345" }] }),
      ),
    ).toBeNull();
  });

  it("accepts agreeing print/electronic ISSNs but rejects conflicting journals sharing a mark", () => {
    const identifiers = [
      { scheme: "issn", value: "0360-0300" },
      { scheme: "eissn", value: "1557-7341" },
    ];
    const matching = bundledJournalIcon(
      article({ containerTitle: "ACM Computing Surveys", identifiers }),
    );
    expect(matching).not.toBeNull();
    expect(bundledJournalIcon(article({ identifiers }))).toBe(matching);
    expect(
      bundledJournalIcon(
        article({
          identifiers: [...identifiers, { scheme: "issn", value: "2169-3536" }],
          url: "https://dl.acm.org/doi/example",
        }),
      ),
    ).toBeNull();
    expect(
      bundledJournalIcon(
        article({
          containerTitle: "IEEE Access",
          identifiers,
          url: "https://ieeexplore.ieee.org",
        }),
      ),
    ).toBeNull();
  });

  it("never lets a title override a valid unrecognized ISSN", () => {
    expect(
      bundledJournalIcon(
        article({
          containerTitle: "NEJM Evidence",
          identifiers: [{ scheme: "issn", value: "1234-5678" }],
        }),
      ),
    ).toBeNull();
    expect(
      bundledJournalIcon(
        article({
          containerTitle: "NEJM Evidence",
          identifiers: [{ scheme: "issn", value: "not-an-issn" }],
        }),
      )?.journalTitle,
    ).toBe("NEJM Evidence");
  });

  it("prefers identified journals to publisher and indexing-platform fallbacks", () => {
    const icon = bundledJournalIcon(
      article({
        containerTitle: "NEJM Evidence",
        identifiers: [{ scheme: "issn", value: "2766-5526" }],
        url: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
      }),
    );
    expect(icon?.journalTitle).toBe("NEJM Evidence");
    expect(icon).toBe(bundledJournalIcon(article({ containerTitle: "NEJM Evidence" })));
  });

  it("distinguishes curated journal art from publisher marks that still need discovery", () => {
    const journal = bundledJournalIcon(article({ containerTitle: "NEJM Evidence" }));
    const ieee = bundledJournalIcon(article({ containerTitle: "IEEE Access" }));
    const acm = bundledJournalIcon(article({ containerTitle: "ACM Computing Surveys" }));

    expect(journal?.source).toBe("journal");
    expect(ieee?.source).toBe("site");
    expect(ieee?.journalTitle).toBe("IEEE (publisher)");
    expect(acm?.source).toBe("site");
    expect(acm?.journalTitle).toBe("ACM (publisher)");
    expect(bundledJournalIcon(article({ containerTitle: "Nature" }))).toBeNull();
    expect(bundledJournalIcon(article({ containerTitle: "NEJM AI" }))).toBeNull();
  });

  it("uses only generic publisher/platform marks for uncurated journal URLs", () => {
    expect(
      bundledJournalIcon(
        article({
          containerTitle: "An uncurated journal",
          url: "https://dl.acm.org/doi/example",
        }),
      )?.journalTitle,
    ).toBe("ACM (publisher)");
    expect(
      bundledJournalIcon(article({ url: "https://pubmed.ncbi.nlm.nih.gov/123/" }))?.journalTitle,
    ).toBe("PubMed (platform)");
    expect(bundledJournalIcon(article({ url: "https://elifesciences.org/articles/1" }))).toBeNull();
  });

  it("does not match spoofed hosts, malformed URLs, non-web protocols, or unknown identities", () => {
    for (const url of [
      "https://acm.org.example.org/article",
      "https://notacm.org/article",
      "https://acm.org@example.org/article",
      "not a URL",
      "ftp://acm.org/article",
      "https://constructor/",
      null,
    ]) {
      expect(bundledJournalIcon(article({ containerTitle: "Unknown journal", url }))).toBeNull();
    }
  });

  it("permits named conference and preprint venues but not unrelated source types", () => {
    for (const type of ["conference-paper", "preprint"]) {
      expect(bundledJournalIcon(article({ type, containerTitle: "ACM Computing Surveys" }))).toBe(
        bundledJournalIcon(article({ containerTitle: "ACM Computing Surveys" })),
      );
    }
    expect(
      bundledJournalIcon(
        article({ type: "book", containerTitle: "NEJM Evidence", url: "https://dl.acm.org" }),
      ),
    ).toBeNull();
  });
});
