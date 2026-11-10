import type { ScientSourceType } from "../model.ts";
import { normalizeImportedCitationKey } from "../citationKeys.ts";
import {
  BibliographyEntryBuilder,
  type BibliographyEntry,
  type BibliographyExportItem,
  type BibliographyExportOptions,
  type BibliographyParseResult,
  type BibliographyUnreadableEntry,
} from "./entry.ts";
import { collapseWhitespace, decodeLatex, encodeLatex, encodeLatexTitle } from "./latex.ts";
import { parseBibtexNames } from "./names.ts";

interface RawBibtexEntry {
  readonly type: string;
  readonly key: string | null;
  readonly fields: Map<string, string>;
  readonly duplicateFields: Set<string>;
  readonly line: number;
}

const MONTH_MACROS: Readonly<Record<string, string>> = {
  jan: "1",
  feb: "2",
  mar: "3",
  apr: "4",
  may: "5",
  jun: "6",
  jul: "7",
  aug: "8",
  sep: "9",
  oct: "10",
  nov: "11",
  dec: "12",
};
const MONTH_NAMES = Object.keys(MONTH_MACROS);

class BibtexScanner {
  position = 0;
  private readonly lineStarts: number[] = [0];

  readonly text: string;

  constructor(text: string) {
    this.text = text;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\n") this.lineStarts.push(index + 1);
    }
  }

  lineAt(position: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((this.lineStarts[middle] ?? 0) <= position) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }

  peek(): string {
    return this.text[this.position] ?? "";
  }

  skipSpace(): void {
    while (/\s/u.test(this.peek())) this.position += 1;
  }

  expect(character: string): void {
    this.skipSpace();
    if (this.peek() !== character) {
      throw new Error(`Expected “${character}”.`);
    }
    this.position += 1;
  }

  readName(): string {
    this.skipSpace();
    const match = /[^\s"#%'(),={}]+/uy;
    match.lastIndex = this.position;
    const found = match.exec(this.text);
    if (!found) throw new Error("Expected a field name.");
    this.position += found[0].length;
    return found[0];
  }

  readBraced(): string {
    const start = this.position + 1;
    let depth = 0;
    while (this.position < this.text.length) {
      const character = this.peek();
      if (character === "\\") {
        this.position += 2;
        continue;
      }
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          this.position += 1;
          return this.text.slice(start, this.position - 1);
        }
      }
      this.position += 1;
    }
    throw new Error("A brace is not closed.");
  }

  readQuoted(): string {
    const start = this.position + 1;
    this.position += 1;
    let depth = 0;
    while (this.position < this.text.length) {
      const character = this.peek();
      if (character === "\\") {
        this.position += 2;
        continue;
      }
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      else if (character === '"' && depth === 0) {
        this.position += 1;
        return this.text.slice(start, this.position - 1);
      }
      this.position += 1;
    }
    throw new Error("A quotation mark is not closed.");
  }

  readValue(macros: ReadonlyMap<string, string>): string {
    const parts: string[] = [];
    for (;;) {
      this.skipSpace();
      const character = this.peek();
      if (character === "{") parts.push(this.readBraced());
      else if (character === '"') parts.push(this.readQuoted());
      else {
        const name = this.readName();
        parts.push(/^\d+$/u.test(name) ? name : (macros.get(name.toLowerCase()) ?? name));
      }
      this.skipSpace();
      if (this.peek() !== "#") return parts.join("");
      this.position += 1;
    }
  }
}

function readEntryBody(
  scanner: BibtexScanner,
  close: string,
  macros: ReadonlyMap<string, string>,
): { key: string | null; fields: Map<string, string>; duplicateFields: Set<string> } {
  scanner.skipSpace();
  const keyPattern = /[^,\s{}()=]*/uy;
  keyPattern.lastIndex = scanner.position;
  const keyText = keyPattern.exec(scanner.text)?.[0] ?? "";
  let key: string | null = null;
  const afterKey = scanner.position + keyText.length;
  // Without a key, the first token is already a field name.
  if (!scanner.text.slice(afterKey).trimStart().startsWith("=")) {
    key = keyText || null;
    scanner.position = afterKey;
  }
  const fields = new Map<string, string>();
  const duplicateFields = new Set<string>();
  for (;;) {
    scanner.skipSpace();
    while (scanner.peek() === ",") {
      scanner.position += 1;
      scanner.skipSpace();
    }
    if (scanner.peek() === close) {
      scanner.position += 1;
      return { key, fields, duplicateFields };
    }
    if (scanner.position >= scanner.text.length) {
      throw new Error("The entry is not closed.");
    }
    const name = scanner.readName().toLowerCase();
    scanner.expect("=");
    const value = scanner.readValue(macros);
    if (fields.has(name)) duplicateFields.add(name);
    else fields.set(name, value);
    scanner.skipSpace();
    const next = scanner.peek();
    if (next !== "," && next !== close) {
      throw new Error("Expected a comma between fields.");
    }
  }
}

