import {
  scientSourceTypeFromZotero,
  type ScientSourceRecord,
  type ScientSourceType,
} from "@scientfactory/scient-sources";

import type { ZoteroRawItem } from "./ZoteroItems.ts";

const ITEM_TYPE_FOR: Readonly<Record<ScientSourceType, string>> = {
  article: "journalArticle",
  preprint: "preprint",
  book: "book",
  "book-chapter": "bookSection",
  "conference-paper": "conferencePaper",
  thesis: "thesis",
  report: "report",
  dataset: "dataset",
  web: "webpage",
  other: "document",
};

const COMMON_FIELDS = ["title", "abstractNote", "date", "language", "url", "extra"];

/** Fields Scient fills when it creates an item of each type; Zotero rejects any other. */
const CREATE_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  journalArticle: [...COMMON_FIELDS, "publicationTitle", "volume", "issue", "pages", "DOI", "ISSN"],
  preprint: [...COMMON_FIELDS, "repository", "DOI"],
  book: [...COMMON_FIELDS, "publisher", "volume", "ISBN"],
  bookSection: [...COMMON_FIELDS, "bookTitle", "publisher", "volume", "pages", "ISBN"],
  conferencePaper: [
    ...COMMON_FIELDS,
    "proceedingsTitle",
    "publisher",
    "volume",
    "pages",
    "DOI",
    "ISBN",
  ],
  thesis: [...COMMON_FIELDS, "university"],
  report: [...COMMON_FIELDS, "institution", "pages"],
  dataset: [...COMMON_FIELDS, "repository", "DOI"],
  webpage: [...COMMON_FIELDS, "websiteTitle"],
  document: [...COMMON_FIELDS, "publisher"],
};

const CONTAINER_FIELDS = [
  "publicationTitle",
  "bookTitle",
  "proceedingsTitle",
  "websiteTitle",
  "blogTitle",
  "forumTitle",
  "encyclopediaTitle",
  "dictionaryTitle",
];
const PUBLISHER_FIELDS = ["publisher", "university", "institution", "repository"];
const CREATE_CREATOR_TYPES = new Set(["author", "editor", "contributor", "translator"]);
const MANAGED_EXTRA = /^\s*(pmid|pmcid|arxiv|doi|citation key)\s*:/iu;

/** The item type to write: Zotero's own when it still means the same Scient type. */
export function zoteroItemTypeFor(record: ScientSourceRecord, existing?: string): string {
  if (existing && scientSourceTypeFromZotero(existing) === record.type) {
    if (record.type !== "other" || !record.customType || record.customType === existing) {
      return existing;
    }
  }
  if (record.type === "other" && record.customType && CREATE_FIELDS[record.customType]) {
    return record.customType;
  }
  return ITEM_TYPE_FOR[record.type];
}

