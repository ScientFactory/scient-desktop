import { expect, it } from "@effect/vitest";
import { journalIconIdentity } from "./scientJournalIdentity.ts";

const journal = {
  type: "article",
  containerTitle: "Example Journal",
  publisher: "Example Publisher",
  identifiers: [],
};

it("shares normalized ISSNs only when the displayed venue and publisher evidence agree", () => {
  const record = { ...journal, identifiers: [{ scheme: "ISSN", value: "0028-0836" }] };
  const identity = journalIconIdentity(record);
  expect(
    journalIconIdentity({
      ...record,
      containerTitle: " EXAMPLE   JOURNAL ",
      publisher: "Example Publisher",
      identifiers: [
        { scheme: "eissn", value: "00280836" },
        { scheme: "doi", value: "10.1/article" },
      ],
    }),
  ).toBe(identity);
  expect(journalIconIdentity({ ...record, publisher: "Another Publisher" })).not.toBe(identity);
  expect(journalIconIdentity({ ...record, containerTitle: "Another Journal" })).not.toBe(identity);
  expect(journalIconIdentity({ ...record, type: "preprint" })).not.toBe(identity);
});

it("normalizes title-based identity but does not merge journals from different publishers", () => {
  const identity = journalIconIdentity(journal);
  expect(
    journalIconIdentity({
      ...journal,
      containerTitle: "  ＥＸＡＭＰＬＥ   Journal ",
      publisher: " EXAMPLE   PUBLISHER ",
    }),
  ).toBe(identity);
  expect(journalIconIdentity({ ...journal, publisher: "Another Publisher" })).not.toBe(identity);
  expect(
    journalIconIdentity({ ...journal, identifiers: [{ scheme: "issn", value: "invalid" }] }),
  ).toBe(identity);
});

it("shares the venue identity across published articles and conference records", () => {
  expect(journalIconIdentity({ ...journal, type: "conference-paper" })).toBe(
    journalIconIdentity(journal),
  );
});

it("does not use journal artwork for other source types or an unnamed journal", () => {
  expect(journalIconIdentity({ ...journal, type: "book" })).toBeNull();
  expect(journalIconIdentity({ ...journal, containerTitle: " " })).toBeNull();
});