function skipBraced(scanner: BibtexScanner): number {
  try {
    scanner.readBraced();
    return scanner.position;
  } catch {
    return -1;
  }
}

function readBibtex(text: string): {
  readonly entries: RawBibtexEntry[];
  readonly unreadable: BibliographyUnreadableEntry[];
} {
  const scanner = new BibtexScanner(text);
  const macros = new Map(Object.entries(MONTH_MACROS));
  const entries: RawBibtexEntry[] = [];
  const unreadable: BibliographyUnreadableEntry[] = [];
  for (;;) {
    const at = text.indexOf("@", scanner.position);
    if (at < 0) break;
    scanner.position = at + 1;
    const typeMatch = /[A-Za-z]+/uy;
    typeMatch.lastIndex = scanner.position;
    const type = typeMatch.exec(text)?.[0]?.toLowerCase();
    if (!type) continue;
    scanner.position += type.length;
    scanner.skipSpace();
    const open = scanner.peek();
    if (open !== "{" && open !== "(") continue;
    const close = open === "{" ? "}" : ")";
    const line = scanner.lineAt(at);
    if (type === "comment" || type === "preamble") {
      const end = open === "{" ? skipBraced(scanner) : text.indexOf(")", scanner.position) + 1;
      scanner.position = end > 0 ? end : text.length;
      continue;
    }
    try {
      scanner.position += 1;
      if (type === "string") {
        const { fields } = readEntryBody(scanner, close, macros);
        for (const [name, value] of fields) macros.set(name, value);
        continue;
      }
      const body = readEntryBody(scanner, close, macros);
      entries.push({ type, line, ...body });
    } catch (error) {
      const keyMatch = /\s*([^,\s{}()=]+)\s*,/uy;
      keyMatch.lastIndex = at + 1 + type.length + 1;
      unreadable.push({
        line,
        citationKey: keyMatch.exec(text)?.[1] ?? null,
        reason: `This entry could not be read: ${error instanceof Error ? error.message : "unknown syntax."}`,
      });
      const nextEntry = /^[ \t]*@/mu;
      const remainder = text.slice(at + 1);
      const offset = remainder.search(nextEntry);
      scanner.position = offset < 0 ? text.length : at + 1 + offset;
    }
  }
  return { entries, unreadable };
}

const TYPE_BY_BIBTEX_TYPE: Readonly<Record<string, ScientSourceType>> = {
  article: "article",
  periodical: "article",
  suppperiodical: "article",
  book: "book",
  mvbook: "book",
  booklet: "book",
  collection: "book",
  mvcollection: "book",
  proceedings: "book",
  mvproceedings: "book",
  reference: "book",
  mvreference: "book",
  inbook: "book-chapter",
  incollection: "book-chapter",
  bookinbook: "book-chapter",
  suppbook: "book-chapter",
  suppcollection: "book-chapter",
  inreference: "book-chapter",
  inproceedings: "conference-paper",
  conference: "conference-paper",
  phdthesis: "thesis",
  mastersthesis: "thesis",
  thesis: "thesis",
  techreport: "report",
  report: "report",
  dataset: "dataset",
  data: "dataset",
  online: "web",
  www: "web",
  electronic: "web",
  webpage: "web",
};

const CUSTOM_TYPE_LABELS: Readonly<Record<string, string>> = {
  misc: "Document",
  unpublished: "Unpublished",
  manual: "Manual",
  patent: "Patent",
  software: "Software",
  standard: "Standard",
  artwork: "Artwork",
  audio: "Audio",
  video: "Video",
  movie: "Film",
  music: "Music",
  image: "Image",
  letter: "Letter",
  legislation: "Legislation",
  jurisdiction: "Case",
  review: "Review",
};

/** Bookkeeping fields written by reference managers; they carry no bibliographic content. */
const IGNORED_FIELDS = new Set([
  "owner",
  "timestamp",
  "date-added",
  "date-modified",
  "added-at",
  "interhash",
  "intrahash",
  "biburl",
  "bibsource",
  "mendeley-groups",
  "crossref",
  "month",
  "subtitle",
  "titleaddon",
  "eprinttype",
  "archiveprefix",
]);