export function zoteroCreateFields(itemType: string): ReadonlySet<string> {
  return new Set(CREATE_FIELDS[itemType] ?? CREATE_FIELDS.document);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Source notes as Zotero note HTML: paragraphs, with Markdown bold and italic kept. */
export function zoteroNoteHtml(note: string): string {
  return note
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map(
      (paragraph) =>
        `<p>${escapeHtml(paragraph)
          .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
          .replace(/\*([^*]+)\*/gu, "<em>$1</em>")
          .replaceAll("\n", "<br>")}</p>`,
    )
    .join("");
}

function identifier(record: ScientSourceRecord, scheme: string): string | null {
  return (
    record.identifiers.find((entry) => entry.scheme.trim().toLowerCase() === scheme)?.value ?? null
  );
}

function extraLines(
  record: ScientSourceRecord,
  fields: ReadonlySet<string>,
  existing: string | undefined,
): string {
  const values: ReadonlyArray<readonly [key: string, label: string, value: string | null]> = [
    ["citation key", "Citation Key", record.citationKey ?? null],
    ["doi", "DOI", identifier(record, "doi")],
    ["pmid", "PMID", identifier(record, "pmid")],
    ["pmcid", "PMCID", identifier(record, "pmcid")],
    ["arxiv", "arXiv", identifier(record, "arxiv")],
  ];
  const supplied = new Set(values.filter(([, , value]) => value).map(([key]) => key));
  // A managed line Scient has no value for stays, so sending never deletes Zotero's identifier.
  const kept = (existing ?? "")
    .split(/\r?\n/u)
    .filter(
      (line) => line.trim() && !supplied.has(MANAGED_EXTRA.exec(line)?.[1]?.toLowerCase() ?? ""),
    );
  const managed = values
    .filter(([key, , value]) => value && !(key === "doi" && fields.has("DOI")))
    .map(([, label, value]) => `${label}: ${value}`);
  return [...managed, ...kept].join("\n");
}
/**
 * The record as Zotero item fields, limited to `fields`. Empty values are left out, so
 * sending never clears something Zotero has.
 */
export function zoteroDataFromRecord(input: {
  readonly record: ScientSourceRecord;
  readonly itemType: string;
  readonly fields: ReadonlySet<string>;
  readonly existingExtra?: string;
  readonly creating: boolean;
}): Record<string, unknown> {
  const { record, fields } = input;
  const data: Record<string, unknown> = {};
  const set = (field: string, value: string | null) => {
    if (fields.has(field) && value?.trim()) data[field] = value.trim();
  };
  set("title", record.title);
  set("abstractNote", record.abstract);
  set("date", record.issuedRaw ?? (record.issuedYear === null ? null : String(record.issuedYear)));
  set("language", record.language);
  set("url", record.url);
  set("volume", record.volume);
  set("issue", record.issue);
  set("pages", record.pages);
  const container = CONTAINER_FIELDS.find((field) => fields.has(field));
  if (container) set(container, record.containerTitle);
  const publisher = PUBLISHER_FIELDS.find((field) => fields.has(field));
  if (publisher) set(publisher, record.publisher);
  set("DOI", identifier(record, "doi"));
  set("ISBN", identifier(record, "isbn"));
  set("ISSN", identifier(record, "issn"));
  if (fields.has("extra")) {
    const extra = extraLines(record, fields, input.existingExtra);
    if (extra) data.extra = extra;
  }
  if (record.creators.length > 0) {
    data.creators = record.creators.map((creator) => {
      const creatorType =
        !input.creating || CREATE_CREATOR_TYPES.has(creator.creatorType)
          ? creator.creatorType
          : "author";
      return creator.literalName && !creator.familyName
        ? { creatorType, name: creator.literalName }
        : {
            creatorType,
            firstName: creator.givenName ?? "",
            lastName: creator.familyName ?? creator.literalName ?? "",
          };
    });
  }
  if (record.tags.length > 0) data.tags = record.tags.map((tag) => ({ tag }));
  return data;
}

function comparable(field: string, value: unknown): unknown {
  if (field === "tags" && Array.isArray(value)) {
    return value.map((tag: { readonly tag?: unknown }) => String(tag.tag ?? "")).toSorted();
  }
  if (field === "creators" && Array.isArray(value)) {
    return value.map((creator: Record<string, unknown>) =>
      typeof creator.name === "string" && creator.name
        ? [creator.creatorType, creator.name]
        : [creator.creatorType, creator.firstName ?? "", creator.lastName ?? ""],
    );
  }
  return typeof value === "string" ? value.trim() : value;
}

/** Only the fields whose value differs from the item as Zotero has it now. */
export function zoteroPatchFor(input: {
  readonly record: ScientSourceRecord;
  readonly current: ZoteroRawItem;
}): Record<string, unknown> {
  const raw = input.current.data as Readonly<Record<string, unknown>>;
  const fields = new Set(Object.keys(raw));
  const itemType = zoteroItemTypeFor(input.record, input.current.data.itemType);
  const data = zoteroDataFromRecord({
    record: input.record,
    itemType,
    fields,
    ...(input.current.data.extra ? { existingExtra: input.current.data.extra } : {}),
    creating: false,
  });
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(data)) {
    if (
      JSON.stringify(comparable(field, value)) !== JSON.stringify(comparable(field, raw[field]))
    ) {
      patch[field] = value;
    }
  }
  return patch;
}
