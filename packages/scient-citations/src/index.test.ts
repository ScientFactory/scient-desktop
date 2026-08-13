import type { ScientSourceRecord } from "@scientfactory/scient-sources";
import { describe, expect, it } from "vite-plus/test";

import { formatSourceReference, scientSourceToCslJson } from "./index.ts";

const article: ScientSourceRecord = {
  formatVersion: 1,
  sourceId: "source_test",
  projectId: "project_test",
  revision: 1,
  type: "article",
  title: "Why Most Published Research Findings Are False",
  creators: [
    {
      creatorType: "author",
      givenName: "John P. A.",
      familyName: "Ioannidis",
      literalName: null,
    },
  ],
  issuedRaw: "2005",
  issuedYear: 2005,
  identifiers: [{ scheme: "doi", value: "10.1371/journal.pmed.0020124" }],
  abstract: "A testable abstract.",
  containerTitle: "PLOS Medicine",
  publisher: "Public Library of Science",
  volume: "2",
  issue: "8",
  pages: "e124",
  language: "en",
  url: "https://example.com/article",
  tags: ["methods"],
  externalReferences: [],
  attachments: [],
  fieldProvenance: [],
  importedAt: "2026-08-12T12:00:00.000Z",
};

describe("scientSourceToCslJson", () => {
  it("maps stable Scient metadata without depending on its Zotero origin", () => {
    expect(scientSourceToCslJson(article)).toEqual({
      id: "source_test",
      type: "article-journal",
      title: "Why Most Published Research Findings Are False",
      author: [{ given: "John P. A.", family: "Ioannidis" }],
      issued: { "date-parts": [[2005]] },
      abstract: "A testable abstract.",
      "container-title": "PLOS Medicine",
      publisher: "Public Library of Science",
      volume: "2",
      issue: "8",
      page: "e124",
      language: "en",
      URL: "https://example.com/article",
      DOI: "10.1371/journal.pmed.0020124",
    });
  });

  it("preserves corporate authors and distinct editor roles", () => {
    expect(
      scientSourceToCslJson({
        ...article,
        type: "book",
        creators: [
          { creatorType: "author", givenName: null, familyName: null, literalName: "WHO" },
          {
            creatorType: "editor",
            givenName: "Ada",
            familyName: "Editor",
            literalName: null,
          },
        ],
      }),
    ).toMatchObject({
      type: "book",
      author: [{ literal: "WHO" }],
      editor: [{ given: "Ada", family: "Editor" }],
    });
  });

  it("preserves a researcher-defined source type as citation genre", () => {
    expect(
      scientSourceToCslJson({ ...article, type: "other", customType: "Clinical guideline" }),
    ).toMatchObject({ type: "document", genre: "Clinical guideline" });
  });
});

describe("formatSourceReference", () => {
  it("renders a Vancouver bibliography entry", () => {
    expect(formatSourceReference(article, "vancouver")).toBe(
      "1. Ioannidis JPA. Why Most Published Research Findings Are False. PLOS Medicine. 2005;2(8):e124. doi:10.1371/journal.pmed.0020124",
    );
  });

  it("renders an APA 7 bibliography entry from the same source truth", () => {
    expect(formatSourceReference(article, "apa")).toBe(
      "Ioannidis, J. P. A. (2005). Why Most Published Research Findings Are False. PLOS Medicine, 2(8), e124. https://doi.org/10.1371/journal.pmed.0020124",
    );
  });
});
