import { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SourceJournalIcon, sourceJournalIconInternals } from "./SourceJournalIcon";

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
  it("renders the book immediately and does not wait for journal lookup", () => {
    const resolveIcon = vi.fn(async () => null);
    const markup = renderToStaticMarkup(
      <SourceJournalIcon
        environmentId={EnvironmentId.make("environment-test")}
        root="/project"
        record={record}
        resolveIcon={resolveIcon}
      />,
    );
    expect(markup).toContain('data-testid="source-generic-icon"');
    expect(markup).not.toContain("<img");
    expect(resolveIcon).not.toHaveBeenCalled();
  });

  it("does not request journal enrichment without a journal identity", () => {
    expect(
      sourceJournalIconInternals.canResolveJournalIcon({ ...record, containerTitle: null }),
    ).toBe(false);
    expect(sourceJournalIconInternals.canResolveJournalIcon(record)).toBe(true);
  });
});
