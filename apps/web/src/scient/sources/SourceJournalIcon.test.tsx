import { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

import { SourceJournalIcon } from "./SourceJournalIcon";

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

it("includes bundled artwork in the first render without article links or a journal lookup", () => {
  const resolveIcon = vi.fn(async () => null);
  for (const identity of [
    { containerTitle: "NEJM Evidence", identifiers: [] },
    { containerTitle: null, identifiers: [{ scheme: "issn", value: "2766-5526" }] },
  ]) {
    const markup = renderToStaticMarkup(
      <SourceJournalIcon
        environmentId={EnvironmentId.make("environment-test")}
        root="/project"
        record={{ ...record, ...identity, url: null }}
        resolveIcon={resolveIcon}
      />,
    );
    expect(markup).toContain("<img");
    expect(markup).not.toContain('data-testid="source-generic-icon"');
  }
  expect(resolveIcon).not.toHaveBeenCalled();
});

// regression: 4e05b272c1 feat(sources): complete reference intake workflows
it("renders the type's icon immediately and does not wait for journal lookup", () => {
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
