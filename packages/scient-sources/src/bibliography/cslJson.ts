import {
  scientCreatorRoleIncomplete,
  type ScientSourceCreator,
  type ScientSourceRecord,
  type ScientSourceType,
} from "../model.ts";
import { normalizeImportedCitationKey } from "../citationKeys.ts";
import { SCIENT_SOURCE_MORE_FIELDS, scientSourceMoreKind } from "../sourceMore.ts";
import {
  ZOTERO_PRIMARY_ROLE,
  ZOTERO_ROLE_CSL,
  ZOTERO_ROLE_SPELLING,
  ZOTERO_TYPE_CSL,
} from "../zoteroSchema.ts";
import {
  BibliographyEntryBuilder,
  type BibliographyEntry,
  type BibliographyExportItem,
  type BibliographyExportOptions,
  type BibliographyParseResult,
  type BibliographyUnreadableEntry,
} from "./entry.ts";
import { collapseWhitespace } from "./latex.ts";

/** The name variables (`author`, `editor`) whose list stops short, under the item's `custom`. */
export const CSL_INCOMPLETE_NAMES = "scient-incomplete-names";

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
  software: "software",
  speech: "presentation",
  manuscript: "manuscript",
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

/**
 * Each CSL name variable with the Zotero role it is read as, so what the writer puts under
 * `director` or `interviewer` comes back. Where two roles share a variable, the one named
 * like the variable is taken (author, not creator).
 */
const NAME_ROLES: ReadonlyArray<readonly [string, string]> = [
  ...Object.entries(ZOTERO_ROLE_CSL)
    .reduce((roles, [role, variable]) => {
      if (!roles.has(variable) || variable.replaceAll("-", "") === role) roles.set(variable, role);
      return roles;
    }, new Map<string, string>())
    .entries(),
].map(([variable, role]) => [variable, ZOTERO_ROLE_SPELLING[role] ?? role] as const);

const SEASONS = ["Spring", "Summer", "Autumn", "Winter"] as const;

/** Fields with no bibliographic content (Zotero's internal source and the CSL bookkeeping). */
/** Details read with their own rule in `entryFromItem`, not by the general loop. */
const CSL_MORE_READ_ABOVE: ReadonlySet<string> = new Set([
  "original-date",
  "number",
  "genre",
  "title-short",
  "container-title-short",
  "archive_location",
]);

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
    const written = (parts as unknown[]).slice(0, 2).map((date) => {
      const [year, month, day] = (Array.isArray(date) ? date : []).map((part) => stringValue(part));
      if (!year || !/^-?\d{1,4}$/u.test(year)) return null;
      if (!month) return year;
      if (!day) return `${year}-${month.padStart(2, "0")}`;
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    });
    // A range keeps both ends, as `start/end`; a season and "about" are kept in words.
    if (written.every((date) => date !== null)) {
      const season = SEASONS[Number(value["season"]) - 1] ?? stringValue(value["season"]);
      const date = written.join("/");
      const worded = season && written.length === 1 ? `${season} ${date}` : date;
      return value["circa"] ? `circa ${worded}` : worded;
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
  const custom = item["custom"];
  const incomplete = isObject(custom) ? custom[CSL_INCOMPLETE_NAMES] : undefined;
  for (const [field, role] of NAME_ROLES) {
    if (Array.isArray(incomplete) && incomplete.includes(field)) builder.markIncomplete(role);
  }
  builder.set("title", text("title"), "title");
  builder.set("containerTitle", text("container-title"), "container-title");
  // With no full title, the abbreviation is the container's title, and no detail besides.
  const shortIsTitle = !builder.has("containerTitle");
  if (shortIsTitle) {
    builder.set(
      "containerTitle",
      stringValue(item["container-title-short"]),
      "container-title-short",
    );
  }
  for (const field of ["issued", "original-date"]) {
    handled.add(field);
    // The original date stands in for a missing date; beside one it is a detail of its own.
    if (!builder.set("issuedRaw", cslDate(item[field]), field)) {
      builder.setMore("original-date", cslDate(item[field]), field);
    }
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
  else builder.setMore("archive_location", archiveId, "archive_location");
  // A report's number is its own; elsewhere a number with no issue is the issue.
  if (issue) builder.set("issue", issue, "issue");
  if (number && !arxivNumber) {
    if (builder.type === "report" || issue) builder.setMore("number", number, "number");
    else builder.set("issue", number, "number");
  }
  if (builder.type !== "other" && builder.type !== "preprint") {
    builder.setMore("genre", genre, "genre");
  }
  builder.setMore(
    "title-short",
    stringValue(item["title-short"]) ?? stringValue(item["shortTitle"]),
    item["title-short"] === undefined ? "shortTitle" : "title-short",
  );
  if (!shortIsTitle) {
    builder.setMore(
      "container-title-short",
      stringValue(item["container-title-short"]) ?? stringValue(item["journalAbbreviation"]),
      item["container-title-short"] === undefined ? "journalAbbreviation" : "container-title-short",
    );
  }
  // Every other detail CSL has a variable for, under that variable.
  for (const { name, kind } of SCIENT_SOURCE_MORE_FIELDS) {
    if (name === "extra" || handled.has(name) || CSL_MORE_READ_ABOVE.has(name)) continue;
    const value = kind === "date" ? cslDate(item[name]) : stringValue(item[name]);
    if (!value) continue;
    handled.add(name);
    builder.setMore(name, value, name);
  }

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
  software: "software",
  presentation: "speech",
  manuscript: "manuscript",
  other: "document",
};

type CslName = { readonly literal: string } | { readonly family?: string; readonly given?: string };

/** The Zotero item type a record stands for, where it has one: it decides roles and CSL type. */
function zoteroTypeOf(record: ScientSourceRecord): string | null {
  if (record.type === "software") return "computerProgram";
  if (record.type === "presentation") return "presentation";
  return record.type === "other" && record.customType && record.customType in ZOTERO_TYPE_CSL
    ? record.customType
    : null;
}

/**
 * Every creator under the CSL variable its role is cited with, as Zotero cites it: a film's
 * director stays its director. Only a type's primary role that CSL has no variable for (a
 * program's programmer) is its author; any other such role stays out of the citation.
 */
function cslNamesByVariable(record: ScientSourceRecord): {
  readonly names: Readonly<Record<string, CslName[]>>;
  readonly incomplete: ReadonlyArray<string>;
} {
  const primary = ZOTERO_PRIMARY_ROLE[zoteroTypeOf(record) ?? ""]?.toLowerCase();
  const names: Record<string, CslName[]> = {};
  const incomplete = new Set<string>();
  for (const creator of record.creators) {
    const role = creator.creatorType.toLowerCase();
    const variable = ZOTERO_ROLE_CSL[role] ?? (role === primary ? "author" : undefined);
    const name: CslName | null = creator.literalName
      ? { literal: creator.literalName }
      : creator.familyName || creator.givenName
        ? {
            ...(creator.familyName ? { family: creator.familyName } : {}),
            ...(creator.givenName ? { given: creator.givenName } : {}),
          }
        : null;
    if (!variable || !name) continue;
    (names[variable] ??= []).push(name);
    if (scientCreatorRoleIncomplete(record.incompleteCreatorRoles, role)) incomplete.add(variable);
  }
  return { names, incomplete: [...incomplete] };
}

/** The record's further details as CSL variables: text as it is, a date as a CSL date. */
function cslMore(record: ScientSourceRecord): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(record.more ?? {}).flatMap(([name, value]): Array<[string, unknown]> => {
      if (name === "extra") return [];
      return [[name, scientSourceMoreKind(name) === "date" ? cslDateFromText(value) : value]];
    }),
  );
}

