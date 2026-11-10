import { normalizeScientSourceEditableMetadata } from "../editable.ts";
import type {
  ScientSourceCandidate,
  ScientSourceRecord,
  ScientSourceCreator,
  ScientSourceFieldProvenance,
  ScientSourceIdentifier,
  ScientSourceType,
} from "../model.ts";
import { normalizePersistentIdentifier } from "../normalize.ts";
import { collapseWhitespace } from "./latex.ts";

export const BIBLIOGRAPHY_FORMATS = ["bibtex", "ris", "csl-json", "endnote-xml"] as const;
export type BibliographyFormat = (typeof BIBLIOGRAPHY_FORMATS)[number];

type TextField =
  | "title"
  | "issuedRaw"
  | "abstract"
  | "containerTitle"
  | "publisher"
  | "volume"
  | "issue"
  | "pages"
  | "language"
  | "url";

/** One entry read from a reference file, before it becomes an import candidate. */
export interface BibliographyEntry {
  readonly index: number;
  /** 1-based line where the entry starts, for text formats. */
  readonly line: number | null;
  readonly citationKey: string | null;
  readonly type: ScientSourceType;
  readonly customType: string | null;
  readonly title: string | null;
  readonly creators: ReadonlyArray<ScientSourceCreator>;
  readonly issuedRaw: string | null;
  readonly issuedYear: number | null;
  readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
  readonly abstract: string | null;
  readonly containerTitle: string | null;
  readonly publisher: string | null;
  readonly volume: string | null;
  readonly issue: string | null;
  readonly pages: string | null;
  readonly language: string | null;
  readonly url: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly note: string | null;
  /** Scient field → the file's field name it came from. */
  readonly sourceFields: Readonly<Record<string, string>>;
  /** Fields of this entry that have no place in a Scient source. */
  readonly notKept: ReadonlyArray<string>;
}

export interface BibliographyExportItem {
  readonly record: ScientSourceRecord;
  readonly citationKey: string;
}

export interface BibliographyExportOptions {
  /** Project notes are private by default; include them only when asked. */
  readonly includeNotes: boolean;
}

export interface BibliographyUnreadableEntry {
  readonly line: number | null;
  readonly citationKey: string | null;
  readonly reason: string;
}

export interface BibliographyParseResult {
  readonly format: BibliographyFormat;
  readonly entries: ReadonlyArray<BibliographyEntry>;
  readonly unreadable: ReadonlyArray<BibliographyUnreadableEntry>;
}

const CITATION_KEY_PATTERN = /^[\p{L}\p{N}_:.\-+/]{1,128}$/u;

export function plausibleCitationKey(value: string | null | undefined): string | null {
  const key = value?.trim() ?? "";
  return CITATION_KEY_PATTERN.test(key) ? key : null;
}

function yearFrom(value: string | null): number | null {
  const match = value?.match(/(?<!\d)(\d{4})(?!\d)/u);
  const year = match?.[1] ? Number(match[1]) : null;
  return year !== null && year >= 1000 && year <= 9999 ? year : null;
}

function validWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const DOI_PATTERN = /10\.\d{4,9}\/\S+/u;

function doiFrom(value: string): string | null {
  const match = value.trim().match(DOI_PATTERN);
  return match ? match[0].replace(/[.,;]+$/u, "") : null;
}

/** Classifies an ISBN/ISSN-like value from formats that share one field for both. */
export function standardNumberScheme(value: string): "isbn" | "issn" | null {
  const compact = value.replace(/[\s-]/gu, "").toUpperCase();
  if (/^\d{7}[\dX]$/u.test(compact)) return "issn";
  if (/^(?:\d{9}[\dX]|\d{13})$/u.test(compact)) return "isbn";
  return null;
}

/** Collects one entry's fields; the first value for a field wins. */
export class BibliographyEntryBuilder {
  citationKey: string | null = null;
  type: ScientSourceType = "other";
  customType: string | null = null;
  private readonly text = new Map<TextField, string>();
  private readonly creatorList: ScientSourceCreator[] = [];
  private readonly identifierList: ScientSourceIdentifier[] = [];
  private readonly identifierKeys = new Set<string>();
  private readonly tagList: string[] = [];
  private readonly notes: string[] = [];
  private readonly origins: Record<string, string> = {};
  private readonly dropped = new Set<string>();

  readonly index: number;
  readonly line: number | null;

  constructor(index: number, line: number | null) {
    this.index = index;
    this.line = line;
  }

  has(field: TextField): boolean {
    return this.text.has(field);
  }

  get(field: TextField): string | null {
    return this.text.get(field) ?? null;
  }

