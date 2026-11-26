import {
  scientSourceTypeFromZotero,
  ZOTERO_BASE_FIELD,
  ZOTERO_FIELD_TARGET,
  ZOTERO_TYPE_CSL,
  type ScientSourceRecord,
  type ScientSourceType,
} from "@scientfactory/scient-sources";

import {
  PLACE_IS_EVENT,
  zoteroExtraCreator,
  zoteroExtraLineTarget,
  zoteroExtraLines,
  type ZoteroRawItem,
} from "./ZoteroItems.ts";

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
  software: "computerProgram",
  presentation: "presentation",
  manuscript: "manuscript",
  other: "document",
};

const COMMON_FIELDS = ["title", "abstractNote", "date", "language", "url", "extra"];

/**
 * Fields Scient fills when it creates an item of each type and Zotero could not be asked
 * which fields the type has; Zotero rejects any other.
 */
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
  computerProgram: [...COMMON_FIELDS, "company"],
  presentation: [...COMMON_FIELDS],
  manuscript: [...COMMON_FIELDS],
  document: [...COMMON_FIELDS, "publisher"],
};

const CREATE_CREATOR_TYPES = new Set(["author", "editor", "contributor", "translator"]);
const MANAGED_EXTRA = /^\s*(pmid|pmcid|arxiv|doi|citation key)\s*:/iu;

/** What Zotero says an item type accepts: its fields, and its creator roles, primary first. */
export interface ZoteroItemTemplate {
  readonly fields: ReadonlySet<string>;
  readonly roles: ReadonlyArray<string>;
}

