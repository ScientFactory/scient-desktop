import { bibtexEntries } from "./bibtex.ts";
import type { ScientSourceIdentifier } from "./model.ts";

export type ReferenceDocumentKind = "markdown" | "latex" | "bibtex";

export interface ReferenceCitation {
  readonly key: string;
  readonly line: number;
}

export interface ReferenceEntry {
  readonly key: string;
  readonly kind: "bibtex" | "bibitem" | "typed";
  /** Lowercase BibTeX entry type, or the entry kind for bibitems and typed lists. */
  readonly type: string;
  readonly line: number;
  /** Plain text of each literal field; macro and concatenated values are absent. */
  readonly fields: Readonly<Record<string, string>>;
  /** Every field the entry sets, including macro and concatenated values. */
  readonly fieldNames: ReadonlyArray<string>;
  readonly raw: string | null;
  readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
}

export interface ReferenceDocument {
  readonly kind: ReferenceDocumentKind;
  readonly citations: ReadonlyArray<ReferenceCitation>;
  /** Bibliography files the document names, as written (relative to the document). */
  readonly bibliographyPaths: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<ReferenceEntry>;
  readonly parseError: string | null;
}

export function referenceDocumentKind(path: string): ReferenceDocumentKind | null {
  const lower = path.toLowerCase();
  if (/\.(md|markdown|qmd|rmd)$/u.test(lower)) return "markdown";
  if (/\.(tex|ltx)$/u.test(lower)) return "latex";
  if (lower.endsWith(".bib")) return "bibtex";
  return null;
}

const ACCENTS: Readonly<Record<string, string>> = {
  "'": "́",
  "`": "̀",
  "^": "̂",
  '"': "̈",
  "~": "̃",
  "=": "̄",
  ".": "̇",
  u: "̆",
  v: "̌",
  H: "̋",
  c: "̧",
  k: "̨",
};
const LETTERS: Readonly<Record<string, string>> = {
  ss: "ß",
  o: "ø",
  O: "Ø",
  ae: "æ",
  AE: "Æ",
  oe: "œ",
  OE: "Œ",
  aa: "å",
  AA: "Å",
  l: "ł",
  L: "Ł",
  i: "ı",
};

