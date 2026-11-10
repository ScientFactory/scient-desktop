// @effect-diagnostics nodeBuiltinImport:off -- Parser fixtures are read synchronously from disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ScientSourceCandidate, ScientSourceRecord } from "../model.ts";
import {
  BIBLIOGRAPHY_FORMATS,
  bibliographyExportItems,
  detectBibliographyFormat,
  exportBibliographyFile,
  formatBibliography,
  parseBibliography,
  planBibliographyImport,
  type BibliographyEntry,
  type BibliographyFormat,
} from "./index.ts";
import { parseBibtex } from "./bibtex.ts";
import { decodeLatex, encodeLatexTitle } from "./latex.ts";

const fixture = (name: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures", name), "utf8");

function parseFixture(name: string) {
  const text = fixture(name);
  const format = detectBibliographyFormat(name, text);
  if (!format) throw new Error(`No format detected for ${name}`);
  return parseBibliography(text, format);
}

const byKey = (entries: ReadonlyArray<BibliographyEntry>, key: string) => {
  const entry = entries.find((candidate) => candidate.citationKey === key);
  if (!entry) throw new Error(`Missing ${key}`);
  return entry;
};

const author = (givenName: string | null, familyName: string | null, literalName = null) => ({
  creatorType: "author",
  givenName,
  familyName,
  literalName,
});

describe("LaTeX text", () => {
  it.each([
    [String.raw`M{\"u}ller`, "Müller"],
    [String.raw`\'{E}cole \c{c}a \v{S}koda \aa{} Stra\ss e \o`, "École ça Škoda å Straße ø"],
    [String.raw`na\"{\i}ve \H{o} \k{a}`, "naïve ő ą"],
    [String.raw`\emph{E.~coli} and \textit{in vivo}`, "E. coli and in vivo"],
    [String.raw`50\% \& \$5 \_x \#1`, "50% & $5 _x #1"],
    ["``quoted'' 1--2 a---b", "“quoted” 1–2 a\u2014b"],
    [String.raw`$\alpha$-helix \href{https://x.org}{site}`, "α-helix site"],
  ])("decodes %s", (input, expected) => {
    expect(decodeLatex(input)).toBe(expected);
  });

  it("decodes deeply nested groups and commands without exhausting the stack", () => {
    const depth = 12_000;
    expect(decodeLatex(`${"{".repeat(depth)}deep${"}".repeat(depth)}`)).toBe("deep");
    expect(decodeLatex(`${String.raw`\emph{`.repeat(depth)}deep${"}".repeat(depth)}`)).toBe("deep");
  });

  it("protects acronyms and escapes specials in titles", () => {
    expect(encodeLatexTitle("mRNA & DNA in 50% of iPhone users")).toBe(
      String.raw`{mRNA} \& {DNA} in 50\% of {iPhone} users`,
    );
  });
});

describe("BibTeX import", () => {
  it("reads JabRef strings, months, accents, institutions and crossrefs", () => {
    const { entries, unreadable } = parseFixture("jabref.bib");
    expect(unreadable).toEqual([]);
    const article = byKey(entries, "Mueller2019");
    expect(article).toMatchObject({
      type: "article",
      title: "The CRISPR–Cas9 system in E. coli: a review",
      containerTitle: "Nature",
      issuedRaw: "2019-03",
      issuedYear: 2019,
      pages: "101-110",
      tags: ["gene editing", "bacteria", "review"],
      identifiers: [{ scheme: "doi", value: "10.1038/s41586-019-0001-x" }],
      notKept: ["address"],
    });
    expect(article.creators).toEqual([
      author("Jörg", "Müller"),
      author("Anna", "van der Berg"),
      {
        creatorType: "author",
        givenName: null,
        familyName: null,
        literalName: "World Health Organization",
      },
    ]);
    expect(byKey(entries, "Smith2020")).toMatchObject({
      type: "conference-paper",
      containerTitle: "Proceedings of the Conference on Example Learning 2020",
      publisher: "Example Press",
      issuedYear: 2020,
    });
  });

  it("keeps Better BibTeX keys and identifiers and reports what has no home", () => {
    const { entries } = parseFixture("zotero-bbt.bib");
    expect(entries.map((entry) => entry.citationKey)).toEqual([
      "garcia_deep_2021",
      "knuth_art_1997",
      "lee_thesis_2018",
      "who_guidelines_2022",
    ]);
    const article = byKey(entries, "garcia_deep_2021");
    expect(article.identifiers).toEqual([
      { scheme: "doi", value: "10.1038/S41467-021-00002-Y" },
      { scheme: "pmid", value: "34000001" },
      { scheme: "issn", value: "2041-1723" },
    ]);
    expect(article.abstract).toBe("Background: We study reconstruction.\n\nResults: It works.");
    expect(article.note).toBe("Publisher: Nature Publishing Group");
    expect(article.notKept).toEqual(["urldate", "file"]);
    expect(byKey(entries, "knuth_art_1997").identifiers).toHaveLength(2);
    expect(byKey(entries, "lee_thesis_2018")).toMatchObject({
      type: "thesis",
      publisher: "Example University",
    });
    expect(byKey(entries, "who_guidelines_2022")).toMatchObject({
      type: "web",
      url: "https://www.who.int/example",
    });
  });

  it("reads Mendeley escapes and arXiv eprints", () => {
    const [entry] = parseFixture("mendeley.bib").entries;
    expect(entry).toMatchObject({
      citationKey: "Kowalski2015",
      title: "Alpha decay in samples",
      abstract: "We measured the $α$ decay in 50% of samples & controls.",
      tags: ["decay"],
      notKept: ["file"],
    });
    expect(entry?.identifiers.map((identifier) => identifier.scheme)).toEqual([
      "doi",
      "arxiv",
      "issn",
    ]);
    expect(entry?.creators[1]).toEqual(author("Jan", "Novák"));
  });

  it("turns a Google Scholar arXiv article into a preprint and reports a truncated author list", () => {
    const [entry] = parseFixture("scholar.bib").entries;
    expect(entry).toMatchObject({
      type: "preprint",
      containerTitle: "arXiv",
      identifiers: [{ scheme: "arxiv", value: "1706.03762" }],
      notKept: ["author (“and others”)"],
    });
    expect(entry?.creators).toHaveLength(3);
  });

  it("refuses @string expansions past the value and file budgets instead of allocating them", () => {
    const doubling = Array.from(
      { length: 24 },
      (_, index) => `@string{a${index + 1} = a${index} # a${index}}`,
    );
    const copies = Array.from({ length: 130 }, (_, index) => `@string{c${index} = a17}`);
    const text = [
      '@string{a0 = "X"}',
      ...doubling,
      ...copies,
      "@misc{doubled, title = a24}",
      "@misc{copied, title = c129}",
    ].join("\n");
    const { entries, unreadable } = parseBibtex(text);
    const reasons = unreadable.map((entry) => entry.reason).join("\n");
    expect(reasons).toContain("A field value is too long once @string macros are expanded.");
    expect(reasons).toContain("@string macros expand to more text than a reference file can hold.");
    for (const entry of entries) expect(entry.title?.length ?? 0).toBeLessThanOrEqual(256 * 1024);
  });

  it("skips a damaged entry with its line and keeps reading", () => {
    const { entries, unreadable } = parseFixture("broken.bib");
    expect(entries.map((entry) => entry.citationKey)).toEqual(["good1", "good2", null, "empty"]);
    expect(byKey(entries, "good2").title).toBe('Second "good" entry');
    expect(unreadable).toEqual([expect.objectContaining({ line: 7, citationKey: "broken" })]);
  });
});

describe("RIS import", () => {
  it("reads Zotero RIS (Windows line endings) with full dates, pages, notes and standard numbers", () => {
    const { entries } = parseBibliography(fixture("zotero.ris").replace(/\n/gu, "\r\n"), "ris");
    expect(entries[0]).toMatchObject({
      type: "article",
      title: "Sleep and memory consolidation",
      containerTitle: "Journal of Sleep Examples",
      issuedRaw: "2020-05-14",
      pages: "45-52",
      note: "Read for chapter 2",
      tags: ["sleep", "memory"],
      identifiers: [
        { scheme: "doi", value: "10.1000/jse.2020.1" },
        { scheme: "issn", value: "1234-5679" },
      ],
      notKept: ["CY"],
    });
    expect(entries[1]).toMatchObject({
      type: "book",
      identifiers: [{ scheme: "isbn", value: "9780000000002" }],
      notKept: ["ET"],
    });
  });

  it("reads Mendeley RIS: continuation lines, DOI URLs, IDs as keys, editors and custom types", () => {
    const { entries } = parseFixture("mendeley.ris");
    expect(entries[0]).toMatchObject({
      citationKey: "Nguyen2019",
      abstract: "First line of the abstract\ncontinues on a second line.",
      identifiers: [{ scheme: "doi", value: "10.1000/ecol.2019.7" }],
      pages: "12-20",
    });
    expect(entries[1]).toMatchObject({
      type: "book-chapter",
      containerTitle: "Handbook of Examples",
      issuedRaw: "2018",
    });
    expect(entries[1]?.creators[1]?.creatorType).toBe("editor");
    expect(entries[2]).toMatchObject({ type: "other", customType: "Patent" });
  });
});

describe("CSL-JSON import", () => {
  it("reads Zotero CSL-JSON keys from the note, particles, dates and arXiv numbers", () => {
    const { entries, unreadable } = parseFixture("zotero-csl.json");
    expect(entries[0]).toMatchObject({
      citationKey: "silva2018coral",
      issuedRaw: "2018-07-01",
      pages: "10-19",
      note: "Two reefs studied",
      notKept: ["accessed"],
    });
    expect(entries[0]?.creators[1]).toEqual(author("Ludwig", "van Beethoven"));
    expect(entries[1]).toMatchObject({
      citationKey: "patel2022",
      type: "preprint",
      identifiers: [{ scheme: "arxiv", value: "2201.00001" }],
      tags: ["proteins", "folding"],
      issue: null,
    });
    expect(unreadable).toEqual([expect.objectContaining({ reason: "Item 3 is not a CSL item." })]);
  });

  it("does not treat Zotero item URIs or numbers as citation keys", () => {
    const { entries } = parseBibliography(
      JSON.stringify([
        { id: "http://zotero.org/users/1/items/AAAA", type: "book", title: "A" },
        { id: 17, type: "book", title: "B" },
      ]),
      "csl-json",
    );
    expect(entries.map((entry) => entry.citationKey)).toEqual([null, null]);
  });

  it("reports invalid JSON as unreadable", () => {
    expect(parseBibliography("[{", "csl-json").unreadable).toEqual([
      { line: null, citationKey: null, reason: "The file is not valid JSON." },
    ]);
  });
});

describe("EndNote XML import", () => {
  it("reads styled text, corporate authors, PubMed accession numbers and labels", () => {
    const { entries } = parseFixture("endnote.xml");
    expect(entries[0]).toMatchObject({
      citationKey: "Ahmed2016",
      type: "article",
      title: "Blood pressure & salt",
      containerTitle: "Example Cardiology",
      note: "Key paper",
      tags: ["hypertension", "diet"],
      identifiers: [
        { scheme: "doi", value: "10.1000/cardio.22.4" },
        { scheme: "issn", value: "0000-1111" },
        { scheme: "pmid", value: "27000001" },
      ],
      notKept: ["urls/pdf-urls", "auth-address"],
    });
    expect(entries[0]?.creators[2]?.literalName).toBe("Heart Study Consortium");
    expect(entries[1]).toMatchObject({
      type: "book-chapter",
      containerTitle: "The Example Heart Book",
      notKept: ["pub-location"],
    });
    expect(entries[1]?.creators[1]?.creatorType).toBe("editor");
  });
});

describe("format detection", () => {
  it.each([
    ["refs.txt", "﻿[{}]", "csl-json"],
    ["refs.txt", "<?xml version='1.0'?><xml>", "endnote-xml"],
    ["refs.txt", "\nTY  - JOUR\n", "ris"],
    ["refs.txt", "% comment\n@article{a,", "bibtex"],
    ["refs.bib", "", "bibtex"],
    ["notes.txt", "plain text", null],
  ] as const)("detects %s %j", (name, text, expected) => {
    expect(detectBibliographyFormat(name, text)).toBe(expected);
  });
});

const decodeCandidate = Schema.decodeUnknownSync(ScientSourceCandidate);
const decodeRecord = Schema.decodeUnknownSync(ScientSourceRecord);

function existingRecord(doi: string) {
  return decodeRecord({
    formatVersion: 1,
    sourceId: "source_existing",
    projectId: "project",
    revision: 1,
    type: "article",
    title: "Existing",
    creators: [],
    issuedRaw: null,
    issuedYear: null,
    identifiers: [{ scheme: "doi", value: doi }],
    abstract: null,
    containerTitle: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: null,
    tags: [],
    externalReferences: [],
    attachments: [],
    fieldProvenance: [],
    importedAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("import plan", () => {
  const bib = String.raw`
@article{a, title={One}, author={A, B}, year=2001, doi={10.1000/one}, address={Here}}
@article{b, title={Two}, author={C, D}, year=2002, doi={10.1000/TWO}}
@article{c, title={Two again}, author={C, D}, year=2002, doi={https://doi.org/10.1000/two}}
@article{a, title={One}, author={A, B}, year=2001, doi={10.1000/one}, address={Here}}
@article{d, title={Three}, year=2003}
@article{e, title={Four}, year=2004}
@article{f, year=2005}
`;
  const plan = (limit: number) =>
    planBibliographyImport({
      parse: parseBibliography(bib, "bibtex"),
      existing: [existingRecord("10.1000/one")],
      sourceKeyFor: (identity) =>
        `file_${identity.length}_${identity.slice(-24).replace(/\W/gu, "")}`,
      sourceIdFor: (sourceKey) => `source_${sourceKey}`,
      limit,
    });

  it("leaves out repeats, sources already in the Library and empty entries, then batches the rest", () => {
    const { candidates, report } = plan(2);
    expect(candidates.map((candidate) => candidate.title)).toEqual(["Two", "Three"]);
    expect(report).toMatchObject({
      format: "bibtex",
      entryCount: 7,
      importCount: 2,
      alreadyInLibrary: 1,
      remaining: 1,
      unreadableCount: 3,
      withoutCitationKey: 0,
      notKept: [{ field: "address", entryCount: 1, citationKeys: ["a"] }],
    });
    expect(report.unreadable.map((entry) => entry.reason)).toEqual([
      "This entry has the same identifier as the entry on line 3.",
      "This entry repeats the entry on line 2.",
      "This entry has no title, author or identifier.",
    ]);
  });

  it("builds candidates the store accepts, with file provenance and the note", () => {
    const parsed = parseFixture("zotero-bbt.bib");
    const { candidates } = planBibliographyImport({
      parse: parsed,
      existing: [],
      sourceKeyFor: (identity) => `file_${identity.length}`,
      sourceIdFor: (sourceKey) => `source_${sourceKey}`,
      limit: 10,
    });
    const article = decodeCandidate(candidates[0]);
    expect(article.note).toBe("Publisher: Nature Publishing Group");
    expect(article.identifiers[0]).toEqual({ scheme: "doi", value: "10.1038/s41467-021-00002-y" });
    expect(article.fieldProvenance).toContainEqual({
      field: "containerTitle",
      origin: "file",
      sourceField: "bibtex:journal",
    });
    expect(article.fieldProvenance).toContainEqual({
      field: "issuedYear",
      origin: "file",
      sourceField: "bibtex:year",
    });
  });
});

describe("export", () => {
  const record = decodeRecord({
    formatVersion: 1,
    sourceId: "source_1",
    projectId: "project",
    revision: 3,
    type: "article",
    title: "Gene drives in {Anopheles} & mRNA 50% study",
    creators: [
      author("Jörg", "Müller"),
      author("Anna", "van der Berg"),
      {
        creatorType: "author",
        givenName: null,
        familyName: null,
        literalName: "Malaria Consortium",
      },
      { creatorType: "editor", givenName: "Eve", familyName: "Editor", literalName: null },
    ],
    issuedRaw: "2021-06-15",
    issuedYear: 2021,
    identifiers: [
      { scheme: "doi", value: "10.1000/gene.1" },
      { scheme: "pmid", value: "30000001" },
      { scheme: "issn", value: "1234-5679" },
    ],
    abstract: "Line one.\n\nLine two.",
    note: "Private reading note",
    containerTitle: "Journal of Examples",
    publisher: "Example Press",
    volume: "12",
    issue: "3",
    pages: "101-110",
    language: "en",
    url: "https://example.org/gene_1?a=1&b=2",
    tags: ["genetics", "mosquitoes"],
    externalReferences: [],
    attachments: [],
    fieldProvenance: [],
    importedAt: "2026-01-01T00:00:00.000Z",
  });
  const items = [{ record, citationKey: "muller2021gene" }];

  it.each(BIBLIOGRAPHY_FORMATS)("round-trips a source through %s", (format: BibliographyFormat) => {
    const text = formatBibliography(items, format, { includeNotes: true });
    const parsed = parseBibliography(text, format);
    expect(parsed.unreadable).toEqual([]);
    expect(parsed.entries).toHaveLength(1);
    const [entry] = parsed.entries;
    expect(entry).toMatchObject({
      citationKey: "muller2021gene",
      type: "article",
      title: record.title,
      containerTitle: "Journal of Examples",
      issuedYear: 2021,
      volume: "12",
      issue: "3",
      pages: "101-110",
      language: "en",
      url: record.url,
      tags: ["genetics", "mosquitoes"],
      note: "Private reading note",
    });
    expect(entry?.issuedRaw?.startsWith("2021-06")).toBe(true);
    expect(entry?.creators).toEqual(record.creators);
    expect(entry?.identifiers).toEqual(expect.arrayContaining([...record.identifiers]));
    expect(entry?.abstract?.replace(/\s+/gu, " ")).toBe("Line one. Line two.");
  });

  it.each(BIBLIOGRAPHY_FORMATS)("keeps a preprint's arXiv ID and PMCID in %s", (format) => {
    const preprint = decodeRecord({
      ...record,
      type: "preprint",
      identifiers: [
        { scheme: "arxiv", value: "2401.12345" },
        { scheme: "pmcid", value: "PMC12345" },
      ],
    });
    const exported = exportBibliographyFile([{ record: preprint, citationKey: "p" }], format, {
      includeNotes: false,
    });
    expect(exported.notKept).toEqual([]);
    const [entry] = parseBibliography(exported.content, format).entries;
    expect(entry?.type).toBe("preprint");
    expect(entry?.identifiers).toEqual(expect.arrayContaining([...preprint.identifiers]));
  });

  it("reports an identifier the format has no place for", () => {
    const both = decodeRecord({
      ...record,
      identifiers: [
        { scheme: "pmid", value: "30000001" },
        { scheme: "arxiv", value: "2401.12345" },
      ],
    });
    const exported = exportBibliographyFile([{ record: both, citationKey: "b" }], "endnote-xml", {
      includeNotes: false,
    });
    expect(exported.notKept).toEqual([{ field: "arXiv ID", entryCount: 1, citationKeys: ["b"] }]);
  });

  it("exports each source under its own key and gives keyless sources a free one", () => {
    const keyless = { ...record, sourceId: "source_2", citationKey: undefined };
    const { citationKey: _key, ...withoutKey } = keyless;
    const exported = bibliographyExportItems([
      decodeRecord(withoutKey),
      { ...record, citationKey: "muller2021gene" },
    ]);
    expect(exported.map((item) => item.citationKey)).toEqual(["muller2021genea", "muller2021gene"]);
  });

  it.each(BIBLIOGRAPHY_FORMATS)("leaves project notes out of %s unless asked", (format) => {
    const text = formatBibliography(items, format, { includeNotes: false });
    expect(text).not.toContain("Private reading note");
  });
});
