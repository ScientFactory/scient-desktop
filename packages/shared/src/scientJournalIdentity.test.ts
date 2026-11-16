import { expect, it } from "@effect/vitest";
import { journalIconIdentity } from "./scientJournalIdentity.ts";

const journal = {
  type: "article",
  containerTitle: "Example Journal",
  publisher: "Example Publisher",
  identifiers: [],
};

it("shares normalized ISSN identity despite changes to the journal title or publisher", () => {
  expect(
    journalIconIdentity({ ...journal, identifiers: [{ scheme: "ISSN", value: "0028-0836" }] }),
  ).toBe(
    journalIconIdentity({
      ...journal,
      containerTitle: "Renamed Journal",
      publisher: "New Publisher",
      identifiers: [
        { scheme: "eissn", value: "00280836" },
        { scheme: "doi", value: "10.1/article" },
      ],
    }),
  );
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

it("does not use journal artwork for other source types or an unnamed journal", () => {
  expect(journalIconIdentity({ ...journal, type: "book" })).toBeNull();
  expect(journalIconIdentity({ ...journal, containerTitle: " " })).toBeNull();
});
