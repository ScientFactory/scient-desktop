import type { ScientSourceCreator, ScientSourceType } from "../model.ts";
import { normalizeImportedCitationKey } from "../citationKeys.ts";
import {
  BibliographyEntryBuilder,
  type BibliographyEntry,
  type BibliographyExportItem,
  type BibliographyExportOptions,
  type BibliographyParseResult,
  type BibliographyUnreadableEntry,
} from "./entry.ts";
import { collapseWhitespace } from "./latex.ts";

type JsonObject = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

const TYPE_BY_CSL_TYPE: Readonly<Record<string, ScientSourceType>> = {
  "article-journal": "article",
  "article-magazine": "article",
  "article-newspaper": "article",
  review: "article",
  "review-book": "article",
  article: "preprint",
  book: "book",
  classic: "book",
  chapter: "book-chapter",
  "entry-encyclopedia": "book-chapter",
  "entry-dictionary": "book-chapter",
  "paper-conference": "conference-paper",
  thesis: "thesis",
  report: "report",
  dataset: "dataset",
  webpage: "web",
  "post-weblog": "web",
  post: "web",
};

const CUSTOM_TYPE_LABELS: Readonly<Record<string, string>> = {
  document: "Document",
  manuscript: "Manuscript",
  patent: "Patent",
  software: "Software",
  standard: "Standard",
  speech: "Presentation",
  interview: "Interview",
  personal_communication: "Letter",
  broadcast: "Broadcast",
  motion_picture: "Film",
  song: "Audio",
  graphic: "Image",
  map: "Map",
  legislation: "Legislation",
  legal_case: "Case",
  bill: "Bill",
  regulation: "Regulation",
  treaty: "Treaty",
  hearing: "Hearing",
  pamphlet: "Pamphlet",
  figure: "Figure",
  event: "Event",
  performance: "Performance",
  periodical: "Periodical",
  collection: "Collection",
};

const NAME_ROLES: ReadonlyArray<readonly [string, string]> = [
  ["author", "author"],
  ["editor", "editor"],
  ["translator", "translator"],
  ["container-author", "bookAuthor"],
  ["collection-editor", "seriesEditor"],
];

/** Fields with no bibliographic content (Zotero's internal source and the CSL bookkeeping). */
const IGNORED_FIELDS = new Set([
  "id",
  "type",
  "citation-key",
  "system_id",
  "source",
  "custom",
  "journalAbbreviation",
  "container-title-short",
  "title-short",
  "shortTitle",
]);

function cslName(value: unknown, role: string): ScientSourceCreator | null {
  if (!isObject(value)) return null;
  const literal = stringValue(value["literal"]);
  if (literal?.trim()) {
    return { creatorType: role, givenName: null, familyName: null, literalName: literal.trim() };
  }
  const family = [stringValue(value["non-dropping-particle"]), stringValue(value["family"])]
    .filter((part) => part?.trim())
    .join(" ");
  const givenParts = [stringValue(value["given"]), stringValue(value["dropping-particle"])]
    .filter((part) => part?.trim())
    .join(" ");
  const suffix = stringValue(value["suffix"])?.trim();
  const given = suffix && givenParts ? `${givenParts}, ${suffix}` : givenParts;
  if (!family && !given) return null;
  return {
    creatorType: role,
    givenName: given ? collapseWhitespace(given) : null,
    familyName: family ? collapseWhitespace(family) : null,
    literalName: null,
  };
}

function cslDate(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!isObject(value)) return null;
  const parts = value["date-parts"];
  if (Array.isArray(parts) && Array.isArray(parts[0])) {
    const [year, month, day] = (parts[0] as unknown[]).map((part) => stringValue(part));
    if (year && /^-?\d{1,4}$/u.test(year)) {
      if (!month) return year;
      if (!day) return `${year}-${month.padStart(2, "0")}`;
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }
  }
  return stringValue(value["raw"]) ?? stringValue(value["literal"]);
}

