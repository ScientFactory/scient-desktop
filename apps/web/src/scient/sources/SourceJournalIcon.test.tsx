import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";

import { SourceJournalIcon } from "./SourceJournalIcon";

type SourceRecord = ScientSourcesOverviewResult["records"][number];

const record: SourceRecord = {
  sourceId: "source_test",
  revision: 1,
  type: "article",
  title: "An article",
  creators: [],
  issuedYear: 2026,
  identifiers: [{ scheme: "doi", value: "10.1000/example" }],
  containerTitle: "New England Journal of Medicine",
  publisher: "Massachusetts Medical Society",
  url: "https://journal.example/article",
  externalReferences: [],
  attachments: [],
  importedAt: "2026-08-13T00:00:00.000Z",
};

const render = (overrides: Partial<SourceRecord>, announce = false) =>
  renderToStaticMarkup(
    <SourceJournalIcon record={{ ...record, ...overrides }} announce={announce} />,
  );

it("draws a journal's generated mark in the first render", () => {
  const markup = render({});
  expect(markup).toContain('data-testid="source-journal-mark"');
  expect(markup).toContain(">NEJM</text>");
  expect(markup).not.toContain("<img");
});

it("prefers the journal abbreviation for the letters and keeps the full title for its name", () => {
  const markup = render(
    {
      containerTitle: "Journal of the American College of Cardiology",
      containerTitleShort: "J Am Coll Cardiol",
    },
    true,
  );
  expect(markup).toContain(">JACC</text>");
  expect(markup).toContain("Journal: Journal of the American College of Cardiology");
});

it("shows a checked bundled mark for its exact journal only", () => {
  expect(render({ containerTitle: "NEJM Evidence", identifiers: [] })).toContain("<img");
  const access = render({ containerTitle: "IEEE Access", publisher: "IEEE" });
  expect(access).not.toContain("<img");
  expect(access).toContain(">IA</text>");
});

it("shows a publisher mark only for a record that names no venue", () => {
  const book = render({ type: "book", containerTitle: null, publisher: "IEEE" }, true);
  expect(book).toContain("<img");
  expect(book).toContain("Publisher: IEEE");
  expect(render({ type: "book", containerTitle: null, publisher: "IEEE Press Books" })).toContain(
    'data-testid="source-generic-icon"',
  );
});

it("keeps the type icon where the container is not a venue or there is no name", () => {
  for (const overrides of [
    { type: "book-chapter" as const, containerTitle: "A Handbook of Methods" },
    { containerTitle: null },
    { containerTitle: "  " },
  ]) {
    const markup = render(overrides, true);
    expect(markup).toContain('data-testid="source-generic-icon"');
    expect(markup).not.toContain('data-testid="source-journal-mark"');
  }
});

it("names the venue for screen readers only when asked", () => {
  expect(render({}, true)).toContain(
    '<span class="sr-only">Journal: New England Journal of Medicine</span>',
  );
  expect(render({})).not.toContain("sr-only");
  expect(render({ type: "preprint", containerTitle: "bioRxiv" }, true)).toContain(
    "Preprint server: bioRxiv",
  );
});
