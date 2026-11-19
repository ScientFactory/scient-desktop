// @effect-diagnostics nodeBuiltinImport:off -- A Zotero note's digest is a sha256 of its HTML, computed in place.
import * as NodeCrypto from "node:crypto";

import {
  citationKeyFromZoteroExtra,
  isScientSourceMoreName,
  normalizeImportedCitationKey,
  normalizeScientSourceMore,
  normalizeScientSourceAbstractDocument,
  scientSourceTypeFromZotero,
  zoteroGroupLibraryId,
  type ScientSourceCandidate,
  type ScientSourceCreator,
  type ScientSourceFieldProvenance,
  type ScientSourceIdentifier,
  type ScientSourceNotBrought,
  type ZoteroCollection,
  type ZoteroTypedTarget,
  ZOTERO_BASE_FIELD,
  ZOTERO_FIELD_TARGET,
  ZOTERO_ROLE_CSL,
  ZOTERO_ROLE_SPELLING,
} from "@scientfactory/scient-sources";
import { ScientUnplacedAnnotation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { ZOTERO_NOTE_CHARACTERS, zoteroNotesMarkdown } from "./ZoteroNoteMarkdown.ts";

export const ZOTERO_ITEM_KEY_PATTERN = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/u;
/** How many PDFs of one item an import copies. */
export const ZOTERO_PDFS_PER_ITEM = 10;
/** How much of a reference's notes is kept as Zotero wrote them (HTML), by whole notes. */
const ZOTERO_NOTE_ORIGINAL_CHARACTERS = 1_000_000;

const ZoteroRawCreator = Schema.Struct({
  creatorType: Schema.optionalKey(Schema.String),
  firstName: Schema.optionalKey(Schema.String),
  lastName: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});

const OptionalText = Schema.optionalKey(Schema.String);

const ZoteroRawItemData = Schema.Struct({
  key: Schema.String,
  version: Schema.Int,
  itemType: Schema.String,
  title: OptionalText,
  creators: Schema.optionalKey(Schema.Array(ZoteroRawCreator)),
  date: OptionalText,
  DOI: OptionalText,
  ISBN: OptionalText,
  ISSN: OptionalText,
  PMID: OptionalText,
  PMCID: OptionalText,
  abstractNote: OptionalText,
  publicationTitle: OptionalText,
  bookTitle: OptionalText,
  proceedingsTitle: OptionalText,
  websiteTitle: OptionalText,
  blogTitle: OptionalText,
  forumTitle: OptionalText,
  encyclopediaTitle: OptionalText,
  dictionaryTitle: OptionalText,
  publisher: OptionalText,
  university: OptionalText,
  institution: OptionalText,
  repository: OptionalText,
  volume: OptionalText,
  issue: OptionalText,
  pages: OptionalText,
  language: OptionalText,
  url: OptionalText,
  extra: OptionalText,
  citationKey: OptionalText,
  // `type` 1 marks a tag a program added (a publisher's keyword), not the person.
  tags: Schema.optionalKey(
    Schema.Array(Schema.Struct({ tag: Schema.String, type: Schema.optionalKey(Schema.Number) })),
  ),
  relations: Schema.optionalKey(Schema.Unknown),
  collections: Schema.optionalKey(Schema.Array(Schema.String)),
  note: OptionalText,
  parentItem: Schema.optionalKey(Schema.Union([Schema.String, Schema.Boolean])),
  contentType: OptionalText,
  filename: OptionalText,
  linkMode: OptionalText,
  dateAdded: OptionalText,
  // A highlight or comment on a file: an item under the attachment.
  annotationType: OptionalText,
  annotationText: OptionalText,
  annotationComment: OptionalText,
  annotationColor: OptionalText,
  /** `pageIndex` (from 0) and the marked rectangles, as JSON text. */
  annotationPosition: OptionalText,
  dateModified: OptionalText,
});

const ZoteroRawLibrary = Schema.Struct({
  type: Schema.String,
  id: Schema.Union([Schema.String, Schema.Number]),
});

/**
 * A library as a source's link names it: `groups/<id>`, or the user ID for My Library. Zotero
 * on this computer reports the signed-in user's ID there, or `0` when it is not signed in.
 */
function zoteroLibraryId(library: typeof ZoteroRawLibrary.Type): string {
  return library.type === "group" ? zoteroGroupLibraryId(String(library.id)) : String(library.id);
}

export const ZoteroRawItem = Schema.Struct({
  key: Schema.String,
  version: Schema.Int,
  library: ZoteroRawLibrary,
  data: ZoteroRawItemData,
  /** On zotero.org, `numChildren` of a file counts the highlights and comments made on it. */
  meta: Schema.optionalKey(Schema.Struct({ numChildren: Schema.optionalKey(Schema.Number) })),
  /**
   * Every text field Zotero sent for the item that is not empty, by Zotero's name, whether
   * Sources reads it or not: what the import brought is checked against all of it. Not part of
   * Zotero's answer; `decodeZoteroRawItem` fills it in.
   */
  fields: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Every field the item's type has, empty ones too: what Zotero accepts back for it. */
  fieldNames: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ZoteroRawItem = typeof ZoteroRawItem.Type;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The non-empty text fields of an item's data, by Zotero's name. */
function textFields(data: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  for (const [name, field] of Object.entries(data)) {
    if (typeof field === "string" && field.trim()) fields[name] = field;
  }
  return fields;
}

/** The item as Zotero sent it, with its non-empty text fields listed before any are dropped. */
function withAllFields(value: unknown): unknown {
  return isRecord(value) && isRecord(value.data)
    ? { ...value, fields: textFields(value.data), fieldNames: Object.keys(value.data) }
    : value;
}

/** Every text field Zotero sent; for an item made in code, the ones its data has. */
const fieldsOf = (item: ZoteroRawItem) => item.fields ?? textFields(item.data);

const decodeRawItem = Schema.decodeUnknownSync(ZoteroRawItem);
const decodeRawItems = Schema.decodeUnknownSync(Schema.Array(ZoteroRawItem));
export const decodeZoteroRawItem = (value: unknown): ZoteroRawItem =>
  decodeRawItem(withAllFields(value));
export const decodeZoteroRawItems = (value: unknown): ReadonlyArray<ZoteroRawItem> =>
  decodeRawItems(Array.isArray(value) ? value.map(withAllFields) : value);

const ZoteroRawCollection = Schema.Struct({
  key: Schema.String,
  library: ZoteroRawLibrary,
  data: Schema.Struct({
    key: Schema.String,
    name: Schema.String,
    parentCollection: Schema.optionalKey(Schema.Union([Schema.String, Schema.Boolean])),
  }),
});
export const decodeZoteroRawCollections = Schema.decodeUnknownSync(
  Schema.Array(ZoteroRawCollection),
);
type ZoteroRawCollection = typeof ZoteroRawCollection.Type;

/** A collection with its library, as `zoteroLibraryId` names it: a key is unique only there. */
export interface ZoteroLibraryCollection extends ZoteroCollection {
  readonly libraryId: string;
}

export function collectionFromRaw(raw: ZoteroRawCollection): ZoteroLibraryCollection {
  const parent = raw.data.parentCollection;
  return {
    key: raw.data.key || raw.key,
    name: raw.data.name.trim() || "Untitled collection",
    parentCollectionKey: typeof parent === "string" && parent.trim() ? parent : null,
    libraryId: zoteroLibraryId(raw.library),
  };
}

function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function creator(raw: typeof ZoteroRawCreator.Type): ScientSourceCreator | null {
  const givenName = text(raw.firstName);
  const familyName = text(raw.lastName);
  const literalName = text(raw.name);
  if (!givenName && !familyName && !literalName) return null;
  return {
    creatorType: text(raw.creatorType) ?? "author",
    givenName,
    familyName,
    literalName,
  };
}

function publicationYear(date: string | undefined): number | null {
  const match = date?.match(/(?:^|\D)(1[5-9]\d{2}|20\d{2}|21\d{2})(?:\D|$)/u);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

const EXTRA_FIELDS: Readonly<Record<string, string>> = {
  pmid: "pmid",
  pmcid: "pmcid",
  arxiv: "arxiv",
  doi: "doi",
  isbn: "isbn",
  issn: "issn",
};

/**
 * Zotero keeps fields its schema lacks as `Name: value` lines in Extra; PubMed
 * imports put PMIDs there.
 */
function zoteroExtraFields(extra: string | undefined): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  for (const { name, value } of zoteroExtraLines(extra)) {
    const field = name === undefined ? undefined : EXTRA_FIELDS[name];
    if (field && value && !(field in fields)) fields[field] = value;
  }
  return fields;
}

/**
 * The lines of Zotero's Extra, each with the name and value of a `Name: value` line (the
 * name in lower case), or neither for free text. The one reader of Extra: the import and
 * Send both go through it.
 */
export function zoteroExtraLines(extra: string | undefined): ReadonlyArray<{
  readonly line: string;
  readonly name?: string;
  readonly value?: string;
}> {
  return (extra ?? "").split(/\r?\n/u).flatMap((raw) => {
    const line = raw.trim();
    if (!line) return [];
    const match = /^([A-Za-z][A-Za-z0-9 _-]{0,60}?)\s*:\s*(\S.*)$/u.exec(line);
    return match?.[1] && match[2]
      ? [{ line, name: match[1].toLowerCase().trim(), value: match[2].trim() }]
      : [{ line }];
  });
}

/** The Better BibTeX or Zotero citation key the item carries itself, if any. */
function zoteroCitationKey(data: ZoteroRawItem["data"]): string | null {
  return normalizeImportedCitationKey(data.citationKey) ?? citationKeyFromZoteroExtra(data.extra);
}

/** Zotero's creator roles a line of Extra may name, by the role or its CSL variable. */
const ROLE_BY_EXTRA_NAME: ReadonlyMap<string, string> = new Map([
  ...Object.entries(ZOTERO_ROLE_CSL).map(([role, csl]) => [csl, role] as const),
  ...Object.keys(ZOTERO_ROLE_CSL).map((role) => [role, role] as const),
]);
/** Types whose place is where the event was, not where a publisher is. */
export const PLACE_IS_EVENT: ReadonlySet<string> = new Set([
  "presentation",
  "audioRecording",
  "videoRecording",
]);

/** A Zotero field name as a person may write it in Extra: `Original Date`, `original-date`. */
const squeezed = (name: string) => name.toLowerCase().replace(/[\s_-]+/gu, "");
const FIELD_BY_SQUEEZED: ReadonlyMap<string, string> = new Map(
  Object.keys(ZOTERO_FIELD_TARGET).map((name) => [squeezed(name), name]),
);
/** A creator, as Zotero reads one from a line of Extra: `editor: Family || Given`, or one name. */
export function zoteroExtraCreator(name: string, value: string) {
  const role =
    ROLE_BY_EXTRA_NAME.get(name.replace(/\s+/gu, "-")) ?? ROLE_BY_EXTRA_NAME.get(squeezed(name));
  if (role === undefined) return undefined;
  const [family, given] = value.split("||").map((part) => part.trim());
  return {
    creatorType: ZOTERO_ROLE_SPELLING[role] ?? role,
    givenName: given || null,
    familyName: given === undefined ? null : family || null,
    literalName: given === undefined ? (family ?? value) : null,
  };
}

/** CSL names for the record's own fields, which Zotero lets a person give in Extra. */
const TYPED_BY_CSL: Readonly<Record<string, ZoteroTypedTarget>> = {
  title: "title",
  issued: "issuedRaw",
  "container-title": "containerTitle",
  publisher: "publisher",
  volume: "volume",
  issue: "issue",
  page: "pages",
  language: "language",
  url: "url",
};

/** The place a line of Extra names, by a CSL variable or a Zotero field name; none for free text. */
export function zoteroExtraLineTarget(
  name: string,
): { readonly typed: ZoteroTypedTarget } | { readonly more: string } | undefined {
  const csl = name.toLowerCase().trim().replace(/\s+/gu, "-");
  // In Extra, `Type:` names the kind of item to cite it as, not a thesis's or report's kind.
  if (csl === "type") return undefined;
  const variable = [csl, csl.replace(/-/gu, "_")].find(isScientSourceMoreName);
  if (variable !== undefined && variable !== "extra") return { more: variable };
  const typed = TYPED_BY_CSL[csl];
  if (typed) return { typed };
  const field = FIELD_BY_SQUEEZED.get(squeezed(name));
  return field ? ZOTERO_FIELD_TARGET[field] : undefined;
}

/**
 * Where a Zotero item's bibliographic text goes: each field, under its general name, into the
 * record's own field or `more`; the first to want a place gets it. A line of Extra that names
 * a field fills it when the item has none; what has no place is kept as a line under `extra`.
 */
function zoteroBibliographic(item: ZoteroRawItem): {
  readonly typed: Readonly<Partial<Record<ZoteroTypedTarget, string>>>;
  readonly more: Readonly<Record<string, string>> | null;
  /** The Zotero field each filled place came from. */
  readonly from: ReadonlyMap<string, string>;
  readonly lost: ReadonlyArray<string>;
  /** Lines of Extra that could not be kept (too long together), by name. */
  readonly extraLost: ReadonlyArray<string>;
  /** Creators Extra names (`editor: Smith || Jane`), as Zotero cites them. */
  readonly creators: ReadonlyArray<ScientSourceCreator>;
} {
  const fields = fieldsOf(item);
  const typed: Partial<Record<ZoteroTypedTarget, string>> = {};
  const more: Record<string, string> = {};
  const from = new Map<string, string>();
  const lost: string[] = [];
  // General names first, so a type's own name never displaces the general field.
  const names = Object.keys(fields).toSorted(
    (left, right) =>
      Number(left in ZOTERO_BASE_FIELD) - Number(right in ZOTERO_BASE_FIELD) ||
      Object.keys(ZOTERO_FIELD_TARGET).indexOf(ZOTERO_BASE_FIELD[left] ?? left) -
        Object.keys(ZOTERO_FIELD_TARGET).indexOf(ZOTERO_BASE_FIELD[right] ?? right),
  );
  /** Fields with no place of their own, or whose place another field took: kept as lines. */
  const asLines: string[] = [];
  for (const name of names) {
    const value = text(fields[name]);
    if (!value || FIELDS_NOT_CONTENT.has(name) || IDENTIFIER_FIELDS.has(name)) continue;
    const general = ZOTERO_BASE_FIELD[name] ?? name;
    // A talk's or a recording's place is where it happened.
    const target =
      general === "place" && PLACE_IS_EVENT.has(item.data.itemType)
        ? { more: "event-place" as const }
        : ZOTERO_FIELD_TARGET[general];
    if (target && "typed" in target && typed[target.typed] === undefined) {
      typed[target.typed] = value;
      from.set(target.typed, name);
    } else if (target && "more" in target && more[target.more] === undefined) {
      more[target.more] = value;
      from.set(`more.${target.more}`, name);
    } else {
      asLines.push(name);
    }
  }
  // As Zotero itself keeps a field a type has no place for: a line `Name: value` in Extra.
  const extraKept: string[] = asLines.map(
    (name) =>
      `${name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/^./u, (first) => first.toUpperCase())}: ${text(fields[name])}`,
  );
  const creators: ScientSourceCreator[] = [];
  const keptIdentifiers = identifiers(item.data);
  const keptKey = zoteroCitationKey(item.data);
  for (const { line, name, value } of zoteroExtraLines(fields.extra)) {
    if (name === undefined || value === undefined) {
      extraKept.push(line);
      continue;
    }
    // An identifier or a citation key the record took leaves Extra; another value for the
    // same thing (an earlier DOI, a second PMID) is kept as written, never dropped.
    const scheme = EXTRA_FIELDS[name];
    if (scheme !== undefined) {
      const taken = keptIdentifiers.some(
        (identifier) =>
          identifier.scheme === scheme && identifier.value.toLowerCase() === value.toLowerCase(),
      );
      if (!taken) extraKept.push(line);
      continue;
    }
    if (name === "citation key") {
      if (normalizeImportedCitationKey(value) !== keptKey) extraKept.push(line);
      continue;
    }
    const creator = zoteroExtraCreator(name, value);
    if (creator) {
      creators.push(creator);
      continue;
    }
    const target = zoteroExtraLineTarget(name);
    if (target && "typed" in target && typed[target.typed] === undefined) {
      typed[target.typed] = value;
      from.set(target.typed, "extra");
    } else if (target && "more" in target && more[target.more] === undefined) {
      more[target.more] = value;
      from.set(`more.${target.more}`, "extra");
    } else {
      // No place of its own, or the item's field already fills it: kept as written.
      extraKept.push(line);
    }
  }
  if (extraKept.length > 0) more.extra = extraKept.join("\n");
  const normalized = normalizeScientSourceMore(more);
  const extraLost: string[] = [];
  for (const name of normalized.left) {
    if (name === "extra") {
      extraLost.push("(text)");
      lost.push(...asLines);
    } else if (from.get(`more.${name}`) === "extra") extraLost.push(name);
    else lost.push(from.get(`more.${name}`) ?? name);
    from.delete(`more.${name}`);
  }
  // A field kept as a line is brought, under Extra.
  if (!normalized.left.includes("extra")) {
    for (const name of asLines) from.set(`more.extra:${name}`, name);
  }
  return { typed, more: normalized.more, from, lost, extraLost, creators };
}

function identifierEntries(
  data: ZoteroRawItem["data"],
): ReadonlyArray<readonly [scheme: string, value: string | null, sourceField: string]> {
  const extra = zoteroExtraFields(data.extra);
  return [
    ["doi", text(data.DOI) ?? text(extra.doi), text(data.DOI) ? "DOI" : "extra"],
    ["isbn", text(data.ISBN) ?? text(extra.isbn), text(data.ISBN) ? "ISBN" : "extra"],
    ["issn", text(data.ISSN) ?? text(extra.issn), text(data.ISSN) ? "ISSN" : "extra"],
    ["pmid", text(data.PMID) ?? text(extra.pmid), text(data.PMID) ? "PMID" : "extra"],
    ["pmcid", text(data.PMCID) ?? text(extra.pmcid), text(data.PMCID) ? "PMCID" : "extra"],
    ["arxiv", text(extra.arxiv), "extra"],
  ];
}

function identifiers(data: ZoteroRawItem["data"]): ReadonlyArray<ScientSourceIdentifier> {
  return identifierEntries(data).flatMap(([scheme, value]) => (value ? [{ scheme, value }] : []));
}

/** Where each filled field came from in Zotero, by the record's field. */
function provenance(
  data: ZoteroRawItem["data"],
  from: ReadonlyMap<string, string>,
): ReadonlyArray<ScientSourceFieldProvenance> {
  const zotero = (field: string, sourceField: string) => ({
    field,
    origin: "zotero" as const,
    sourceField,
  });
  return [
    ...[...from].flatMap(([field, sourceField]) =>
      field.startsWith("more.extra:") ? [] : [zotero(field, sourceField)],
    ),
    ...((data.creators ?? []).length > 0 ? [zotero("creators", "creators")] : []),
    ...((data.tags ?? []).some((tag) => tag.tag.trim().length > 0) ? [zotero("tags", "tags")] : []),
    ...identifierEntries(data).flatMap(([scheme, value, sourceField]) =>
      value ? [zotero(`identifiers.${scheme}`, sourceField)] : [],
    ),
  ];
}

export function zoteroItemToCandidate(raw: ZoteroRawItem): ScientSourceCandidate {
  const data = raw.data;
  const type = scientSourceTypeFromZotero(data.itemType);
  const { typed, more, from, creators: fromExtra } = zoteroBibliographic(raw);
  const abstract = normalizeScientSourceAbstractDocument(typed.abstract);
  return {
    sourceKey: raw.key,
    type,
    // Preserve Zotero's exact genre when it is outside Scient's deliberately
    // small canonical type set. Otherwise editing an imported record would
    // present an unexplained, invalid "Other source" with its type discarded.
    customType: type === "other" ? text(data.itemType) : null,
    title: typed.title ?? null,
    creators: [
      ...(data.creators ?? []).flatMap((value) => {
        const normalized = creator(value);
        return normalized ? [normalized] : [];
      }),
      ...fromExtra,
    ],
    issuedRaw: typed.issuedRaw ?? null,
    issuedYear: publicationYear(typed.issuedRaw),
    identifiers: identifiers(data),
    abstract: abstract?.text ?? null,
    ...(abstract ? { abstractSections: [...abstract.sections] } : {}),
    containerTitle: typed.containerTitle ?? null,
    publisher: typed.publisher ?? null,
    volume: typed.volume ?? null,
    issue: typed.issue ?? null,
    pages: typed.pages ?? null,
    language: typed.language ?? null,
    url: typed.url ?? null,
    ...(more ? { more } : {}),
    tags: (data.tags ?? []).map((tag) => tag.tag.trim()).filter(Boolean),
    externalReferences: [
      {
        system: "zotero",
        libraryId: zoteroLibraryId(raw.library),
        itemKey: raw.key,
        itemVersion: raw.version,
        rawItemType: data.itemType,
      },
    ],
    fieldProvenance: provenance(data, from),
    pdfAvailable: false,
    pdfFileName: null,
    pdfAttachmentCount: 0,
  };
}

export function importableZoteroItems(
  items: ReadonlyArray<ZoteroRawItem>,
): ReadonlyArray<ZoteroRawItem> {
  return items.filter(
    (item) =>
      item.data.itemType !== "note" &&
      item.data.itemType !== "annotation" &&
      item.data.itemType !== "attachment",
  );
}

function compareZoteroAttachments(left: ZoteroRawItem, right: ZoteroRawItem): number {
  const leftName = text(left.data.filename) ?? "";
  const rightName = text(right.data.filename) ?? "";
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return 0;
}

/** Stored or linked PDF files; linked URLs have no file to copy. */
function zoteroPdfAttachments(
  children: ReadonlyArray<ZoteroRawItem>,
): ReadonlyArray<ZoteroRawItem> {
  return children
    .filter(
      (child) =>
        child.data.itemType === "attachment" &&
        child.data.contentType?.toLowerCase() === "application/pdf" &&
        child.data.linkMode !== "linked_url",
    )
    .toSorted(compareZoteroAttachments);
}

/** A highlight or comment Zotero holds on one of an item's files. */
export interface ZoteroPdfAnnotation {
  readonly key: string;
  readonly attachmentKey: string;
  readonly kind: ScientUnplacedAnnotation["kind"];
  /** The page, counted from 1; null when Zotero did not say. */
  readonly page: number | null;
  readonly text: string;
  readonly comment: string;
  readonly color: string | null;
  readonly addedAt: string | null;
}

const isAnnotationKind = Schema.is(ScientUnplacedAnnotation.fields.kind);

function annotationPage(position: string | undefined): number | null {
  let value: unknown;
  try {
    value = JSON.parse(position ?? "");
  } catch {
    return null;
  }
  const index =
    typeof value === "object" && value !== null && "pageIndex" in value ? value.pageIndex : null;
  return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index + 1 : null;
}

/** The highlights and comments among an item's children, as Zotero holds them. */
function zoteroPdfAnnotations(
  children: ReadonlyArray<ZoteroRawItem>,
): ReadonlyArray<ZoteroPdfAnnotation> {
  return children.flatMap((child) => {
    const data = child.data;
    if (data.itemType !== "annotation" || typeof data.parentItem !== "string") return [];
    const type = data.annotationType ?? "";
    const color = data.annotationColor?.trim().toLowerCase() ?? "";
    return [
      {
        key: child.key,
        attachmentKey: data.parentItem,
        // A kind Zotero adds later is kept as a comment, with its page and text.
        kind: isAnnotationKind(type) ? type : "note",
        page: annotationPage(data.annotationPosition),
        text: data.annotationText ?? "",
        comment: data.annotationComment ?? "",
        color: /^#[0-9a-f]{6}$/u.test(color) ? color : null,
        addedAt: data.dateAdded ?? data.dateModified ?? null,
      },
    ];
  });
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (entity, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    if (name.startsWith("#")) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    return HTML_ENTITIES[name.toLowerCase()] ?? entity;
  });
}

/** How an import wrote a note before notes became Markdown; see `legacyZoteroNotesText`. */
function legacyZoteroNoteText(html: string): string {
  const withMarks = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<li\b[^>]*>/giu, "\n- ")
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|blockquote|pre|tr)>/giu, "\n\n")
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/giu, "**$2**")
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/giu, "*$2*")
    .replace(/<[^>]+>/gu, "");
  return decodeHtmlEntities(withMarks)
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * The plain text an import made of a reference's notes before they became Markdown, kept
 * exactly as it was: a refresh compares it with what an earlier import stored, to tell a
 * note nobody touched from one edited here or changed in Zotero.
 */