/** Zotero and Better BibTeX put extra fields in the note as "Key: value" lines. */
function notePairs(note: string): { readonly key: string | null; readonly rest: string } {
  let key: string | null = null;
  const rest = note
    .split("\n")
    .filter((line) => {
      const match = line.match(/^\s*citation key:\s*(\S+)\s*$/iu);
      if (match?.[1]) {
        key = match[1];
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();
  return { key, rest };
}

function entryFromItem(item: JsonObject, index: number): BibliographyEntry {
  const builder = new BibliographyEntryBuilder(index, null);
  const cslType = stringValue(item["type"]) ?? "document";
  builder.type = TYPE_BY_CSL_TYPE[cslType] ?? "other";
  builder.customType =
    CUSTOM_TYPE_LABELS[cslType] ?? collapseWhitespace(cslType.replace(/[-_]/gu, " "));
  const genre = stringValue(item["genre"]);
  if (builder.type === "article" && /preprint/iu.test(genre ?? "")) builder.type = "preprint";
  const handled = new Set<string>(["genre"]);
  const text = (field: string) => {
    handled.add(field);
    return stringValue(item[field]);
  };

  for (const [field, role] of NAME_ROLES) {
    handled.add(field);
    const names = item[field];
    if (!Array.isArray(names)) continue;
    builder.addCreators(
      names.flatMap((name) => cslName(name, role) ?? []),
      field,
    );
  }
  builder.set("title", text("title"), "title");
  builder.set("containerTitle", text("container-title"), "container-title");
  if (!builder.has("containerTitle")) {
    builder.set(
      "containerTitle",
      stringValue(item["container-title-short"]),
      "container-title-short",
    );
  }
  for (const field of ["issued", "original-date"]) {
    handled.add(field);
    builder.set("issuedRaw", cslDate(item[field]), field);
  }
  builder.set("publisher", text("publisher"), "publisher");
  builder.set("volume", text("volume"), "volume");
  const issue = text("issue");
  const number = text("number");
  const page = text("page");
  if (page) builder.set("pages", page.replace(/\s*[–—]+\s*/gu, "-"), "page");
  builder.set("language", text("language"), "language");
  builder.set("url", text("URL"), "URL");
  builder.set("abstract", text("abstract"), "abstract");
  for (const [field, scheme] of [
    ["DOI", "doi"],
    ["PMID", "pmid"],
    ["PMCID", "pmcid"],
    ["ISBN", "isbn"],
    ["ISSN", "issn"],
  ] as const) {
    const value = text(field);
    if (!value) continue;
    for (const part of scheme === "isbn" || scheme === "issn"
      ? value.split(/[,;]\s*|\s+(?=\d)/u)
      : [value]) {
      builder.addIdentifier(scheme, part, field);
    }
  }
  const archiveId = text("archive_location");
  const arxivIn = (value: string | null) =>
    value?.match(/(?:arxiv[:/]|abs\/)(\d{4}\.\d{4,5}(?:v\d+)?)/iu)?.[1] ?? null;
  const arxivNumber = arxivIn(number);
  const arxiv = arxivIn(archiveId) ?? arxivNumber ?? arxivIn(stringValue(item["URL"]));
  if (arxiv) builder.addIdentifier("arxiv", arxiv, arxivIn(archiveId) ? "archive_location" : "URL");
  else if (archiveId) builder.notKeep("archive_location");
  if (issue) builder.set("issue", issue, "issue");
  else if (number && !arxivNumber) builder.set("issue", number, "number");

  const keyword = text("keyword");
  if (keyword) builder.addTags(keyword.split(/[,;]/u), "keyword");
  const note = text("note");
  const fromNote = note ? notePairs(note) : null;
  if (fromNote?.rest) builder.addNote(fromNote.rest);
  if (builder.type === "other" && genre) builder.customType = collapseWhitespace(genre);

  builder.citationKey =
    normalizeImportedCitationKey(stringValue(item["citation-key"])) ??
    normalizeImportedCitationKey(fromNote?.key) ??
    (() => {
      const id = stringValue(item["id"]);
      // Zotero item URIs and numeric IDs are database handles, not citation keys.
      return id && !/^https?:|\//iu.test(id) && !/^\d+$/u.test(id)
        ? normalizeImportedCitationKey(id)
        : null;
    })();

  for (const field of Object.keys(item)) {
    if (!handled.has(field) && !IGNORED_FIELDS.has(field)) builder.notKeep(field);
  }
  return builder.build();
}

export function parseCslJson(text: string): BibliographyParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/u, ""));
  } catch {
    return {
      format: "csl-json",
      entries: [],
      unreadable: [{ line: null, citationKey: null, reason: "The file is not valid JSON." }],
    };
  }
  const items: unknown[] = Array.isArray(value)
    ? value
    : isObject(value) && Array.isArray(value["items"])
      ? value["items"]
      : isObject(value) && ("title" in value || "type" in value)
        ? [value]
        : isObject(value)
          ? Object.values(value)
          : [];
  const entries: BibliographyEntry[] = [];
  const unreadable: BibliographyUnreadableEntry[] = [];
  for (const [index, item] of items.entries()) {
    if (!isObject(item)) {
      unreadable.push({
        line: null,
        citationKey: null,
        reason: `Item ${index + 1} is not a CSL item.`,
      });
      continue;
    }
    entries.push(entryFromItem(item, index));
  }
  return { format: "csl-json", entries, unreadable };
}