/** The item type to write: Zotero's own when it still means the same Scient type. */
export function zoteroItemTypeFor(record: ScientSourceRecord, existing?: string): string {
  if (existing && scientSourceTypeFromZotero(existing) === record.type) {
    if (record.type !== "other" || !record.customType || record.customType === existing) {
      return existing;
    }
  }
  // A Zotero type name kept from an import is written back as that type.
  if (record.type === "other" && record.customType && record.customType in ZOTERO_TYPE_CSL) {
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

/** The item's own field for a general Zotero field: itself, or the type's name for it. */
function fieldFor(fields: ReadonlySet<string>, general: string): string | undefined {
  if (fields.has(general)) return general;
  return [...fields].find((field) => ZOTERO_BASE_FIELD[field] === general);
}

/**
 * The record as Zotero item fields, limited to `fields`. Empty values are left out, so
 * sending never clears something Zotero has. A further detail goes to the field the item's
 * type has for it; one the type has no field for goes to Extra as `variable: value`, which
 * Zotero reads as that field. Nothing the record holds is left behind.
 */
export function zoteroDataFromRecord(input: {
  readonly record: ScientSourceRecord;
  readonly itemType: string;
  readonly fields: ReadonlySet<string>;
  /** The creator roles the type accepts, primary first; absent when Zotero was not asked. */
  readonly roles?: ReadonlyArray<string>;
  readonly existingExtra?: string;
  readonly creating: boolean;
}): Record<string, unknown> {
  const { record, fields } = input;
  const data: Record<string, unknown> = {};
  const set = (general: string, value: string | null | undefined): boolean => {
    const field = fieldFor(fields, general);
    if (!field || !value?.trim() || data[field] !== undefined) return false;
    data[field] = value.trim();
    return true;
  };
  set("title", record.title);
  set("abstractNote", record.abstract);
  set("date", record.issuedRaw ?? (record.issuedYear === null ? null : String(record.issuedYear)));
  set("language", record.language);
  set("url", record.url);
  set("volume", record.volume);
  set("issue", record.issue);
  set("pages", record.pages);
  // A journal, a book, a court reporter or a legal code: whichever the type has.
  for (const container of ["publicationTitle", "reporter", "code"]) {
    if (set(container, record.containerTitle)) break;
  }
  set("publisher", record.publisher);
  set("DOI", identifier(record, "doi"));
  set("ISBN", identifier(record, "isbn"));
  set("ISSN", identifier(record, "issn"));
  set("PMID", identifier(record, "pmid"));
  set("PMCID", identifier(record, "pmcid"));

  // The further details: to the type's field for each, else a line of Extra.
  const extraFromMore: string[] = [];
  const written = new Set<string>();
  for (const [name, value] of Object.entries(record.more ?? {})) {
    if (name === "extra") continue;
    written.add(name);
    // A talk's or a recording's place is its event's place in Zotero too.
    const placed =
      (name === "event-place" && PLACE_IS_EVENT.has(input.itemType) && set("place", value)) ||
      Object.entries(ZOTERO_FIELD_TARGET).some(
        ([general, target]) => "more" in target && target.more === name && set(general, value),
      );
    if (!placed) extraFromMore.push(`${name}: ${value}`);
  }
  // Lines kept as written: one that names a field this type has goes back to that field.
  for (const { line, name, value } of zoteroExtraLines(record.more?.extra)) {
    const field =
      name === undefined
        ? undefined
        : [...fields].find((entry) => entry.toLowerCase() === name.replace(/[\s_-]+/gu, ""));
    if (field && field !== "extra" && data[field] === undefined && value) data[field] = value;
    else extraFromMore.push(line);
  }

  if (fields.has("extra")) {
    const values: ReadonlyArray<readonly [key: string, label: string, value: string | null]> = [
      ["citation key", "Citation Key", record.citationKey ?? null],
      ["doi", "DOI", identifier(record, "doi")],
      ["pmid", "PMID", identifier(record, "pmid")],
      ["pmcid", "PMCID", identifier(record, "pmcid")],
      ["arxiv", "arXiv", identifier(record, "arxiv")],
    ];
    const supplied = new Set(values.filter(([, , value]) => value).map(([key]) => key));
    const managed = values
      .filter(
        ([key, , value]) =>
          value &&
          !(key === "doi" && data.DOI !== undefined) &&
          !(key === "pmid" && data.PMID !== undefined) &&
          !(key === "pmcid" && data.PMCID !== undefined),
      )
      .map(([, label, value]) => `${label}: ${value}`);
    const ours = [...managed, ...extraFromMore];
    const said = new Set(ours);
    // A line of Zotero's that Scient has no value for stays, so sending never deletes it; one
    // that names a detail written above (to its field or as a line) is replaced by it.
    const sent = new Set(record.creators.map(creatorIdentity));
    const kept = zoteroExtraLines(input.existingExtra).flatMap(({ line, name, value }) => {
      if (said.has(line)) return [];
      // A creator the import read from this line is sent as a creator: not kept twice.
      const creator = name && value ? zoteroExtraCreator(name, value) : undefined;
      if (creator && sent.has(creatorIdentity(creator))) return [];
      if (supplied.has(MANAGED_EXTRA.exec(line)?.[1]?.toLowerCase() ?? "")) return [];
      const target = zoteroExtraLineTarget(name ?? "");
      return target && "more" in target && written.has(target.more) ? [] : [line];
    });
    const extra = [...ours, ...kept].join("\n");
    if (extra) data.extra = extra;
  }
  if (record.creators.length > 0) {
    const { roles } = input;
    data.creators = record.creators.map((creator) => {
      // A role the type does not have becomes its primary one; Zotero refuses any other.
      const creatorType = !input.creating
        ? creator.creatorType
        : roles
          ? roles.includes(creator.creatorType)
            ? creator.creatorType
            : (roles[0] ?? "author")
          : CREATE_CREATOR_TYPES.has(creator.creatorType)
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

/** One creator in one role, however the name's case and the role's spelling were written. */
const creatorIdentity = (creator: {
  readonly creatorType: string;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly literalName: string | null;
}) =>
  [creator.creatorType, creator.familyName, creator.givenName, creator.literalName]
    .map((part) => (part ?? "").trim().toLowerCase())
    .join("\0");

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
  // Every field the item's type has, as Zotero sent the item: also the ones Scient's own
  // reading of the item leaves out.
  const fields = new Set(input.current.fieldNames ?? Object.keys(raw));
  const itemType = zoteroItemTypeFor(input.record, input.current.data.itemType);
  const data = zoteroDataFromRecord({
    record: input.record,
    itemType,
    fields,
    ...(input.current.data.extra ? { existingExtra: input.current.data.extra } : {}),
    creating: false,
  });
  // What Zotero has now: a field Scient's own reading of the item leaves out is in `fields`,
  // so a detail that has not changed is not sent again.
  const zoteroHas = (field: string) => raw[field] ?? input.current.fields?.[field];
  // A list Scient knows is short ("et al.") never replaces a longer one Zotero holds.
  const zoteroCreators = zoteroHas("creators");
  const keepCreators =
    (input.record.incompleteCreatorRoles?.length ?? 0) > 0 &&
    Array.isArray(zoteroCreators) &&
    zoteroCreators.length > input.record.creators.length;
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(data)) {
    if (field === "creators" && keepCreators) continue;
    if (
      JSON.stringify(comparable(field, value)) !==
      JSON.stringify(comparable(field, zoteroHas(field)))
    ) {
      patch[field] = value;
    }
  }
  return patch;
}
