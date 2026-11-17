import { describe, expect, it } from "@effect/vitest";

import {
  latexPlainText,
  missingBibtexFields,
  readReferenceDocument,
  referenceDocumentKind,
} from "./referenceDocuments.ts";

describe("reference documents", () => {
  it("reads BibTeX entries with lines, plain text and identifiers from any field", () => {
    const document = readReferenceDocument(
      "bibtex",
      [
        "@string{jn = {J. Neurosci.}}",
        "% a comment @misc{ignored, title={x}}",
        "@Article{smith2020,",
        '  author = {Smith, J{\\"o}rg and Doe, A.},',
        "  title = {{The} \\emph{effect} of {X} \\& {Y}},",
        "  journal = jn,",
        "  year = 2020,",
        "  url = {https://doi.org/10.1000/ABC.123.},",
        "}",
        "@misc{arx, title = {Preprint}, eprint = {2101.00001v2}, archivePrefix = {arXiv}}",
        "@book{nobook, title = {Only a title}, isbn = {978-0-262-03384-8}}",
      ].join("\n"),
    );
    expect(document.parseError).toBeNull();
    expect(document.entries.map(({ key, type, line }) => ({ key, type, line }))).toEqual([
      { key: "smith2020", type: "article", line: 3 },
      { key: "arx", type: "misc", line: 10 },
      { key: "nobook", type: "book", line: 11 },
    ]);
    const [article, preprint, book] = document.entries;
    expect(article!.fields).toMatchObject({
      author: "Smith, Jörg and Doe, A.",
      title: "The effect of X & Y",
      year: "2020",
    });
    expect(article!.identifiers).toEqual([{ scheme: "doi", value: "10.1000/ABC.123" }]);
    expect(missingBibtexFields(article!)).toEqual([]);
    expect(preprint!.identifiers).toEqual([{ scheme: "arxiv", value: "2101.00001" }]);
    expect(book!.identifiers).toEqual([{ scheme: "isbn", value: "9780262033848" }]);
    expect(missingBibtexFields(book!)).toEqual(["author", "publisher", "year"]);
  });

  it("reads LaTeX citations outside comments, its bibliography files and bibitems", () => {
    const document = readReferenceDocument(
      "latex",
      [
        "\\documentclass{article}",
        "As shown \\citep[p.~3]{smith2020, doe2019} and \\textcite{lee}.",
        "% \\cite{commented}",
        "Escaped 50\\% \\nocite{*}",
        "\\bibliography{refs,extra.bib}",
        "\\begin{thebibliography}{9}",
        "\\bibitem{lee} Lee K. A study. Nature. 2019. doi:10.1038/xyz123.",
        "\\end{thebibliography}",
      ].join("\n"),
    );
    expect(document.citations).toEqual([
      { key: "smith2020", line: 2 },
      { key: "doe2019", line: 2 },
      { key: "lee", line: 2 },
    ]);
    expect(document.bibliographyPaths).toEqual(["refs.bib", "extra.bib"]);
    expect(document.entries).toMatchObject([
      {
        key: "lee",
        kind: "bibitem",
        line: 7,
        identifiers: [{ scheme: "doi", value: "10.1038/xyz123" }],
      },
    ]);
  });

  it("reads Pandoc citations and front-matter bibliographies but not code, emails or links", () => {
    const document = readReferenceDocument(
      "markdown",
      [
        "---",
        "title: Draft",
        "bibliography:",
        "  - refs.bib",
        "  - 'more.json'",
        "---",
        "Known [@smith2020; @doe2019, p. 4] and @lee says so.",
        "Mail me at someone@example.com or see [site](https://x.org/@handle).",
        "`@incode` and",
        "```",
        "@fenced",
        "```",
      ].join("\n"),
    );
    expect(document.bibliographyPaths).toEqual(["refs.bib", "more.json"]);
    expect(document.citations).toEqual([
      { key: "smith2020", line: 7 },
      { key: "doe2019", line: 7 },
      { key: "lee", line: 7 },
    ]);
  });

  it("reads a typed numbered reference list and its numeric citations", () => {
    const document = readReferenceDocument(
      "markdown",
      [
        "Earlier work [1, 3-4] and [2].",
        "",
        "## References",
        "",
        "1. Smith J. The effect. J Neurosci. 2020;12:100-110.",
        "   https://doi.org/10.1000/abc",
        "2. Doe A. Another. PMID: 12345.",
        "[3] Lee K. arXiv:2101.00001.",
        "4. Book without identifiers.",
      ].join("\n"),
    );
    expect(
      document.entries.map(({ key, line, identifiers }) => ({ key, line, identifiers })),
    ).toEqual([
      { key: "1", line: 5, identifiers: [{ scheme: "doi", value: "10.1000/abc" }] },
      { key: "2", line: 7, identifiers: [{ scheme: "pmid", value: "12345" }] },
      { key: "3", line: 8, identifiers: [{ scheme: "arxiv", value: "2101.00001" }] },
      { key: "4", line: 9, identifiers: [] },
    ]);
    expect(document.citations.map(({ key }) => key)).toEqual(["1", "3", "4", "2"]);
  });

  it("recognises checkable document types and plain text", () => {
    expect(["a.md", "b.TEX", "c.bib", "d.txt"].map(referenceDocumentKind)).toEqual([
      "markdown",
      "latex",
      "bibtex",
      null,
    ]);
    expect(latexPlainText("Caf\\'{e} --- \\textit{na\\\"ive}~test {\\ss}")).toBe(
      "Café — naïve test ß",
    );
  });
});