/** Readable text from a BibTeX or LaTeX value: accents, escapes and formatting commands resolved. */
export function latexPlainText(value: string): string {
  return (
    value
      .replace(
        /\\([`'^"~=.]|[uvHck](?![A-Za-z]))\s*\{?\s*\\?([A-Za-z])\}?/gu,
        (_, accent: string, letter: string) => `${letter}${ACCENTS[accent] ?? ""}`.normalize("NFC"),
      )
      .replace(
        /\\(ss|ae|AE|oe|OE|aa|AA|[oOlLi])(?![A-Za-z])\s*/gu,
        (_, name: string) => LETTERS[name] ?? name,
      )
      .replace(/\\([&%$#_{}])/gu, "$1")
      // oxlint-disable-next-line t3code/no-em-dash-copy -- TeX's --- ligature is an em dash in the cited title.
      .replace(/---/gu, "—")
      .replace(/--/gu, "–")
      .replace(/~/gu, " ")
      .replace(/\\[A-Za-z]+\*?\s*/gu, "")
      .replace(/[{}]/gu, "")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

const DOI_PATTERN = /\b(10\.\d{4,9}\/[^\s"<>{}]+)/iu;
const ARXIV_PATTERN =
  /(?:arxiv[:\s]\s*|arxiv\.org\/(?:abs|pdf)\/)([0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[a-z]{2})?\/[0-9]{7})(?:v\d+)?/iu;
const NEW_ARXIV_ID = /^([0-9]{4}\.[0-9]{4,5})(?:v\d+)?$/u;

function cleanDoi(value: string): string | null {
  const match = DOI_PATTERN.exec(
    value.replace(/^\s*(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/iu, ""),
  );
  const doi = match?.[1]?.replace(/[.,;:)\]]+$/u, "");
  return doi ? doi : null;
}

/** DOI, PMID and arXiv identifiers named by a reference's fields or text. */
function referenceIdentifiers(
  fields: Readonly<Record<string, string>>,
  raw: string | null,
): ReadonlyArray<ScientSourceIdentifier> {
  const identifiers: Array<ScientSourceIdentifier> = [];
  const prose = [fields.url, fields.note, fields.howpublished, fields.journal, raw]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const doi =
    (fields.doi ? cleanDoi(fields.doi) : null) ??
    ((fields.eprinttype ?? "").toLowerCase() === "doi" && fields.eprint
      ? cleanDoi(fields.eprint)
      : null) ??
    cleanDoi(prose);
  if (doi) identifiers.push({ scheme: "doi", value: doi });
  const pmid =
    fields.pmid?.trim() ??
    (((fields.eprinttype ?? "").toLowerCase() === "pubmed" && fields.eprint?.trim()) ||
      /\bPMID:?\s*(\d{1,9})\b/u.exec(prose)?.[1]);
  if (pmid && /^\d{1,9}$/u.test(pmid)) identifiers.push({ scheme: "pmid", value: pmid });
  const archive = (fields.archiveprefix ?? fields.eprinttype ?? "").toLowerCase();
  const eprint = fields.eprint?.trim() ?? "";
  const arxiv =
    (archive === "arxiv" && eprint
      ? eprint.replace(/^arxiv:/iu, "").replace(/v\d+$/u, "")
      : NEW_ARXIV_ID.exec(eprint)?.[1]) ?? ARXIV_PATTERN.exec(prose)?.[1];
  if (arxiv) identifiers.push({ scheme: "arxiv", value: arxiv });
  return identifiers;
}

function lineStarts(text: string): ReadonlyArray<number> {
  const starts = [0];
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return starts;
}

function lineOf(starts: ReadonlyArray<number>, offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function readBibtex(text: string): Pick<ReferenceDocument, "entries" | "parseError"> {
  const parsed = bibtexEntries(text);
  const starts = lineStarts(text);
  return {
    parseError: parsed.error,
    entries: parsed.entries.map((entry) => {
      const fields: Record<string, string> = {};
      for (const field of entry.fields) {
        if (field.text !== null) fields[field.name] = latexPlainText(field.text);
      }
      return {
        key: entry.key,
        kind: "bibtex",
        type: entry.type.toLowerCase(),
        line: lineOf(starts, entry.from),
        fields,
        fieldNames: entry.fields.map((field) => field.name),
        raw: null,
        identifiers: referenceIdentifiers(fields, null),
      };
    }),
  };
}

const TEX_CITE =
  /\\(?:[a-zA-Z]*cite[a-zA-Z]*|footcite|nocite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^}]*)\}/gu;
const TEX_BIBLIOGRAPHY = /\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/gu;
const TEX_BIBITEM =
  /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}([\s\S]*?)(?=\\bibitem|\\end\s*\{thebibliography\})/gu;

function withoutTexComments(text: string): string {
  return text.replace(/(?<!\\)%.*$/gmu, (comment) => " ".repeat(comment.length));
}

function readLatex(text: string): Omit<ReferenceDocument, "kind"> {
  const code = withoutTexComments(text);
  const starts = lineStarts(code);
  const citations: Array<ReferenceCitation> = [];
  for (const match of code.matchAll(TEX_CITE)) {
    const line = lineOf(starts, match.index);
    for (const key of match[1]!.split(",")) {
      const trimmed = key.trim();
      if (trimmed && trimmed !== "*") citations.push({ key: trimmed, line });
    }
  }
  const bibliographyPaths = [...code.matchAll(TEX_BIBLIOGRAPHY)].flatMap((match) =>
    match[1]!
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => (name.toLowerCase().endsWith(".bib") ? name : `${name}.bib`)),
  );
  const entries = [...code.matchAll(TEX_BIBITEM)].map((match): ReferenceEntry => {
    const raw = latexPlainText(match[2]!);
    return {
      key: match[1]!.trim(),
      kind: "bibitem",
      type: "bibitem",
      line: lineOf(starts, match.index),
      fields: {},
      fieldNames: [],
      raw,
      identifiers: referenceIdentifiers({}, match[2]!),
    };
  });
  return { citations, bibliographyPaths, entries, parseError: null };
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n/u;
const REFERENCE_HEADING =
  /^\s{0,3}(?:#{1,6}\s*|\*\*)?(references|bibliography|works cited|literature cited|reference list)\s*(?:\*\*)?\s*:?\s*$/imu;
const NUMBERED_ENTRY = /^\s*(?:\[(\d+)\]|(\d+)[.)])\s+(.+)$/u;
const NUMERIC_CITATION =
  /\[(\d+(?:\s*[,–—-]\s*\d+)*)\](?!\()|<sup>(\d+(?:\s*[,–—-]\s*\d+)*)<\/sup>/gu;
const MARKDOWN_CITATION = /(?<![\w.@\\`/])-?@(?:\{([^}\s]+)\}|([A-Za-z0-9_][\w:.#$%&+?<>~/-]*))/gu;

function frontMatterBibliographies(frontMatter: string): ReadonlyArray<string> {
  const paths: Array<string> = [];
  const lines = frontMatter.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index++) {
    const match = /^bibliography:\s*(.*)$/u.exec(lines[index]!);
    if (!match) continue;
    const inline = match[1]!.trim();
    if (inline) {
      paths.push(
        ...inline
          .replace(/^\[|\]$/gu, "")
          .split(",")
          .map((value) => value.trim().replace(/^["']|["']$/gu, ""))
          .filter(Boolean),
      );
      continue;
    }
    for (let item = index + 1; item < lines.length; item++) {
      const entry = /^\s+-\s+(.+)$/u.exec(lines[item]!);
      if (!entry) break;
      paths.push(entry[1]!.trim().replace(/^["']|["']$/gu, ""));
    }
  }
  return paths;
}

function numericKeys(list: string): ReadonlyArray<string> {
  return list.split(/\s*,\s*/u).flatMap((part) => {
    const range = part.split(/\s*[–—-]\s*/u);
    if (range.length === 2) {
      const from = Number(range[0]);
      const to = Number(range[1]);
      if (Number.isInteger(from) && Number.isInteger(to) && to >= from && to - from < 50) {
        return Array.from({ length: to - from + 1 }, (_, offset) => String(from + offset));
      }
    }
    return /^\d+$/u.test(part) ? [part] : [];
  });
}

/** Blank out code so citations inside code spans and fences are not read. */
function withoutMarkdownCode(text: string): string {
  const blank = (value: string) => value.replace(/[^\n]/gu, " ");
  return text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gmu, blank)
    .replace(/`[^`\n]+`/gu, blank);
}

function readMarkdown(text: string): Omit<ReferenceDocument, "kind"> {
  const frontMatter = FRONT_MATTER.exec(text);
  const bodyStart = frontMatter ? frontMatter[0].length : 0;
  const code = withoutMarkdownCode(text);
  const starts = lineStarts(code);
  let headingEnd = -1;
  let headingStart = -1;
  const heading = new RegExp(REFERENCE_HEADING.source, "gimu");
  heading.lastIndex = bodyStart;
  for (let match = heading.exec(code); match; match = heading.exec(code)) {
    headingStart = match.index;
    headingEnd = match.index + match[0].length;
  }
  const entries: Array<{ key: string; line: number; raw: string }> = [];
  if (headingEnd >= 0) {
    const firstLine = lineOf(starts, headingEnd) + 1;
    const tail = text.slice(headingEnd).split(/\r?\n/u).slice(1);
    for (const [offset, line] of tail.entries()) {
      if (/^\s{0,3}#/u.test(line)) break;
      const numbered = NUMBERED_ENTRY.exec(line);
      const current = entries.at(-1);
      if (numbered) {
        entries.push({
          key: numbered[1] ?? numbered[2]!,
          line: firstLine + offset,
          raw: numbered[3]!.trim(),
        });
      } else if (current && line.trim()) {
        current.raw = `${current.raw} ${line.trim()}`;
      }
    }
  }
  const body = entries.length > 0 ? code.slice(0, headingStart) : code;
  const citations: Array<ReferenceCitation> = [];
  for (const match of body.slice(bodyStart).matchAll(MARKDOWN_CITATION)) {
    const key = (match[1] ?? match[2]!).replace(/[.:;,?]+$/u, "");
    if (/\.(com|org|net|edu|io|gov)$/iu.test(key)) continue;
    citations.push({ key, line: lineOf(starts, bodyStart + match.index) });
  }
  if (entries.length > 0) {
    for (const match of body.slice(bodyStart).matchAll(NUMERIC_CITATION)) {
      const line = lineOf(starts, bodyStart + match.index);
      for (const key of numericKeys(match[1] ?? match[2]!)) citations.push({ key, line });
    }
  }
  return {
    citations,
    bibliographyPaths: frontMatter ? frontMatterBibliographies(frontMatter[1]!) : [],
    entries: entries.map((entry) => ({
      key: entry.key,
      kind: "typed",
      type: "typed",
      line: entry.line,
      fields: {},
      fieldNames: [],
      raw: entry.raw,
      identifiers: referenceIdentifiers({}, entry.raw),
    })),
    parseError: null,
  };
}

export function readReferenceDocument(
  kind: ReferenceDocumentKind,
  text: string,
): ReferenceDocument {
  if (kind === "bibtex") {
    return { kind, citations: [], bibliographyPaths: [], ...readBibtex(text) };
  }
  return { kind, ...(kind === "latex" ? readLatex(text) : readMarkdown(text)) };
}

const ANY = (...names: ReadonlyArray<string>) => names;
const REQUIRED_BIBTEX_FIELDS: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>> = {
  article: [ANY("author"), ANY("title"), ANY("journal", "journaltitle"), ANY("year", "date")],
  book: [ANY("author", "editor"), ANY("title"), ANY("publisher"), ANY("year", "date")],
  inbook: [
    ANY("author", "editor"),
    ANY("title"),
    ANY("chapter", "pages"),
    ANY("publisher"),
    ANY("year", "date"),
  ],
  incollection: [
    ANY("author"),
    ANY("title"),
    ANY("booktitle"),
    ANY("publisher"),
    ANY("year", "date"),
  ],
  inproceedings: [ANY("author"), ANY("title"), ANY("booktitle"), ANY("year", "date")],
  conference: [ANY("author"), ANY("title"), ANY("booktitle"), ANY("year", "date")],
  phdthesis: [ANY("author"), ANY("title"), ANY("school", "institution"), ANY("year", "date")],
  mastersthesis: [ANY("author"), ANY("title"), ANY("school", "institution"), ANY("year", "date")],
  thesis: [ANY("author"), ANY("title"), ANY("school", "institution"), ANY("year", "date")],
  techreport: [ANY("author"), ANY("title"), ANY("institution"), ANY("year", "date")],
  report: [ANY("author"), ANY("title"), ANY("institution"), ANY("year", "date")],
  online: [ANY("title"), ANY("url", "doi")],
};

/** Fields the entry's BibTeX type requires but the entry lacks; the first name of each group. */
export function missingBibtexFields(entry: ReferenceEntry): ReadonlyArray<string> {
  if (entry.kind !== "bibtex") return [];
  const required = REQUIRED_BIBTEX_FIELDS[entry.type] ?? [ANY("title")];
  return required.flatMap((names) =>
    names.some((name) => entry.fieldNames.includes(name)) ? [] : [names[0]!],
  );
}