/**
 * A date kept as text, as a CSL date: a plain date or a range of two (`1824/1825`) by its
 * parts, anything else ("ca. 1890", "Spring 2020") whole as a literal. Never a part of the
 * text taken for the whole.
 */
/** Year, then a real month, then a real day: Zotero writes an unknown one as `00`. */
function dateParts(year: string, month?: string, day?: string): number[] {
  const parts = [Number(year)];
  if (!month || Number(month) < 1 || Number(month) > 12) return parts;
  parts.push(Number(month));
  if (day && Number(day) >= 1 && Number(day) <= 31) parts.push(Number(day));
  return parts;
}

/**
 * A date kept as text, as CSL takes it. A plain date, a range of two, "circa 1850" and
 * "Spring 2020" become their parts; any other text is cited whole, as written.
 */
export function cslDateFromText(text: string): Readonly<Record<string, unknown>> {
  const about = /^(?:c\.|ca\.|circa)\s*(.+)$/iu.exec(text.trim());
  const season = /^(spring|summer|autumn|fall|winter)\s+(\d{4})$/iu.exec(
    (about?.[1] ?? text).trim(),
  );
  const dates = (season?.[2] ?? about?.[1] ?? text).split("/").map((value) => {
    const match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:[T ]\d{2}:\d{2}(?::\d{2})?Z?)?$/u.exec(
      value.trim(),
    );
    return match?.[1] ? dateParts(match[1], match[2], match[3]) : null;
  });
  if (dates.length > 2 || !dates.every((date) => date !== null)) return { literal: text };
  const named = season?.[1]?.toLowerCase().replace("fall", "autumn");
  return {
    "date-parts": dates,
    ...(named ? { season: SEASONS.findIndex((name) => name.toLowerCase() === named) + 1 } : {}),
    ...(about ? { circa: true } : {}),
  };
}

/** The record's own date: as above when it reads as one, else what its beginning says. */
function cslIssued(raw: string | null, year: number | null) {
  const read = raw ? cslDateFromText(raw) : null;
  if (read && "date-parts" in read) return read;
  const match = raw?.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/u);
  if (match?.[1]) return { "date-parts": [dateParts(match[1], match[2], match[3])] };
  if (year !== null) return { "date-parts": [[year]] };
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
  const zoteroType = zoteroTypeOf(record);
  const more = cslMore(record);
  const { names, incomplete } = cslNamesByVariable(record);
  const fields: Record<string, unknown> = {
    // First, so that none of them can stand in for a field the record has of its own.
    ...more,
    id: options.id ?? citationKey,
    "citation-key": citationKey || undefined,
    type:
      record.type === "other" && zoteroType
        ? ZOTERO_TYPE_CSL[zoteroType]
        : CSL_TYPE_BY_TYPE[record.type],
    title: record.title ?? undefined,
    ...names,
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
    number: more.number ?? (arxiv ? `arXiv:${arxiv}` : undefined),
    // A type a person named themselves is its genre; a Zotero type name is not one.
    genre:
      more.genre ??
      (record.type === "preprint"
        ? "Preprint"
        : record.type === "other" && record.customType && !zoteroType
          ? record.customType
          : undefined),
    abstract: options.includeAbstracts !== false ? (record.abstract ?? undefined) : undefined,
    keyword: record.tags.length > 0 ? record.tags.join(", ") : undefined,
    note: options.includeNotes ? (record.note ?? undefined) : undefined,
    // CSL has no field for a list that stops short; other programs ignore this one.
    custom: incomplete.length > 0 ? { [CSL_INCOMPLETE_NAMES]: incomplete } : undefined,
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