function legacyZoteroNotesText(children: ReadonlyArray<ZoteroRawItem>): string | null {
  const notes = children
    .filter((child) => child.data.itemType === "note")
    .toSorted((left, right) => left.key.localeCompare(right.key))
    .map((child) => legacyZoteroNoteText(child.data.note ?? ""))
    .filter((note) => note.length > 0);
  if (notes.length === 0) return null;
  return notes.join("\n\n---\n\n").slice(0, ZOTERO_NOTE_CHARACTERS);
}

/**
 * A note as Zotero wrote it: its digest always, so a refresh sees every change, and its HTML
 * to keep while the reference's notes fit the bound.
 */
export interface ZoteroNoteOriginal {
  readonly itemKey: string;
  readonly sha256: string;
  readonly html?: string;
}

/**
 * A reference's notes as Zotero wrote them, by key, without the bytes of embedded images
 * (images are not carried and are counted). The HTML of whole notes, as many as the bound
 * holds; a note past it has only its digest.
 */
function zoteroNoteOriginals(
  children: ReadonlyArray<ZoteroRawItem>,
): ReadonlyArray<ZoteroNoteOriginal> {
  let characters = 0;
  return children
    .toSorted((left, right) => left.key.localeCompare(right.key))
    .flatMap((child) => {
      if (child.data.itemType !== "note" || !child.data.note?.trim()) return [];
      const html = child.data.note.replace(/(\ssrc\s*=\s*["'])data:[^"']*/giu, "$1");
      const sha256 = NodeCrypto.createHash("sha256").update(html).digest("hex");
      const kept = characters + html.length <= ZOTERO_NOTE_ORIGINAL_CHARACTERS;
      if (kept) characters += html.length;
      return [{ itemKey: child.key, sha256, ...(kept ? { html } : {}) }];
    });
}

/** Fields that are not bibliographic text, or are read elsewhere (identifiers, notes, files). */
const FIELDS_NOT_CONTENT: ReadonlySet<string> = new Set([
  "key",
  "itemType",
  "dateAdded",
  "dateModified",
  "parentItem",
  "extra",
  "note",
  "contentType",
  "filename",
  "linkMode",
  "charset",
  "md5",
  "mtime",
  "path",
]);
const IDENTIFIER_FIELDS: ReadonlySet<string> = new Set([
  "DOI",
  "ISBN",
  "ISSN",
  "PMID",
  "PMCID",
  "citationKey",
]);

/**
 * Where each non-empty text field of a Zotero item goes: into the record, nowhere, or it is not
 * content. A field is brought when it filled a place; one that lost its place to another field
 * of the item, or has none, is not.
 */
export function zoteroFieldDispositions(
  item: ZoteroRawItem,
): ReadonlyMap<string, "brought" | "not-brought" | "not-content"> {
  const filled = new Set(zoteroBibliographic(item).from.values());
  return new Map(
    Object.keys(fieldsOf(item)).map((name) => [
      name,
      FIELDS_NOT_CONTENT.has(name)
        ? "not-content"
        : filled.has(name) || IDENTIFIER_FIELDS.has(name)
          ? "brought"
          : "not-brought",
    ]),
  );
}

function relatedCount(relations: unknown): number {
  const related = isRecord(relations) ? relations["dc:relation"] : undefined;
  return Array.isArray(related) ? related.length : typeof related === "string" && related ? 1 : 0;
}

/** Adds to what an item did not bring: one entry for each kind and name, counts summed. */
export function addNotBrought(
  listed: ScientSourceNotBrought[],
  kind: ScientSourceNotBrought["kind"],
  count: number,
  name?: string,
): void {
  if (count <= 0) return;
  const at = listed.findIndex((entry) => entry.kind === kind && entry.name === name);
  if (at >= 0) listed[at] = { ...listed[at]!, count: listed[at]!.count + count };
  else listed.push({ kind, ...(name === undefined ? {} : { name: name.slice(0, 120) }), count });
}

/**
 * What Zotero holds for an item that the import does not bring, or brings changed: checked
 * against everything Zotero sent, so nothing is left out without being counted here.
 */
function zoteroNotBrought(
  item: ZoteroRawItem,
  children: ReadonlyArray<ZoteroRawItem>,
  notes: {
    readonly images: number;
    readonly cut: boolean;
    readonly originals: ReadonlyArray<ZoteroNoteOriginal>;
  },
  annotations: ReadonlyArray<ZoteroPdfAnnotation>,
): ReadonlyArray<ScientSourceNotBrought> {
  const listed: ScientSourceNotBrought[] = [];
  const add = (kind: ScientSourceNotBrought["kind"], count: number, name?: string) =>
    addNotBrought(listed, kind, count, name);
  for (const [name, disposition] of zoteroFieldDispositions(item)) {
    if (disposition === "not-brought") add("field", 1, name);
  }
  // Lines of Extra are kept as written; only ones too long to keep are listed.
  for (const name of zoteroBibliographic(item).extraLost) add("extra", 1, name);
  add("related", relatedCount(item.data.relations));
  add("automatic-tags", (item.data.tags ?? []).filter((tag) => tag.type === 1).length);

  const attachments = children.filter((child) => child.data.itemType === "attachment");
  const pdfs = zoteroPdfAttachments(children);
  const copied = new Set(pdfs.slice(0, ZOTERO_PDFS_PER_ITEM).map((pdf) => pdf.key));
  add("pdf", Math.max(0, pdfs.length - ZOTERO_PDFS_PER_ITEM), "over-limit");
  for (const attachment of attachments) {
    if (pdfs.includes(attachment)) continue;
    if (attachment.data.linkMode === "linked_url") add("link", 1);
    else add("file", 1, attachment.data.contentType?.toLowerCase() || "unknown");
  }
  // Those on a PDF that is copied are placed or kept by the import, which counts the rest.
  add(
    "highlights",
    annotations.filter((annotation) => !copied.has(annotation.attachmentKey)).length,
    "no-file",
  );
  add("note-images", notes.images);
  add("note-cut", notes.cut ? 1 : 0);
  add("note-cut", notes.originals.some((note) => note.html === undefined) ? 1 : 0, "original");
  return listed;
}

/** Everything one Zotero item brings: its metadata, notes, PDFs, citation key and collections. */
export interface ZoteroItemMaterial {
  readonly candidate: ScientSourceCandidate;
  /** The item's notes as one Markdown note. */
  readonly note: string | null;
  /** The same notes as Zotero wrote them. */
  readonly notes: ReadonlyArray<ZoteroNoteOriginal>;
  /** The note as an import wrote it before notes became Markdown. */
  readonly legacyNote: string | null;
  readonly citationKey: string | null;
  readonly collectionKeys: ReadonlyArray<string>;
  readonly pdfs: ReadonlyArray<ZoteroRawItem>;
  /** The highlights and comments on the item's files. */
  readonly annotations: ReadonlyArray<ZoteroPdfAnnotation>;
  /** What Zotero holds for the item that this does not bring. */
  readonly notBrought: ReadonlyArray<ScientSourceNotBrought>;
}

/** `children` are the item's notes and files, and the highlights and comments on its files. */
export function zoteroItemMaterial(
  item: ZoteroRawItem,
  children: ReadonlyArray<ZoteroRawItem>,
  citationKey: string | null = zoteroCitationKey(item.data),
): ZoteroItemMaterial {
  const pdfs = zoteroPdfAttachments(children);
  const primaryPdf = pdfs[0];
  const notes = {
    ...zoteroNotesMarkdown(
      children.flatMap((child) =>
        child.data.itemType === "note" ? [{ itemKey: child.key, html: child.data.note ?? "" }] : [],
      ),
    ),
    originals: zoteroNoteOriginals(children),
  };
  const annotations = zoteroPdfAnnotations(children);
  return {
    candidate: {
      ...zoteroItemToCandidate(item),
      ...(citationKey ? { citationKey } : {}),
      pdfAvailable: primaryPdf !== undefined,
      pdfFileName: primaryPdf ? text(primaryPdf.data.filename) : null,
      pdfAttachmentCount: pdfs.length,
    },
    note: notes.markdown,
    notes: notes.originals,
    legacyNote: legacyZoteroNotesText(children),
    citationKey,
    collectionKeys: [...(item.data.collections ?? [])],
    pdfs,
    annotations,
    notBrought: zoteroNotBrought(item, children, notes, annotations),
  };
}

export function zoteroDescendantCollectionKeys(
  collectionKey: string,
  collections: ReadonlyArray<ZoteroCollection>,
): ReadonlyArray<string> {
  const result = new Set<string>([collectionKey]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const collection of collections) {
      if (
        collection.parentCollectionKey &&
        result.has(collection.parentCollectionKey) &&
        !result.has(collection.key)
      ) {
        result.add(collection.key);
        changed = true;
      }
    }
  }
  return [...result];
}
