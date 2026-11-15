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
} from "@scientfactory/scient-sources";
import * as Schema from "effect/Schema";

export const ZOTERO_ITEM_KEY_PATTERN = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/u;
/** How many PDFs of one item an import copies. */
export const ZOTERO_PDFS_PER_ITEM = 10;
const MAX_IMPORTED_NOTE_CHARACTERS = 100_000;

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
  dateModified: OptionalText,
});

export const ZoteroRawItem = Schema.Struct({
  key: Schema.String,
  version: Schema.Int,
  library: Schema.Struct({
    type: Schema.String,
    id: Schema.Union([Schema.String, Schema.Number]),
  }),
  data: ZoteroRawItemData,
  /** `numChildren` of a PDF attachment counts the highlights and comments made on it. */
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

export function collectionFromRaw(raw: ZoteroRawCollection): ZoteroCollection {
  const parent = raw.data.parentCollection;
  return {
    key: raw.data.key || raw.key,
    name: raw.data.name.trim() || "Untitled collection",
    parentCollectionKey: typeof parent === "string" && parent.trim() ? parent : null,
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
  for (const line of (extra ?? "").split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z][A-Za-z ]*?)\s*:\s*(\S.*?)\s*$/u.exec(line);
    const name = match?.[1] ? EXTRA_FIELDS[match[1].toLowerCase()] : undefined;
    if (name && match?.[2] && !(name in fields)) fields[name] = match[2];
  }
  return fields;
}

/** The Better BibTeX or Zotero citation key the item carries itself, if any. */
function zoteroCitationKey(data: ZoteroRawItem["data"]): string | null {
  return normalizeImportedCitationKey(data.citationKey) ?? citationKeyFromZoteroExtra(data.extra);
}

/** A Zotero field name as a person may write it in Extra: `Original Date`, `original-date`. */
const squeezed = (name: string) => name.toLowerCase().replace(/[\s_-]+/gu, "");
const FIELD_BY_SQUEEZED: ReadonlyMap<string, string> = new Map(
  Object.keys(ZOTERO_FIELD_TARGET).map((name) => [squeezed(name), name]),
);
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
    const target = ZOTERO_FIELD_TARGET[ZOTERO_BASE_FIELD[name] ?? name];
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
  for (const line of (fields.extra ?? "").split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9 _-]{0,60}?)\s*:\s*(\S.*?)\s*$/u.exec(line);
    const name = match?.[1]?.toLowerCase().trim();
    const value = match?.[2];
    if (!line.trim()) continue;
    if (name === undefined || value === undefined) {
      extraKept.push(line.trim());
      continue;
    }
    // Read elsewhere: identifiers and the citation key.
    if (name in EXTRA_FIELDS || name === "citation key" || name === "issn" || name === "isbn") {
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
      extraKept.push(line.trim());
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
  return { typed, more: normalized.more, from, lost, extraLost };
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
  const { typed, more, from } = zoteroBibliographic(raw);
  const abstract = normalizeScientSourceAbstractDocument(typed.abstract);
  return {
    sourceKey: raw.key,
    type,
    // Preserve Zotero's exact genre when it is outside Scient's deliberately
    // small canonical type set. Otherwise editing an imported record would
    // present an unexplained, invalid "Other source" with its type discarded.
    customType: type === "other" ? text(data.itemType) : null,
    title: typed.title ?? null,
    creators: (data.creators ?? []).flatMap((value) => {
      const normalized = creator(value);
      return normalized ? [normalized] : [];
    }),
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
        libraryId:
          raw.library.type === "group"
            ? zoteroGroupLibraryId(String(raw.library.id))
            : String(raw.library.id),
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

/** Zotero notes are HTML; Source notes are plain text with Markdown bold and italic. */
export function zoteroNoteToText(html: string): string {
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

/** Child notes in a stable order, joined into one Source note. */
function zoteroNotesText(children: ReadonlyArray<ZoteroRawItem>): string | null {
  const notes = children
    .filter((child) => child.data.itemType === "note")
    .toSorted((left, right) => left.key.localeCompare(right.key))
    .map((child) => zoteroNoteToText(child.data.note ?? ""))
    .filter((note) => note.length > 0);
  if (notes.length === 0) return null;
  const joined = notes.join("\n\n---\n\n");
  return joined.length > MAX_IMPORTED_NOTE_CHARACTERS
    ? joined.slice(0, MAX_IMPORTED_NOTE_CHARACTERS)
    : joined;
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

const NOTE_FORMATTING = /<(a|h[1-6]|table|img|pre|code|blockquote)\b|data-citation/iu;

function relatedCount(relations: unknown): number {
  const related = isRecord(relations) ? relations["dc:relation"] : undefined;
  return Array.isArray(related) ? related.length : typeof related === "string" && related ? 1 : 0;
}

/**
 * What Zotero holds for an item that the import does not bring, or brings changed: checked
 * against everything Zotero sent, so nothing is left out without being counted here.
 */
function zoteroNotBrought(
  item: ZoteroRawItem,
  children: ReadonlyArray<ZoteroRawItem>,
): ReadonlyArray<ScientSourceNotBrought> {
  const listed: ScientSourceNotBrought[] = [];
  const add = (kind: ScientSourceNotBrought["kind"], count: number, name?: string) => {
    if (count <= 0) return;
    const at = listed.findIndex((entry) => entry.kind === kind && entry.name === name);
    if (at >= 0) listed[at] = { ...listed[at]!, count: listed[at]!.count + count };
    else listed.push({ kind, ...(name === undefined ? {} : { name: name.slice(0, 120) }), count });
  };
  for (const [name, disposition] of zoteroFieldDispositions(item)) {
    if (disposition === "not-brought") add("field", 1, name);
  }
  // Lines of Extra are kept as written; only ones too long to keep are listed.
  for (const name of zoteroBibliographic(item).extraLost) add("extra", 1, name);
  add("related", relatedCount(item.data.relations));
  add("automatic-tags", (item.data.tags ?? []).filter((tag) => tag.type === 1).length);

  const attachments = children.filter((child) => child.data.itemType === "attachment");
  const pdfs = zoteroPdfAttachments(children);
  add("pdf", Math.max(0, pdfs.length - ZOTERO_PDFS_PER_ITEM), "over-limit");
  for (const attachment of attachments) {
    // Highlights and comments are the PDF's own children; Zotero says how many it has.
    add("highlights", attachment.meta?.numChildren ?? 0);
    if (pdfs.includes(attachment)) continue;
    if (attachment.data.linkMode === "linked_url") add("link", 1);
    else add("file", 1, attachment.data.contentType?.toLowerCase() || "unknown");
  }
  const notes = children.filter((child) => child.data.itemType === "note");
  add("note-formatting", notes.filter((note) => NOTE_FORMATTING.test(note.data.note ?? "")).length);
  const joined = notes
    .map((note) => zoteroNoteToText(note.data.note ?? ""))
    .filter((note) => note.length > 0)
    .join("\n\n---\n\n");
  add("note-cut", joined.length > MAX_IMPORTED_NOTE_CHARACTERS ? 1 : 0);
  return listed;
}

/** Everything one Zotero item brings: its metadata, notes, PDFs, citation key and collections. */
export interface ZoteroItemMaterial {
  readonly candidate: ScientSourceCandidate;
  readonly note: string | null;
  readonly citationKey: string | null;
  readonly collectionKeys: ReadonlyArray<string>;
  readonly pdfs: ReadonlyArray<ZoteroRawItem>;
  /** What Zotero holds for the item that this does not bring. */
  readonly notBrought: ReadonlyArray<ScientSourceNotBrought>;
}

export function zoteroItemMaterial(
  item: ZoteroRawItem,
  children: ReadonlyArray<ZoteroRawItem>,
  citationKey: string | null = zoteroCitationKey(item.data),
): ZoteroItemMaterial {
  const pdfs = zoteroPdfAttachments(children);
  const primaryPdf = pdfs[0];
  return {
    candidate: {
      ...zoteroItemToCandidate(item),
      ...(citationKey ? { citationKey } : {}),
      pdfAvailable: primaryPdf !== undefined,
      pdfFileName: primaryPdf ? text(primaryPdf.data.filename) : null,
      pdfAttachmentCount: pdfs.length,
    },
    note: zoteroNotesText(children),
    citationKey,
    collectionKeys: [...(item.data.collections ?? [])],
    pdfs,
    notBrought: zoteroNotBrought(item, children),
  };
}

export function zoteroItemWithChildrenToCandidate(
  item: ZoteroRawItem,
  children: ReadonlyArray<ZoteroRawItem>,
): ScientSourceCandidate {
  return zoteroItemMaterial(item, children).candidate;
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
