import { describe, expect, it } from "vite-plus/test";

import { sourceJournalIconInternals } from "./SourceJournalIcon";

const record = {
  formatVersion: 1 as const,
  sourceId: "source_test",
  projectId: "project_test",
  revision: 1,
  type: "article" as const,
  title: "An article",
  creators: [],
  issuedRaw: "2026",
  issuedYear: 2026,
  identifiers: [{ scheme: "doi", value: "10.1000/example" }],
  abstract: null,
  containerTitle: "Example Journal",
  publisher: "Example Publisher",
  volume: null,
  issue: null,
  pages: null,
  language: null,
  url: "https://journal.example/article",
  tags: [],
  externalReferences: [],
  attachments: [],
  fieldProvenance: [],
  importedAt: "2026-08-13T00:00:00.000Z",
};

describe("SourceJournalIcon", () => {
  it("does not request journal enrichment without a journal identity", () => {
    expect(
      sourceJournalIconInternals.canResolveJournalIcon({ ...record, containerTitle: null }),
    ).toBe(false);
    expect(sourceJournalIconInternals.canResolveJournalIcon(record)).toBe(true);
  });
});