const PREPRINT_CONTAINER = /\b(?:arxiv|biorxiv|medrxiv|chemrxiv|ssrn|psyarxiv|osf preprints)\b/iu;
const ARXIV_IN_TEXT =
  /arxiv[:\s]+(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/iu;

function plainUrl(value: string): string {
  return value
    .replace(/^\\url\{(.*)\}$/su, "$1")
    .replace(/\\([_%&#$~])/gu, "$1")
    .trim();
}

function pages(value: string): string {
  return collapseWhitespace(decodeLatex(value).replace(/\s*[–—]+\s*|\s*-{1,3}\s*/gu, "-"));
}

function splitList(value: string): string[] {
  return decodeLatex(value).split(/[,;]/u);
}

function bibtexDate(fields: ReadonlyMap<string, string>): { value: string; field: string } | null {
  const date = fields.get("date");
  if (date?.trim()) return { value: decodeLatex(date), field: "date" };
  const year = fields.get("year");
  if (!year?.trim()) return null;
  const yearText = collapseWhitespace(decodeLatex(year));
  const monthText = collapseWhitespace(fields.get("month") ?? "").toLowerCase();
  const month =
    MONTH_MACROS[monthText.slice(0, 3)] ??
    (/^\d{1,2}$/u.test(monthText) && Number(monthText) >= 1 && Number(monthText) <= 12
      ? monthText
      : null);
  if (!month || !/^\d{4}$/u.test(yearText)) return { value: yearText, field: "year" };
  return { value: `${yearText}-${month.padStart(2, "0")}`, field: "year" };
}

function entryFromRaw(raw: RawBibtexEntry, index: number): BibliographyEntry {
  const builder = new BibliographyEntryBuilder(index, raw.line);
  const fields = raw.fields;
  builder.citationKey = normalizeImportedCitationKey(raw.key);
  const text = (name: string) => {
    const value = fields.get(name);
    return value === undefined ? null : decodeLatex(value);
  };
  let type = TYPE_BY_BIBTEX_TYPE[raw.type] ?? "other";
  builder.customType =
    CUSTOM_TYPE_LABELS[raw.type] ?? raw.type.replace(/^./u, (c) => c.toUpperCase());

  const eprintType = collapseWhitespace(
    (fields.get("eprinttype") ?? fields.get("archiveprefix") ?? "").toLowerCase(),
  );
  const container = text("journal") ?? text("journaltitle");
  const handled = new Set<string>(["type"]);
  const use = (name: string) => handled.add(name);

  const title = text("title");
  if (title) {
    const subtitle = text("subtitle");
    const addon = text("titleaddon");
    builder.set(
      "title",
      [subtitle ? `${title}: ${subtitle}` : title, addon].filter(Boolean).join(". "),
      "title",
    );
  }
  use("title");

  for (const [name, role] of [
    ["author", "author"],
    ["editor", "editor"],
    ["translator", "translator"],
    ["bookauthor", "bookAuthor"],
  ] as const) {
    const value = fields.get(name);
    if (value === undefined) continue;
    const { creators, truncated } = parseBibtexNames(value, role);
    builder.addCreators(creators, name);
    if (truncated) builder.notKeep(`${name} (“and others”)`);
    use(name);
  }

  const date = bibtexDate(fields);
  if (date) builder.set("issuedRaw", date.value, date.field);
  use("date");
  use("year");

  for (const name of ["journal", "journaltitle", "booktitle", "maintitle", "eventtitle"]) {
    const value = text(name);
    if (value === null) continue;
    use(name);
    if (
      !builder.set("containerTitle", value, name) &&
      name !== "journaltitle" &&
      name !== "journal"
    )
      builder.notKeep(name);
  }
  for (const name of ["publisher", "school", "institution", "organization"]) {
    const value = text(name);
    if (value === null) continue;
    use(name);
    if (!builder.set("publisher", value, name)) builder.notKeep(name);
  }
  builder.set("volume", text("volume"), "volume");
  use("volume");
  for (const name of ["number", "issue"]) {
    const value = text(name);
    if (value === null) continue;
    use(name);
    if (!builder.set("issue", value, name)) builder.notKeep(name);
  }
  const pageValue = fields.get("pages");
  if (pageValue !== undefined) builder.set("pages", pages(pageValue), "pages");
  use("pages");

  const doi = fields.get("doi");
  if (doi !== undefined) builder.addIdentifier("doi", plainUrl(doi), "doi");
  use("doi");
  const eprint = fields.get("eprint");
  if (eprint !== undefined) {
    use("eprint");
    const value = plainUrl(eprint);
    if (eprintType === "arxiv" || (!eprintType && /^\d{4}\.\d{4,5}(?:v\d+)?$/u.test(value))) {
      builder.addIdentifier("arxiv", value.replace(/^arxiv:/iu, ""), "eprint");
    } else if (eprintType === "pubmed") builder.addIdentifier("pmid", value, "eprint");
    else if (eprintType === "doi") builder.addIdentifier("doi", value, "eprint");
    else builder.notKeep("eprint");
  }
  for (const name of ["arxivid", "arxiv"]) {
    const value = fields.get(name);
    if (value === undefined) continue;
    use(name);
    builder.addIdentifier("arxiv", plainUrl(value).replace(/^arxiv:/iu, ""), name);
  }
  for (const [name, scheme] of [
    ["pmid", "pmid"],
    ["pmcid", "pmcid"],
  ] as const) {
    const value = fields.get(name);
    if (value === undefined) continue;
    use(name);
    builder.addIdentifier(scheme, plainUrl(value), name);
  }
  for (const name of ["isbn", "issn"]) {
    const value = fields.get(name);
    if (value === undefined) continue;
    use(name);
    for (const part of plainUrl(value).split(/[,;\s]+(?=[\dX])/iu)) {
      builder.addIdentifier(name, part, name);
    }
  }

  const url = fields.get("url") ?? fields.get("bdsk-url-1");
  if (url !== undefined)
    builder.set("url", plainUrl(url), fields.has("url") ? "url" : "bdsk-url-1");
  for (const name of fields.keys()) if (name === "url" || name.startsWith("bdsk-url-")) use(name);
  const howpublished = fields.get("howpublished");
  if (howpublished !== undefined) {
    use("howpublished");
    const value = plainUrl(howpublished);
    if (/^https?:\/\//iu.test(value)) builder.set("url", value, "howpublished");
    else if (PREPRINT_CONTAINER.test(value) && !container) {
      builder.set("containerTitle", decodeLatex(howpublished), "howpublished");
    } else builder.notKeep("howpublished");
  }

  const abstract = text("abstract");
  if (abstract) builder.set("abstract", abstract, "abstract");
  use("abstract");
  for (const name of ["keywords", "keyword", "mendeley-tags", "tags"]) {
    const value = fields.get(name);
    if (value === undefined) continue;
    use(name);
    builder.addTags(splitList(value), name);
  }
  for (const name of ["note", "annote", "annotation", "comment", "review"]) {
    if (!fields.has(name)) continue;
    use(name);
    builder.addNote(text(name));
  }
  for (const name of ["language", "langid"]) {
    const value = text(name);
    if (value === null) continue;
    use(name);
    builder.set("language", value, name);
  }

  // Google Scholar writes arXiv preprints as articles in "arXiv preprint arXiv:NNNN".
  const preprintText = builder.get("containerTitle") ?? "";
  const arxivInContainer = preprintText.match(ARXIV_IN_TEXT)?.[1];
  if (arxivInContainer) builder.addIdentifier("arxiv", arxivInContainer, "journal");
  if (
    (type === "article" || type === "other") &&
    !fields.has("volume") &&
    (eprintType === "arxiv" ||
      PREPRINT_CONTAINER.test(preprintText) ||
      (type === "other" && eprint))
  ) {
    const hasArxiv = arxivInContainer || eprintType === "arxiv" || fields.has("arxivid");
    if (hasArxiv || PREPRINT_CONTAINER.test(preprintText)) type = "preprint";
    if (arxivInContainer) builder.replace("containerTitle", "arXiv", "journal");
  }
  if (
    raw.type === "misc" &&
    type === "other" &&
    builder.has("url") &&
    !container &&
    !builder.has("publisher")
  ) {
    type = "web";
  }
  builder.type = type;
  const typeLabel = text("type");
  if (type === "other" && typeLabel) builder.customType = collapseWhitespace(typeLabel);

  for (const name of fields.keys()) {
    if (!handled.has(name) && !IGNORED_FIELDS.has(name)) builder.notKeep(name);
  }
  for (const name of raw.duplicateFields) builder.notKeep(`${name} (repeated)`);
  return builder.build();
}

function applyCrossrefs(entries: ReadonlyArray<RawBibtexEntry>): RawBibtexEntry[] {
  const byKey = new Map(
    entries.flatMap((entry) => (entry.key ? [[entry.key.toLowerCase(), entry]] : [])),
  );
  return entries.map((entry) => {
    const parentKey = entry.fields.get("crossref")?.trim().toLowerCase();
    const parent = parentKey ? byKey.get(parentKey) : undefined;
    if (!parent) return entry;
    const fields = new Map(entry.fields);
    for (const [name, value] of parent.fields) {
      if (name === "crossref" || name === "ids") continue;
      const target = name === "title" ? "booktitle" : name;
      if (!fields.has(target)) fields.set(target, value);
    }
    return { ...entry, fields };
  });
}

export function parseBibtex(text: string): BibliographyParseResult {
  const { entries, unreadable } = readBibtex(text);
  return {
    format: "bibtex",
    entries: applyCrossrefs(entries).map(entryFromRaw),
    unreadable,
  };
}

const BIBTEX_TYPE_BY_TYPE: Readonly<Record<ScientSourceType, string>> = {
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

function bibtexNames(item: BibliographyExportItem, roles: ReadonlySet<string>): string | null {
  const names = item.record.creators.flatMap((creator) => {
    if (!roles.has(creator.creatorType.toLowerCase())) return [];
    if (creator.literalName) return [`{${encodeLatex(creator.literalName)}}`];
    if (creator.familyName && creator.givenName) {
      return [`${encodeLatex(creator.familyName)}, ${encodeLatex(creator.givenName)}`];
    }
    const single = creator.familyName ?? creator.givenName;
    return single ? [`{${encodeLatex(single)}}`] : [];
  });
  return names.length > 0 ? names.join(" and ") : null;
}

function identifierValues(item: BibliographyExportItem, scheme: string): string[] {
  return item.record.identifiers
    .filter((identifier) => identifier.scheme.toLowerCase() === scheme)
    .map((identifier) => identifier.value);
}

export function formatBibtex(
  items: ReadonlyArray<BibliographyExportItem>,
  options: BibliographyExportOptions,
): string {
  return items
    .map((item) => {
      const record = item.record;
      const fields: Array<[string, string]> = [];
      const add = (name: string, value: string | null | undefined, encode = encodeLatex) => {
        const clean = value?.trim();
        if (clean) fields.push([name, `{${encode(clean)}}`]);
      };
      const raw = (name: string, value: string | null | undefined) => {
        const clean = value?.trim();
        if (clean) fields.push([name, `{${clean.replace(/[{}]/gu, "")}}`]);
      };
      add("author", bibtexNames(item, new Set(["author"])), (value) => value);
      add("editor", bibtexNames(item, new Set(["editor", "serieseditor"])), (value) => value);
      add("translator", bibtexNames(item, new Set(["translator"])), (value) => value);
      add("title", record.title, encodeLatexTitle);
      const containerField =
        record.type === "article" || record.type === "preprint"
          ? "journal"
          : record.type === "book-chapter" || record.type === "conference-paper"
            ? "booktitle"
            : record.type === "web" || record.type === "dataset" || record.type === "other"
              ? "howpublished"
              : null;
      if (containerField) add(containerField, record.containerTitle);
      if (record.issuedYear !== null) fields.push(["year", `{${record.issuedYear}}`]);
      else add("year", record.issuedRaw);
      const month = record.issuedRaw?.match(/^\d{4}-(\d{1,2})/u)?.[1];
      const monthName = month ? MONTH_NAMES[Number(month) - 1] : undefined;
      if (monthName) fields.push(["month", monthName]);
      add("volume", record.volume);
      add("number", record.issue);
      add("pages", record.pages?.replace(/\s*[-–—]+\s*/gu, "--"), (value) => value);
      const publisherField =
        record.type === "thesis"
          ? "school"
          : record.type === "report"
            ? "institution"
            : "publisher";
      add(publisherField, record.publisher);
      for (const doi of identifierValues(item, "doi").slice(0, 1)) raw("doi", doi);
      raw("url", record.url);
      const isbn = identifierValues(item, "isbn");
      if (isbn.length > 0) raw("isbn", isbn.join(", "));
      const issn = identifierValues(item, "issn");
      if (issn.length > 0) raw("issn", issn.join(", "));
      const arxiv = identifierValues(item, "arxiv")[0];
      if (arxiv) {
        raw("eprint", arxiv);
        fields.push(["archiveprefix", "{arXiv}"]);
      }
      raw("pmid", identifierValues(item, "pmid")[0]);
      raw("pmcid", identifierValues(item, "pmcid")[0]);
      add("abstract", record.abstract);
      if (record.tags.length > 0) add("keywords", record.tags.join(", "));
      add("language", record.language);
      if (record.type === "other" && record.customType) add("type", record.customType);
      if (options.includeNotes) add("annote", record.note ?? null);
      const body = fields.map(([name, value]) => `  ${name} = ${value}`).join(",\n");
      return `@${BIBTEX_TYPE_BY_TYPE[record.type]}{${item.citationKey},\n${body}\n}\n`;
    })
    .join("\n");
}