  /** Returns false when the field already had a value. */
  set(field: TextField, value: string | null | undefined, sourceField: string): boolean {
    const clean = field === "abstract" ? value?.trim() : collapseWhitespace(value ?? "");
    if (!clean) return true;
    if (this.text.has(field)) return false;
    if (field === "url" && !validWebUrl(clean)) {
      this.notKeep(sourceField);
      return true;
    }
    this.text.set(field, clean);
    this.origins[field] ??= sourceField;
    return true;
  }

  replace(field: TextField, value: string, sourceField: string): void {
    this.text.delete(field);
    this.set(field, value, sourceField);
  }

  addCreators(creators: ReadonlyArray<ScientSourceCreator>, sourceField: string): void {
    if (creators.length === 0) return;
    this.creatorList.push(...creators);
    this.origins["creators"] ??= sourceField;
  }

  addIdentifier(scheme: string, rawValue: string | null | undefined, sourceField: string): void {
    const value = collapseWhitespace(rawValue ?? "");
    if (!value) return;
    const normalizedValue = scheme === "doi" ? doiFrom(value) : value;
    if (!normalizedValue) {
      this.notKeep(sourceField);
      return;
    }
    const key = normalizePersistentIdentifier(scheme, normalizedValue);
    if (this.identifierKeys.has(key)) return;
    this.identifierKeys.add(key);
    this.origins[`identifiers.${this.identifierList.length}`] = sourceField;
    this.identifierList.push({ scheme, value: normalizedValue });
  }

  addTags(tags: ReadonlyArray<string>, sourceField: string): void {
    const clean = tags.map((tag) => collapseWhitespace(tag)).filter((tag) => tag.length > 0);
    if (clean.length === 0) return;
    this.tagList.push(...clean);
    this.origins["tags"] ??= sourceField;
  }

  addNote(value: string | null | undefined): void {
    const clean = value?.trim();
    if (clean) this.notes.push(clean);
  }

  notKeep(sourceField: string): void {
    this.dropped.add(sourceField);
  }

  get creators(): ReadonlyArray<ScientSourceCreator> {
    return this.creatorList;
  }

  build(): BibliographyEntry {
    const issuedRaw = this.get("issuedRaw");
    return {
      index: this.index,
      line: this.line,
      citationKey: this.citationKey,
      type: this.type,
      customType: this.type === "other" ? this.customType : null,
      title: this.get("title"),
      creators: this.creatorList,
      issuedRaw,
      issuedYear: yearFrom(issuedRaw),
      identifiers: this.identifierList,
      abstract: this.get("abstract"),
      containerTitle: this.get("containerTitle"),
      publisher: this.get("publisher"),
      volume: this.get("volume"),
      issue: this.get("issue"),
      pages: this.get("pages"),
      language: this.get("language"),
      url: this.get("url"),
      tags: [...new Set(this.tagList)],
      note: this.notes.length > 0 ? this.notes.join("\n\n") : null,
      sourceFields: this.origins,
      notKept: [...this.dropped],
    };
  }
}

/** A stable description of an entry's content, hashed by callers into an import item key. */
export function bibliographyEntryIdentity(
  format: BibliographyFormat,
  entry: BibliographyEntry,
): string {
  const { index: _index, line: _line, sourceFields: _sourceFields, ...content } = entry;
  return JSON.stringify([format, content]);
}

export function bibliographyEntryCandidate(input: {
  readonly entry: BibliographyEntry;
  readonly format: BibliographyFormat;
  readonly sourceKey: string;
}): ScientSourceCandidate {
  const { entry, format } = input;
  const metadata = normalizeScientSourceEditableMetadata({
    type: entry.type,
    customType: entry.customType,
    title: entry.title,
    creators: entry.creators,
    issuedRaw: entry.issuedRaw,
    issuedYear: entry.issuedYear,
    identifiers: entry.identifiers,
    abstract: entry.abstract,
    containerTitle: entry.containerTitle,
    publisher: entry.publisher,
    volume: entry.volume,
    issue: entry.issue,
    pages: entry.pages,
    language: entry.language,
    url: entry.url,
    tags: entry.tags,
  });
  const fieldProvenance: ScientSourceFieldProvenance[] = Object.entries(entry.sourceFields).map(
    ([field, sourceField]) => ({ field, origin: "file", sourceField: `${format}:${sourceField}` }),
  );
  if (metadata.issuedYear !== null && entry.sourceFields["issuedRaw"]) {
    fieldProvenance.push({
      field: "issuedYear",
      origin: "file",
      sourceField: `${format}:${entry.sourceFields["issuedRaw"]}`,
    });
  }
  return {
    sourceKey: input.sourceKey,
    ...metadata,
    externalReferences: [],
    fieldProvenance,
    pdfAvailable: false,
    pdfFileName: null,
    pdfAttachmentCount: 0,
    ...(entry.note ? { note: entry.note } : {}),
  };
}
