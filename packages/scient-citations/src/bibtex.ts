import type { ScientSourceCreator, ScientSourceRecord } from "@scientfactory/scient-sources";

const BIBTEX_TYPE_BY_SCIENT_TYPE: Readonly<Record<ScientSourceRecord["type"], string>> = {
  article: "article",
  preprint: "misc",
  book: "book",
  "book-chapter": "incollection",
  "conference-paper": "inproceedings",
  thesis: "phdthesis",
  report: "techreport",
  dataset: "misc",
  web: "misc",
  other: "misc",
};

const CONTAINER_FIELD_BY_TYPE: Partial<Record<ScientSourceRecord["type"], string>> = {
  article: "journal",
  "book-chapter": "booktitle",
  "conference-paper": "booktitle",
  report: "institution",
  thesis: "school",
};

const LATEX_SPECIALS: Readonly<Record<string, string>> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

function text(value: string | null | undefined): string | null {
  const trimmed = value?.replace(/\s+/gu, " ").trim();
  return trimmed ? trimmed : null;
}

function escapeLatex(value: string): string {
  return value.replace(/[\\{}&%$#_~^]/gu, (character) => LATEX_SPECIALS[character] ?? character);
}

/** URLs and DOIs stay verbatim for `\url`; only brace balance needs protecting. */
function verbatim(value: string): string {
  return value.replace(/[{}]/gu, "");
}

function bibtexName(creator: ScientSourceCreator): string | null {
  const literal = text(creator.literalName);
  if (literal) return `{${escapeLatex(literal)}}`;
  const family = text(creator.familyName);
  const given = text(creator.givenName);
  if (family && given) return `${escapeLatex(family)}, ${escapeLatex(given)}`;
  const only = family ?? given;
  return only ? `{${escapeLatex(only)}}` : null;
}

function names(creators: ReadonlyArray<ScientSourceCreator>, roles: ReadonlySet<string>) {
  const list = creators.flatMap((creator) => {
    if (!roles.has(creator.creatorType.trim().toLowerCase())) return [];
    const name = bibtexName(creator);
    return name ? [name] : [];
  });
  return list.length > 0 ? list.join(" and ") : null;
}

function identifier(record: ScientSourceRecord, scheme: string): string | null {
  return text(
    record.identifiers.find((entry) => entry.scheme.trim().toLowerCase() === scheme)?.value,
  );
}

function year(record: ScientSourceRecord): string | null {
  if (record.issuedYear !== null) return String(record.issuedYear);
  return text(record.issuedRaw)?.match(/\b(\d{4})\b/u)?.[1] ?? null;
}

const AUTHOR_ROLES = new Set(["author", "bookauthor"]);
const EDITOR_ROLES = new Set(["editor", "serieseditor"]);

function escaped(value: string | null | undefined): string | null {
  const normalized = text(value);
  return normalized ? escapeLatex(normalized) : null;
}

function raw(value: string | null | undefined): string | null {
  const normalized = text(value);
  return normalized ? verbatim(normalized) : null;
}

/** One BibTeX entry, readable by BibTeX, biber and Pandoc. */
export function scientSourceToBibtex(record: ScientSourceRecord, citationKey: string): string {
  const arxiv = identifier(record, "arxiv");
  const genre =
    record.type === "preprint" ? "Preprint" : record.type === "other" ? record.customType : null;
  const fields: ReadonlyArray<readonly [string, string | null]> = [
    ["author", names(record.creators, AUTHOR_ROLES)],
    ["editor", names(record.creators, EDITOR_ROLES)],
    ["title", escaped(record.title)],
    [CONTAINER_FIELD_BY_TYPE[record.type] ?? "howpublished", escaped(record.containerTitle)],
    [
      "publisher",
      record.type === "report" || record.type === "thesis" ? null : escaped(record.publisher),
    ],
    ["year", year(record)],
    ["volume", escaped(record.volume)],
    ["number", escaped(record.issue)],
    ["pages", escaped(text(record.pages)?.replace(/\s*[-–—]+\s*/gu, "--"))],
    ["doi", raw(identifier(record, "doi"))],
    ["eprint", raw(arxiv)],
    ["archiveprefix", arxiv ? "arXiv" : null],
    ["pmid", raw(identifier(record, "pmid"))],
    ["isbn", raw(identifier(record, "isbn"))],
    ["issn", raw(identifier(record, "issn"))],
    ["url", raw(record.url)],
    ["langid", escaped(record.language)],
    ["note", escaped(genre)],
  ];
  const lines = fields.flatMap(([name, value]) => (value ? [`  ${name} = {${value}},`] : []));
  return `@${BIBTEX_TYPE_BY_SCIENT_TYPE[record.type]}{${citationKey},\n${lines.join("\n")}\n}\n`;
}
