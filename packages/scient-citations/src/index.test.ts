import type { ScientSourceRecord } from "@scientfactory/scient-sources";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { BUNDLED_CSL_STYLES, bundledCslStyleXml } from "./catalog.ts";
import {
  SCIENT_REFERENCE_STYLES,
  formatSourceReference,
  readCslStyle,
  renderableCslStyle,
  scientSourceToCslJson,
} from "./index.ts";

// Recorded from https://www.zotero.org/styles/plos-one (2026-11-11).
const PLOS_ONE = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" default-locale="en-US">
  <info>
    <title>PLOS ONE</title>
    <id>http://www.zotero.org/styles/plos-one</id>
    <link href="http://www.zotero.org/styles/plos-one" rel="self"/>
    <link href="http://www.zotero.org/styles/plos" rel="independent-parent"/>
    <category citation-format="numeric"/>
    <updated>2014-06-05T22:31:00+00:00</updated>
    <rights license="http://creativecommons.org/licenses/by-sa/3.0/">This work is licensed under a Creative Commons Attribution-ShareAlike 3.0 License</rights>
  </info>
</style>
`;

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
      keyword: "methods",
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
  // Building a style's citation engine is a one-time cost per process (over a
  // second for APA locally, several on a loaded CI runner). Pay it here so the
  // tests below time only rendering.
  beforeAll(() => {
    for (const style of SCIENT_REFERENCE_STYLES) formatSourceReference(article, style.id);
  });

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

  it("renders a source's current metadata after rendering it before an edit", () => {
    const edited: ScientSourceRecord = {
      ...article,
      revision: 2,
      title: "A Corrected Title",
      creators: [
        { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
      ],
    };

    expect(formatSourceReference(edited, "apa")).toBe(
      "Lovelace, A. (2005). A Corrected Title. PLOS Medicine, 2(8), e124. https://doi.org/10.1371/journal.pmed.0020124",
    );
    expect(formatSourceReference(edited, "vancouver")).toBe(
      "1. Lovelace A. A Corrected Title. PLOS Medicine. 2005;2(8):e124. doi:10.1371/journal.pmed.0020124",
    );
  });

  it("renders a dependent style with its parent's layout", () => {
    expect(readCslStyle(PLOS_ONE)).toMatchObject({ id: "plos-one", parentId: "plos" });
    const xml = renderableCslStyle(PLOS_ONE, bundledCslStyleXml("plos"));

    expect(formatSourceReference(article, { xml })).toBe(
      "1.  Ioannidis JPA. Why Most Published Research Findings Are False. PLOS Medicine. 2005;2: e124. doi:10.1371/journal.pmed.0020124",
    );
  });
});

// regression: review B4-1, a file with the shape of a CSL style counted as usable whatever it held
describe("readCslStyle", () => {
  const nature = bundledCslStyleXml("nature")!;
  const head = nature.slice(0, nature.indexOf("</info>") + "</info>".length);
  const style = (layout: string, sort = "") =>
    `${head}<macro name="title"><text variable="title"/></macro><macro name = 'a&amp;b'><text variable="title"/></macro><citation>${sort}<layout>${layout}</layout></citation><bibliography><layout>${layout}</layout></bibliography></style>`;
  const forBooks = (text: string) =>
    `<choose><if type="book">${text}</if><else><text macro="title"/></else></choose>`;

  it("reads every bundled style, and a style that prints only some source types", () => {
    expect(
      BUNDLED_CSL_STYLES.filter((entry) => !readCslStyle(bundledCslStyleXml(entry.id)!)),
    ).toEqual([]);
    expect(
      readCslStyle(style('<choose><if type="book"><text macro="title"/></if></choose>')),
    ).not.toBeNull();
    // The style repository holds styles that end in a comment.
    expect(
      readCslStyle(
        `${head}<citation><layout><text variable="title"/></layout></citation></style>\n<!-- end -->\n`,
      ),
    ).not.toBeNull();
  });

  // regression: review B4-3, macro names were compared as written, not as XML reads them
  it("reads a macro name as XML does, and a dependent style written with spaces", () => {
    expect(readCslStyle(style('<text prefix=">" macro="a&#38;b"/>'))).not.toBeNull();
    const spaced = PLOS_ONE.replace('default-locale="en-US"', "default-locale = 'en-GB'").replace(
      'rel="independent-parent"',
      "rel = 'independent-parent'",
    );
    expect(readCslStyle(spaced)).toMatchObject({ parentId: "plos", defaultLocale: "en-GB" });
    const parent = bundledCslStyleXml("plos")!.replace(
      'default-locale="en-US"',
      "default-locale = 'en-US'",
    );
    expect(readCslStyle(renderableCslStyle(spaced, parent))?.defaultLocale).toBe("en-GB");
  });

  const title = '<text variable="title"/>';
  it.each([
    ["names an undefined macro in a branch", forBooks('<text macro="missing"/>'), ""],
    ["names one after a > and around a spaced =", '<text prefix=">" macro = "missing"/>', ""],
    ["sorts by an undefined macro", title, "<sort><key macro\n= 'missing'/></sort>"],
    ["has markup that does not close", forBooks('<text variable="title">'), ""],
    ["has an attribute without quotes", "<text variable=title/>", ""],
  ])("rejects a style that %s", (_name, layout, sort) => {
    expect(
      readCslStyle(style(forBooks(title), "<sort><key macro='title'/></sort>")),
    ).not.toBeNull();
    expect(readCslStyle(style(layout, sort))).toBeNull();
  });
});
