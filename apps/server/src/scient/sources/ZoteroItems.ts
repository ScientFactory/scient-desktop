import {
  normalizeScientSourceAbstractDocument,
  scientSourceTypeFromZotero,
  type ScientSourceCandidate,
  type ScientSourceCreator,
  type ScientSourceFieldProvenance,
  type ScientSourceIdentifier,
  type ZoteroCollection,
} from "@scientfactory/scient-sources";
import * as Schema from "effect/Schema";

export const ZOTERO_ITEM_KEY_PATTERN = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/u;
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
  tags: Schema.optionalKey(Schema.Array(Schema.Struct({ tag: Schema.String }))),
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
});
export type ZoteroRawItem = typeof ZoteroRawItem.Type;

export const decodeZoteroRawItem = Schema.decodeUnknownSync(ZoteroRawItem);
export const decodeZoteroRawItems = Schema.decodeUnknownSync(Schema.Array(ZoteroRawItem));

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
  "citation key": "citationKey",
  pmid: "pmid",
  pmcid: "pmcid",
  arxiv: "arxiv",
  doi: "doi",
};

/**
 * Zotero keeps fields its schema lacks as `Name: value` lines in Extra. Better BibTeX
 * pins citation keys there too, and PubMed imports put PMIDs there.
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
  return text(data.citationKey) ?? text(zoteroExtraFields(data.extra).citationKey);
}

function identifierEntries(
  data: ZoteroRawItem["data"],
): ReadonlyArray<readonly [scheme: string, value: string | null, sourceField: string]> {
  const extra = zoteroExtraFields(data.extra);
  return [
    ["doi", text(data.DOI) ?? text(extra.doi), text(data.DOI) ? "DOI" : "extra"],
    ["isbn", text(data.ISBN), "ISBN"],
    ["issn", text(data.ISSN), "ISSN"],
    ["pmid", text(data.PMID) ?? text(extra.pmid), text(data.PMID) ? "PMID" : "extra"],
    ["pmcid", text(extra.pmcid), "extra"],
    ["arxiv", text(extra.arxiv), "extra"],
  ];
}

function identifiers(data: ZoteroRawItem["data"]): ReadonlyArray<ScientSourceIdentifier> {
  return identifierEntries(data).flatMap(([scheme, value]) => (value ? [{ scheme, value }] : []));
}

const CONTAINER_FIELDS = [
  "publicationTitle",
  "bookTitle",
  "proceedingsTitle",
  "websiteTitle",
  "blogTitle",
  "forumTitle",
  "encyclopediaTitle",
  "dictionaryTitle",
] as const;
const PUBLISHER_FIELDS = ["publisher", "university", "institution", "repository"] as const;

function firstField<K extends keyof ZoteroRawItem["data"]>(
  data: ZoteroRawItem["data"],
  fields: ReadonlyArray<K>,
): { readonly field: K; readonly value: string } | null {
  for (const field of fields) {
    const value = data[field];
    const normalized = typeof value === "string" ? text(value) : null;
    if (normalized) return { field, value: normalized };
  }
  return null;
}

function provenance(data: ZoteroRawItem["data"]): ReadonlyArray<ScientSourceFieldProvenance> {
  const container = firstField(data, CONTAINER_FIELDS);
  const publisher = firstField(data, PUBLISHER_FIELDS);
  const fields: ReadonlyArray<readonly [string, string, boolean]> = [
    ["title", "title", text(data.title) !== null],
    ["creators", "creators", (data.creators ?? []).length > 0],
    ["issuedRaw", "date", text(data.date) !== null],
    ["abstract", "abstractNote", text(data.abstractNote) !== null],
    ["volume", "volume", text(data.volume) !== null],
    ["issue", "issue", text(data.issue) !== null],
    ["pages", "pages", text(data.pages) !== null],
    ["language", "language", text(data.language) !== null],
    ["url", "url", text(data.url) !== null],
    ["tags", "tags", (data.tags ?? []).some((tag) => tag.tag.trim().length > 0)],
  ];
  return [
    ...fields
      .filter(([, , present]) => present)
      .map(([field, sourceField]) => ({ field, origin: "zotero" as const, sourceField })),
    ...identifierEntries(data).flatMap(([scheme, value, sourceField]) =>
      value ? [{ field: `identifiers.${scheme}`, origin: "zotero" as const, sourceField }] : [],
    ),
    ...(container
      ? [{ field: "containerTitle", origin: "zotero" as const, sourceField: container.field }]
      : []),
    ...(publisher
      ? [{ field: "publisher", origin: "zotero" as const, sourceField: publisher.field }]
      : []),
  ];
}

export function zoteroItemToCandidate(raw: ZoteroRawItem): ScientSourceCandidate {
  const data = raw.data;
  const type = scientSourceTypeFromZotero(data.itemType);
  const abstract = normalizeScientSourceAbstractDocument(data.abstractNote);
  return {
    sourceKey: raw.key,
    type,
    // Preserve Zotero's exact genre when it is outside Scient's deliberately
    // small canonical type set. Otherwise editing an imported record would
    // present an unexplained, invalid "Other source" with its type discarded.
    customType: type === "other" ? text(data.itemType) : null,
    title: text(data.title),
    creators: (data.creators ?? []).flatMap((value) => {
      const normalized = creator(value);
      return normalized ? [normalized] : [];
    }),
    issuedRaw: text(data.date),
    issuedYear: publicationYear(data.date),
    identifiers: identifiers(data),
    abstract: abstract?.text ?? null,
    ...(abstract ? { abstractSections: [...abstract.sections] } : {}),
    containerTitle: firstField(data, CONTAINER_FIELDS)?.value ?? null,
    publisher: firstField(data, PUBLISHER_FIELDS)?.value ?? null,
    volume: text(data.volume),
    issue: text(data.issue),
    pages: text(data.pages),
    language: text(data.language),
    url: text(data.url),
    tags: (data.tags ?? []).map((tag) => tag.tag.trim()).filter(Boolean),
    externalReferences: [
      {
        system: "zotero",
        libraryId: String(raw.library.id),
        itemKey: raw.key,
        itemVersion: raw.version,
        rawItemType: data.itemType,
      },
    ],
    fieldProvenance: provenance(data),
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

/** Everything one Zotero item brings: its metadata, notes, PDFs, citation key and collections. */
export interface ZoteroItemMaterial {
  readonly candidate: ScientSourceCandidate;
  readonly note: string | null;
  readonly citationKey: string | null;
  readonly collectionKeys: ReadonlyArray<string>;
  readonly pdfs: ReadonlyArray<ZoteroRawItem>;
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
      pdfAvailable: primaryPdf !== undefined,
      pdfFileName: primaryPdf ? text(primaryPdf.data.filename) : null,
      pdfAttachmentCount: pdfs.length,
    },
    note: zoteroNotesText(children),
    citationKey,
    collectionKeys: [...(item.data.collections ?? [])],
    pdfs,
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
