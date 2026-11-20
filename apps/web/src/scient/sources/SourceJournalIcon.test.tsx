import { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

import { SourceJournalCover, SourceJournalIcon } from "./SourceJournalIcon";

vi.mock("gt-react", async (importOriginal) =>
  (await import("~/scient/testing/englishGTReact")).englishGTReact(await importOriginal()),
);

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

it("shows the publisher's icon in the first render, named in its tooltip", () => {
  const markup = renderToStaticMarkup(
    <SourceJournalIcon
      record={{ ...record, identifiers: [{ scheme: "doi", value: "10.1136/bmj.n71" }] }}
    />,
  );
  expect(markup).toContain("<img");
  expect(markup).toMatch(/bmj[^"]*\.png/u);
  expect(markup).not.toContain('data-testid="source-generic-icon"');
});

// regression: PubMed imports link to pubmed.gov, which says nothing about the journal
it("shows the type's icon, never PubMed's, when only a PubMed link is known", () => {
  const markup = renderToStaticMarkup(
    <SourceJournalIcon
      record={{
        ...record,
        identifiers: [{ scheme: "pmid", value: "32098899" }],
        url: "https://pubmed.ncbi.nlm.nih.gov/32098899/",
      }}
    />,
  );
  expect(markup).toContain('data-testid="source-generic-icon"');
  expect(markup).not.toContain("<img");
});

// regression: 4e05b272c1 feat(sources): complete reference intake workflows
it("renders no cover and asks the environment for nothing before the card is shown", () => {
  const resolveIcon = vi.fn(async () => null);
  const markup = renderToStaticMarkup(
    <SourceJournalCover
      environmentId={EnvironmentId.make("environment-test")}
      root="/project"
      record={record}
      resolveIcon={resolveIcon}
    />,
  );
  expect(markup).not.toContain("<img");
  expect(resolveIcon).not.toHaveBeenCalled();
});
