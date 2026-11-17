import { describe, expect, it } from "vite-plus/test";

import { bundledJournalMark } from "./bundledJournalIcons";

type MarkRecord = Parameters<typeof bundledJournalMark>[0];

const article = (overrides: Partial<MarkRecord> = {}): MarkRecord => ({
  type: "article",
  containerTitle: null,
  publisher: null,
  identifiers: [],
  ...overrides,
});

describe("bundledJournalMark", () => {
  it("matches NEJM Evidence by its title, abbreviation or ISSN", () => {
    const mark = bundledJournalMark(article({ containerTitle: "NEJM Evidence" }));
    expect(mark).toMatchObject({ kind: "journal", label: "Journal: NEJM Evidence" });
    expect(bundledJournalMark(article({ containerTitle: "  NEJM. EVID.  " }))).toBe(mark);
    expect(
      bundledJournalMark(
        article({
          containerTitle: "Evidence",
          identifiers: [{ scheme: "eissn", value: "2766-5526" }],
        }),
      ),
    ).toBe(mark);
    // A second, unlisted ISSN of the same record does not undo the match.
    expect(
      bundledJournalMark(
        article({
          containerTitle: "NEJM Evidence",
          identifiers: [
            { scheme: "issn", value: "2766-5526" },
            { scheme: "issn", value: "1234-5679" },
          ],
        }),
      ),
    ).toBe(mark);
  });

  it("lets an ISSN decide over a title, and never matches a neighbour journal", () => {
    expect(
      bundledJournalMark(
        article({
          containerTitle: "NEJM Evidence",
          identifiers: [{ scheme: "issn", value: "1234-5679" }],
        }),
      ),
    ).toBeNull();
    for (const containerTitle of [
      "NEJM AI",
      "NEJM Evidence Advances",
      "New England Journal of Medicine",
    ]) {
      expect(bundledJournalMark(article({ containerTitle }))).toBeNull();
    }
    expect(
      bundledJournalMark(article({ identifiers: [{ scheme: "doi", value: "2766-5526" }] })),
    ).toBeNull();
  });

  it("never puts a publisher's logo on a journal", () => {
    for (const [containerTitle, publisher] of [
      ["IEEE Access", "IEEE"],
      ["ACM Computing Surveys", "Association for Computing Machinery"],
    ] as const) {
      expect(bundledJournalMark(article({ containerTitle, publisher }))).toBeNull();
    }
  });

  it("treats a journal abbreviation alone as a venue", () => {
    expect(
      bundledJournalMark(article({ containerTitleShort: "IEEE Access", publisher: "IEEE" })),
    ).toBeNull();
    expect(bundledJournalMark(article({ containerTitleShort: "NEJM Evid" }))).toMatchObject({
      kind: "journal",
    });
  });

  it("shows a publisher mark for a record with no venue and exactly that publisher", () => {
    expect(bundledJournalMark(article({ type: "book", publisher: "IEEE" }))).toMatchObject({
      kind: "publisher",
      label: "Publisher: IEEE",
    });
    expect(
      bundledJournalMark(
        article({ type: "report", publisher: "Association for Computing Machinery" }),
      ),
    ).toMatchObject({ label: "Publisher: ACM" });
    for (const publisher of ["IEEE Computer Society Press", "ACM Press, New York", null]) {
      expect(bundledJournalMark(article({ type: "book", publisher }))).toBeNull();
    }
  });

  it("ignores a book chapter's book title", () => {
    expect(
      bundledJournalMark(article({ type: "book-chapter", containerTitle: "NEJM Evidence" })),
    ).toBeNull();
  });
});