const CSL_TYPE_BY_TYPE: Readonly<Record<ScientSourceType, string>> = {
  article: "article-journal",
  preprint: "article",
  book: "book",
  "book-chapter": "chapter",
  "conference-paper": "paper-conference",
  thesis: "thesis",
  report: "report",
  dataset: "dataset",
  web: "webpage",
  other: "document",
};

type CslName = { readonly literal: string } | { readonly family?: string; readonly given?: string };

function cslNames(creators: ReadonlyArray<ScientSourceCreator>, roles: ReadonlySet<string>) {
  const names = creators.flatMap((creator): CslName[] => {
    if (!roles.has(creator.creatorType.toLowerCase())) return [];
    if (creator.literalName) return [{ literal: creator.literalName }];
    if (!creator.familyName && !creator.givenName) return [];
    return [
      {
        ...(creator.familyName ? { family: creator.familyName } : {}),
        ...(creator.givenName ? { given: creator.givenName } : {}),
      },
    ];
  });
  return names.length > 0 ? names : undefined;
}

function cslIssued(raw: string | null, year: number | null) {
  const match = raw?.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/u);
  const parsedYear = match?.[1] ? Number(match[1]) : year;
  if (parsedYear !== null && parsedYear !== undefined) {
    const parts = [parsedYear];
    const month = match?.[2] ? Number(match[2]) : null;
    const day = match?.[3] ? Number(match[3]) : null;
    if (month !== null && month >= 1 && month <= 12) {
      parts.push(month);
      if (day !== null && day >= 1 && day <= 31) parts.push(day);
    }
    return { "date-parts": [parts] };
  }
  return raw ? { literal: raw } : undefined;
}

export type CslJsonItem = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly type: string;
};

/**
 * The one CSL-JSON writer: file export, the managed `references.json`, Word
 * export and reference formatting all read a source through it.
 */
export function cslJsonItem(
  { record, citationKey }: BibliographyExportItem,
  options: BibliographyExportOptions & { readonly id?: string },
): CslJsonItem {
  const identifier = (scheme: string) =>
    record.identifiers.find((entry) => entry.scheme.toLowerCase() === scheme)?.value;
  const all = (scheme: string) =>
    record.identifiers
      .filter((entry) => entry.scheme.toLowerCase() === scheme)
      .map((entry) => entry.value);
  const arxiv = identifier("arxiv");
  const fields: Record<string, unknown> = {
    id: options.id ?? citationKey,
    "citation-key": citationKey || undefined,
    type: CSL_TYPE_BY_TYPE[record.type],
    title: record.title ?? undefined,
    author: cslNames(record.creators, new Set(["author"])),
    editor: cslNames(record.creators, new Set(["editor"])),
    translator: cslNames(record.creators, new Set(["translator"])),
    "container-author": cslNames(record.creators, new Set(["bookauthor"])),
    "collection-editor": cslNames(record.creators, new Set(["serieseditor"])),
    issued: cslIssued(record.issuedRaw, record.issuedYear),
    "container-title": record.containerTitle ?? undefined,
    publisher: record.publisher ?? undefined,
    volume: record.volume ?? undefined,
    issue: record.issue ?? undefined,
    page: record.pages ?? undefined,
    language: record.language ?? undefined,
    URL: record.url ?? (arxiv ? `https://arxiv.org/abs/${arxiv}` : undefined),
    DOI: identifier("doi"),
    PMID: identifier("pmid"),
    PMCID: identifier("pmcid"),
    ISBN: all("isbn").join(", ") || undefined,
    ISSN: all("issn").join(", ") || undefined,
    number: arxiv ? `arXiv:${arxiv}` : undefined,
    genre:
      record.type === "preprint"
        ? "Preprint"
        : record.type === "other" && record.customType
          ? record.customType
          : undefined,
    abstract: options.includeAbstracts !== false ? (record.abstract ?? undefined) : undefined,
    keyword: record.tags.length > 0 ? record.tags.join(", ") : undefined,
    note: options.includeNotes ? (record.note ?? undefined) : undefined,
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as CslJsonItem;
}

export function formatCslJson(
  items: ReadonlyArray<BibliographyExportItem>,
  options: BibliographyExportOptions,
): string {
  return `${JSON.stringify(
    items.map((item) => cslJsonItem(item, options)),
    null,
    2,
  )}\n`;
}
