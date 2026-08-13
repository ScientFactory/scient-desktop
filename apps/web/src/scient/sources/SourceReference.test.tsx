import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SourceReference } from "./SourceReference";

const record = {
  formatVersion: 1 as const,
  sourceId: "source_test",
  projectId: "project_test",
  revision: 1,
  type: "article" as const,
  title: "A source title",
  creators: [],
  issuedRaw: "2026",
  issuedYear: 2026,
  identifiers: [],
  abstract: null,
  containerTitle: "A journal",
  publisher: null,
  volume: null,
  issue: null,
  pages: null,
  language: "en",
  url: null,
  tags: [],
  externalReferences: [],
  attachments: [],
  fieldProvenance: [],
  importedAt: "2026-08-12T12:00:00.000Z",
};

describe("SourceReference", () => {
  it("exposes the offline style selector while the formatter loads lazily", () => {
    const markup = renderToStaticMarkup(<SourceReference record={record} />);

    expect(markup).toContain("Reference");
    expect(markup).toContain('aria-label="Reference style"');
    expect(markup).toContain("Vancouver");
    expect(markup).toContain("Preparing reference");
  });
});
