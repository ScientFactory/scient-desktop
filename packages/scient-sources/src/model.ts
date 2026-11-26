import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ScientSourceCategorySummary } from "./categories.ts";
import { isValidScientSourceMore } from "./sourceMore.ts";

// Agents reading tool schemas gain nothing from the trimmed-string regex; decoding still enforces it.
const NonEmptyString = Schema.String.check(
  Schema.isTrimmed({ toJsonSchema: () => [{}, true] }),
  Schema.isNonEmpty(),
);
const NullableText = Schema.NullOr(Schema.String);

export const ScientSourceType = Schema.Literals([
  "article",
  "preprint",
  "book",
  "book-chapter",
  "conference-paper",
  "thesis",
  "report",
  "dataset",
  "web",
  "software",
  "presentation",
  "manuscript",
  "other",
]);
export type ScientSourceType = typeof ScientSourceType.Type;

/**
 * Bibliographic details beyond a source's own fields, each under the CSL variable it is cited
 * with (`sourceMore.ts` has the names). Text only; a date is kept as written and parsed when
 * a citation is made.
 */
export const ScientSourceMore = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter((more) => isValidScientSourceMore(more)),
);
export type ScientSourceMore = typeof ScientSourceMore.Type;

export const ScientSourceCreator = Schema.Struct({
  creatorType: NonEmptyString,
  givenName: NullableText,
  familyName: NullableText,
  literalName: NullableText,
});
export type ScientSourceCreator = typeof ScientSourceCreator.Type;

export const ScientSourceIdentifier = Schema.Struct({
  scheme: NonEmptyString,
  value: NonEmptyString,
});
export type ScientSourceIdentifier = typeof ScientSourceIdentifier.Type;

// Above the largest consortium author lists; a record file's 2 MiB limit is the nearer bound.
const BoundedCreators = Schema.Array(ScientSourceCreator).pipe(
  Schema.check(Schema.isMaxLength(20_000)),
);
const BoundedIdentifiers = Schema.Array(ScientSourceIdentifier).pipe(
  Schema.check(Schema.isMaxLength(256)),
);
const BoundedTags = Schema.Array(Schema.String).pipe(Schema.check(Schema.isMaxLength(1_000)));

/**
 * Creator roles whose list stops short of the work's real list (BibTeX's `and others`): the
 * names given are the first ones, and a citation ends that role's names with "et al.".
 */
export const ScientSourceIncompleteCreatorRoles = Schema.Array(NonEmptyString).pipe(
  Schema.check(Schema.isMaxLength(16)),
);

/** Whether `role` is listed incomplete; roles compare as creator types do, without case. */
export function scientCreatorRoleIncomplete(
  roles: ReadonlyArray<string> | undefined,
  role: string,
): boolean {
  const wanted = role.toLowerCase();
  return roles?.some((entry) => entry.toLowerCase() === wanted) ?? false;
}

/** How many creators, identifiers or tags a pin's or review's saved copy keeps. */
const SCIENT_SAVED_COPY_LIST_LIMIT = 256;

/** A saved copy's whole creator count, present only when its `creators` hold the first ones. */
export const ScientSavedCopyCreatorCount = Schema.Int.check(Schema.isGreaterThan(0));

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A saved copy as written: lists past 256 go in `overflow`, which older Scient versions skip while
 * they read the first 256. A role cut there is marked incomplete for them, and `overflow` names it
 * (`markedRoles`) so this version unmarks it. Pass `markRoles` false for a review entry.
 */
export function scientSavedCopyHead(
  work: {
    readonly creators: ReadonlyArray<ScientSourceCreator>;
    readonly incompleteCreatorRoles?: ReadonlyArray<string>;
    readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
    readonly tags?: ReadonlyArray<string>;
  },
  markRoles = true,
): {
  readonly creators: ReadonlyArray<ScientSourceCreator>;
  readonly incompleteCreatorRoles?: ReadonlyArray<string>;
  readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
  readonly tags?: ReadonlyArray<string>;
  readonly overflow?: JsonRecord;
} {
  const limit = SCIENT_SAVED_COPY_LIST_LIMIT;
  const overflow: JsonRecord = {};
  const cut = <T>(name: string, list: ReadonlyArray<T>) => {
    if (list.length > limit) overflow[name] = list.slice(limit);
    return list.slice(0, limit);
  };
  const creators = cut("creators", work.creators);
  const identifiers = cut("identifiers", work.identifiers);
  const tags = work.tags === undefined ? undefined : cut("tags", work.tags);
  const marked: string[] = [];
  for (const { creatorType } of markRoles ? work.creators.slice(limit) : []) {
    if (
      !scientCreatorRoleIncomplete(work.incompleteCreatorRoles, creatorType) &&
      !scientCreatorRoleIncomplete(marked, creatorType)
    ) {
      marked.push(creatorType);
    }
  }
  if (marked.length > 0) overflow["markedRoles"] = marked;
  const roles = withIncompleteCreatorRoles(work.incompleteCreatorRoles, marked);
  return {
    creators,
    ...(roles?.length ? { incompleteCreatorRoles: roles } : {}),
    identifiers,
    ...(tags !== undefined ? { tags } : {}),
    ...(Object.keys(overflow).length > 0 ? { overflow } : {}),
  };
}

/** A written saved copy with its `overflow` joined back on; a stale one is dropped. */
export function joinScientSavedCopy(raw: unknown): unknown {
  if (!isRecord(raw) || !("overflow" in raw)) return raw;
  const { overflow, ...work } = raw;
  if (!isRecord(overflow)) return work;
  // Only a list still holding exactly the first 256 continues in `overflow`.
  const joined = (name: string) => {
    const head = work[name];
    const rest = overflow[name];
    if (
      !Array.isArray(rest) ||
      !Array.isArray(head) ||
      head.length !== SCIENT_SAVED_COPY_LIST_LIMIT
    )
      return false;
    work[name] = [...head, ...rest];
    return true;
  };
  const creators = joined("creators");
  joined("identifiers");
  joined("tags");
  const marked = overflow["markedRoles"];
  const roles = work["incompleteCreatorRoles"];
  if (creators && Array.isArray(marked) && Array.isArray(roles)) {
    const kept = roles.filter(
      (role) =>
        typeof role !== "string" ||
        !marked.some(
          (entry) => typeof entry === "string" && scientCreatorRoleIncomplete([entry], role),
        ),
    );
    if (kept.length > 0) work["incompleteCreatorRoles"] = kept;
    else delete work["incompleteCreatorRoles"];
  }
  return work;
}

/** A saved copy as stored, without a `creatorCount` it cannot use: one bad count never hides it. */
export function withUsableCreatorCount(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || !("creatorCount" in raw)) return raw;
  const { creatorCount, ...rest } = raw as Record<string, unknown>;
  const listed = Array.isArray(rest["creators"]) ? rest["creators"].length : 0;
  return Number.isSafeInteger(creatorCount) && (creatorCount as number) > listed ? raw : rest;
}

/** A saved copy's creators, with what it knows of the whole list. */
export interface ScientSavedRoster {
  readonly creators: ReadonlyArray<ScientSourceCreator>;
  readonly creatorCount?: number;
  readonly incompleteCreatorRoles?: ReadonlyArray<string>;
}

const sameCreator = (left: ScientSourceCreator, right: ScientSourceCreator) =>
  left.creatorType === right.creatorType &&
  left.givenName === right.givenName &&
  left.familyName === right.familyName &&
  left.literalName === right.literalName;

/**
 * The copy's own roster when rebuilding it from `record` would drop names only the copy holds:
 * the record's list is the copy's own (filled from it), or a shortened record's list is how the
 * copy's begins. Otherwise null: the record's list is the one to keep.
 */
export function scientFullerSavedRoster(
  record: Pick<ScientSourceRecord, "creators" | "incompleteCreatorRoles">,
  copy: ScientSavedRoster | null,
): ScientSavedRoster | null {
  if (!copy) return null;
  if (record.creators === copy.creators) return copy;
  const names = record.creators;
  return names.length <= copy.creators.length &&
    knownLength(copy) > names.length &&
    stillShortOf(record, copy)
    ? copy
    : null;
}

const knownLength = (copy: ScientSavedRoster) =>
  Math.max(copy.creators.length, copy.creatorCount ?? 0);

/** The record marks its list short and begins as the copy does: both are cuts of one list. */
const stillShortOf = (
  record: Pick<ScientSourceRecord, "creators" | "incompleteCreatorRoles">,
  copy: ScientSavedRoster,
) => {
  const shared = Math.min(record.creators.length, copy.creators.length);
  return (
    (record.incompleteCreatorRoles?.length ?? 0) > 0 &&
    shared > 0 &&
    record.creators
      .slice(0, shared)
      .every((creator, index) => sameCreator(creator, copy.creators[index]!))
  );
};

/**
 * The roster a saved copy keeps when rebuilt from `record`: the record's first 256 names, the
 * whole count when there were more, and the cut roles marked incomplete (citations end them with
 * "et al."); or the copy's own, as `scientFullerSavedRoster` decides.
 */
export function scientSavedCopyRoster(
  record: Pick<ScientSourceRecord, "creators" | "incompleteCreatorRoles">,
  copy: ScientSavedRoster | null,
): ScientSavedRoster {
  const fuller = scientFullerSavedRoster(record, copy);
  const limit = SCIENT_SAVED_COPY_LIST_LIMIT;
  const kept = fuller?.creators ?? record.creators.slice(0, limit);
  // A short record listing more names than the cut copy still lacks the copy's known total.
  const whole = fuller
    ? knownLength(fuller)
    : copy && stillShortOf(record, copy)
      ? Math.max(record.creators.length, knownLength(copy))
      : record.creators.length;
  const shortenedRoles: string[] = [];
  for (const { creatorType } of fuller ? [] : record.creators.slice(limit)) {
    if (!scientCreatorRoleIncomplete(shortenedRoles, creatorType)) shortenedRoles.push(creatorType);
  }
  const incompleteCreatorRoles = withIncompleteCreatorRoles(
    fuller ? fuller.incompleteCreatorRoles : record.incompleteCreatorRoles,
    shortenedRoles,
  );
  return {
    creators: kept,
    ...(whole > kept.length ? { creatorCount: whole } : {}),
    ...(incompleteCreatorRoles?.length ? { incompleteCreatorRoles } : {}),
  };
}

/** A record's list for a saved copy: the first 256, unless it is the copy's own list. */
export function scientSavedCopyList<T>(
  list: ReadonlyArray<T>,
  copyList: ReadonlyArray<T> | undefined,
): ReadonlyArray<T> {
  return list === copyList ? list : list.slice(0, SCIENT_SAVED_COPY_LIST_LIMIT);
}

/** `roles` with `added` the list lacks, within the 16 a record keeps. */
function withIncompleteCreatorRoles(
  roles: ReadonlyArray<string> | undefined,
  added: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined {
  const fresh = added.filter((role) => !scientCreatorRoleIncomplete(roles, role));
  return fresh.length === 0 ? roles : [...(roles ?? []), ...fresh].slice(0, 16);
}

export const ScientSourceAbstractSection = Schema.Struct({
  title: NullableText,
  paragraphs: Schema.Array(NonEmptyString).pipe(Schema.check(Schema.isMaxLength(256))),
});
export type ScientSourceAbstractSection = typeof ScientSourceAbstractSection.Type;
const BoundedAbstractSections = Schema.Array(ScientSourceAbstractSection).pipe(
  Schema.check(Schema.isMaxLength(256)),
);
export const ScientSourceNote = Schema.NullOr(
  Schema.String.pipe(Schema.check(Schema.isMaxLength(100_000))),
);
export type ScientSourceNote = typeof ScientSourceNote.Type;

export const ScientSourceExternalReference = Schema.Struct({
  system: NonEmptyString,
  libraryId: NonEmptyString,
  itemKey: NonEmptyString,
  itemVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  rawItemType: NonEmptyString,
  /** The legacy Zotero baseline verified when this concrete owner link was published. */
  zoteroLegacyBaselineSha256: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  ),
});
export type ScientSourceExternalReference = typeof ScientSourceExternalReference.Type;

export const ScientSourceOrigin = Schema.Struct({
  actor: Schema.Literals(["user", "agent"]),
  intake: Schema.Literals(["zotero", "local-pdf", "identifier", "paper", "file", "web"]),
  operationId: NonEmptyString,
  // Older records may still say "pending"; nothing gates on it any more.
  review: Schema.Literals(["none", "pending"]),
});
export type ScientSourceOrigin = typeof ScientSourceOrigin.Type;

export const ScientSourceActor = Schema.Literals(["user", "agent"]);
export type ScientSourceActor = typeof ScientSourceActor.Type;

/** Whether a source's identifier was confirmed against its registry. */
export const ScientSourceVerification = Schema.Struct({
  state: Schema.Literals(["verified", "unchecked", "unverified"]),
  identifier: Schema.optionalKey(ScientSourceIdentifier),
  checkedAt: Schema.optionalKey(NonEmptyString),
  /** Why a checked identifier stays unverified: the registry has no such work, or another one. */
  problem: Schema.optionalKey(Schema.Literals(["not-found", "mismatch"])),
  /** Brought from another computer's check (a project package) at this time; not checked here. */
  carriedAt: Schema.optionalKey(NonEmptyString),
});
export type ScientSourceVerification = typeof ScientSourceVerification.Type;

export const ScientSourceEditorialNotice = Schema.Struct({
  kind: Schema.Literals(["retraction", "withdrawal", "expression-of-concern", "correction"]),
  /** The notice's own DOI, when the registry gives one. */
  doi: Schema.optionalKey(NonEmptyString),
  date: Schema.optionalKey(NonEmptyString),
  /** Who reported it, as the registry names them, for example "retraction-watch" or "publisher". */
  source: Schema.optionalKey(NonEmptyString),
});
export type ScientSourceEditorialNotice = typeof ScientSourceEditorialNotice.Type;

/**
 * Retractions, withdrawals, expressions of concern and corrections the registry reported when the
 * identifier was last checked. `none` means it reported none; absence means never checked.
 */
export const ScientSourceEditorialStatus = Schema.Struct({
  state: Schema.Literals(["retracted", "withdrawn", "expression-of-concern", "corrected", "none"]),
  notices: Schema.Array(ScientSourceEditorialNotice).pipe(Schema.check(Schema.isMaxLength(64))),
  checkedAt: NonEmptyString,
  /** Brought from another computer's check (a project package) at this time; not checked here. */
  carriedAt: Schema.optionalKey(NonEmptyString),
});
export type ScientSourceEditorialStatus = typeof ScientSourceEditorialStatus.Type;

export const ScientSourceFieldProvenance = Schema.Struct({
  field: NonEmptyString,
  origin: Schema.Literals([
    "agent",
    "zotero",
    "local-pdf",
    "doi",
    "pubmed",
    "crossref",
    "europe-pmc",
    "derived",
    "user",
    "arxiv",
    "open-library",
    "google-books",
    "openalex",
    "semantic-scholar",
    "file",
    "web-page",
  ]),
  sourceField: NullableText,
  sourceIdentifier: Schema.optionalKey(ScientSourceIdentifier),
  retrievedAt: Schema.optionalKey(NonEmptyString),
});
export type ScientSourceFieldProvenance = typeof ScientSourceFieldProvenance.Type;

/** How a downloaded PDF was reached, and which version of the work it is. */
export const ScientSourceAttachmentRetrieval = Schema.Struct({
  route: Schema.Literals(["open-access", "publisher", "university", "library"]),
  /** "unknown" is a free copy whose repository did not say which version it holds. */
  version: Schema.Literals(["published", "accepted", "preprint", "unknown"]),
});
export type ScientSourceAttachmentRetrieval = typeof ScientSourceAttachmentRetrieval.Type;

export const ScientSourceAttachment = Schema.Struct({
  attachmentId: NonEmptyString,
  kind: Schema.Literal("pdf"),
  fileName: NonEmptyString,
  mediaType: Schema.Literal("application/pdf"),
  sha256: NonEmptyString,
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  relativePath: NonEmptyString,
  importedAt: NonEmptyString,
  retrieval: Schema.optionalKey(ScientSourceAttachmentRetrieval),
});
export type ScientSourceAttachment = typeof ScientSourceAttachment.Type;

export const ScientSourceAttachmentSummary = Schema.Struct({
  attachmentId: ScientSourceAttachment.fields.attachmentId,
  kind: ScientSourceAttachment.fields.kind,
  fileName: ScientSourceAttachment.fields.fileName,
  mediaType: ScientSourceAttachment.fields.mediaType,
});
export type ScientSourceAttachmentSummary = typeof ScientSourceAttachmentSummary.Type;

/** Rules in `citationKeys.ts`; decoding stays lenient so one odd key never hides a record. */
export const ScientSourceCitationKey = NonEmptyString;

/**
 * A source as the stores hand it out. Project stores keep `formatVersion: 1` records, which name
 * their project; the personal library keeps `formatVersion: 2` records, which name none. Files are
 * decoded with the stricter persisted schemas below.
 */
export const ScientSourceRecord = Schema.Struct({
  formatVersion: Schema.Literals([1, 2]),
  sourceId: NonEmptyString,
  projectId: Schema.optionalKey(NonEmptyString),
  /** Stable project origin for hydration or package import, including alternate Library IDs. */
  hydratedFromProjectSourceId: Schema.optionalKey(NonEmptyString),
  /** Citation inputs explicitly known at hydration; edits add knowledge through field provenance. */
  hydratedCitationFields: Schema.optionalKey(
    Schema.Array(NonEmptyString).check(Schema.isMaxLength(64)),
  ),
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Revisions from this one to the record's own changed only its note in one session; not kept. */
  noteOnlySince: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  citationKey: Schema.optionalKey(ScientSourceCitationKey),
  type: ScientSourceType,
  customType: Schema.optionalKey(NullableText),
  title: NullableText,
  creators: Schema.Array(ScientSourceCreator),
  incompleteCreatorRoles: Schema.optionalKey(ScientSourceIncompleteCreatorRoles),
  issuedRaw: NullableText,
  issuedYear: Schema.NullOr(Schema.Int),
  identifiers: Schema.Array(ScientSourceIdentifier),
  abstract: NullableText,
  abstractSections: Schema.optionalKey(BoundedAbstractSections),
  note: Schema.optionalKey(ScientSourceNote),
  containerTitle: NullableText,
  publisher: NullableText,
  volume: NullableText,
  issue: NullableText,
  pages: NullableText,
  language: NullableText,
  url: NullableText,
  more: Schema.optionalKey(ScientSourceMore),
  tags: Schema.Array(Schema.String),
  externalReferences: Schema.Array(ScientSourceExternalReference),
  attachments: Schema.Array(ScientSourceAttachment),
  fieldProvenance: Schema.Array(ScientSourceFieldProvenance),
  origin: Schema.optionalKey(ScientSourceOrigin),
  verification: Schema.optionalKey(ScientSourceVerification),
  editorialStatus: Schema.optionalKey(ScientSourceEditorialStatus),
  importedAt: NonEmptyString,
  updatedAt: Schema.optionalKey(NonEmptyString),
  updatedBy: Schema.optionalKey(ScientSourceActor),
});
export type ScientSourceRecord = typeof ScientSourceRecord.Type;

/** A record file in a project store. */
export const ScientSourceRecordV1 = Schema.Struct({
  ...ScientSourceRecord.fields,
  formatVersion: Schema.Literal(1),
  projectId: NonEmptyString,
});

const { projectId: _projectId, ...libraryRecordFields } = ScientSourceRecord.fields;
/** A record file in the personal library: the same source with no project. */
export const ScientLibraryRecordV2 = Schema.Struct({
  ...libraryRecordFields,
  formatVersion: Schema.Literal(2),
  /** Personal reading state, kept only in the library; records written before it are unread. */
  readingStatus: Schema.Literals(["unread", "read"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("unread" as const)),
  ),
  starred: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});
export type ScientLibraryRecord = typeof ScientLibraryRecordV2.Type;
export type ScientSourceReadingStatus = ScientLibraryRecord["readingStatus"];

export interface ScientSourceReadingState {
  readonly readingStatus: ScientSourceReadingStatus;
  readonly starred: boolean;
}

/** A library record's reading state; null for a project record or a pin's snapshot. */
export function scientSourceReadingState(
  record: ScientSourceRecord,
): ScientSourceReadingState | null {
  if (record.formatVersion !== 2 || !("readingStatus" in record)) return null;
  const library = record as ScientSourceRecord & Partial<ScientSourceReadingState>;
  return {
    readingStatus: library.readingStatus === "read" ? "read" : "unread",
    starred: library.starred === true,
  };
}

/**
 * Bounded list projection. Large abstracts, provenance, and external sync
 * evidence stay behind the per-source detail boundary.
 */
export const ScientSourceSummary = Schema.Struct({
  sourceId: ScientSourceRecord.fields.sourceId,
  revision: ScientSourceRecord.fields.revision,
  citationKey: ScientSourceRecord.fields.citationKey,
  type: ScientSourceRecord.fields.type,
  title: ScientSourceRecord.fields.title,
  creators: ScientSourceRecord.fields.creators,
  issuedYear: ScientSourceRecord.fields.issuedYear,
  identifiers: ScientSourceRecord.fields.identifiers,
  containerTitle: ScientSourceRecord.fields.containerTitle,
  publisher: Schema.optionalKey(ScientSourceRecord.fields.publisher),
  url: ScientSourceRecord.fields.url,
  // Optional so a client can read an older server's list.
  tags: Schema.optional(ScientSourceRecord.fields.tags),
  externalReferences: ScientSourceRecord.fields.externalReferences,
  attachments: Schema.Array(ScientSourceAttachmentSummary),
  importedAt: ScientSourceRecord.fields.importedAt,
  updatedAt: ScientSourceRecord.fields.updatedAt,
  origin: Schema.optional(ScientSourceOrigin),
  verification: Schema.optional(ScientSourceVerification),
  editorialStatus: Schema.optional(ScientSourceEditorialStatus),
  /** Study design and topics from registries; joined from the categories file, not the record. */
  categories: Schema.optional(ScientSourceCategorySummary),
});
export type ScientSourceSummary = typeof ScientSourceSummary.Type;

export function scientSourceSummaryFromRecord(record: ScientSourceRecord): ScientSourceSummary {
  return {
    sourceId: record.sourceId,
    revision: record.revision,
    ...(record.citationKey ? { citationKey: record.citationKey } : {}),
    type: record.type,
    title: record.title,
    creators: record.creators,
    issuedYear: record.issuedYear,
    identifiers: record.identifiers,
    containerTitle: record.containerTitle,
    publisher: record.publisher,
    url: record.url,
    tags: record.tags,
    externalReferences: record.externalReferences,
    attachments: record.attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      kind: attachment.kind,
      fileName: attachment.fileName,
      mediaType: attachment.mediaType,
    })),
    importedAt: record.importedAt,
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    ...(record.origin ? { origin: record.origin } : {}),
    ...(record.verification ? { verification: record.verification } : {}),
    ...(record.editorialStatus ? { editorialStatus: record.editorialStatus } : {}),
  };
}

/** The fields a researcher may correct without changing source identity or files. */
export const ScientSourceEditableMetadata = Schema.Struct({
  /** Omitted means keep the current key. A new value renames the key on purpose. */
  citationKey: Schema.optionalKey(ScientSourceCitationKey),
  type: ScientSourceType,
  customType: Schema.optionalKey(NullableText),
  title: NullableText,
  creators: BoundedCreators,
  /** Omitted means keep the current marks; given, it replaces them (empty clears them). */
  incompleteCreatorRoles: Schema.optionalKey(ScientSourceIncompleteCreatorRoles),
  issuedRaw: NullableText,
  issuedYear: Schema.NullOr(Schema.Int),
  identifiers: BoundedIdentifiers,
  abstract: NullableText,
  containerTitle: NullableText,
  publisher: NullableText,
  volume: NullableText,
  issue: NullableText,
  pages: NullableText,
  language: NullableText,
  url: NullableText,
  tags: BoundedTags,
  /** Omitted means keep the further details as they are; given, it replaces them all. */
  more: Schema.optionalKey(ScientSourceMore),
});
export type ScientSourceEditableMetadata = typeof ScientSourceEditableMetadata.Type;

/**
 * What Zotero held for one source when Scient last read it, kept apart from the record.
 * Refresh compares against it to tell Zotero's changes from local edits.
 */
export const ScientSourceZoteroSync = Schema.Struct({
  formatVersion: Schema.Literal(1),
  sourceId: NonEmptyString,
  libraryId: NonEmptyString,
  /** Stable highlight namespace when a verified local "0" library gains its owner ID. */
  annotationLibraryId: Schema.optionalKey(NonEmptyString),
  itemKey: NonEmptyString,
  itemVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /**
   * zotero.org's library version before the last read that left nothing open: while nothing of
   * the item changes after it, a refresh may pass the item by. Absent for Zotero on this computer.
   */
  libraryVersion: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  syncedAt: NonEmptyString,
  metadata: ScientSourceEditableMetadata,
  /** The text Scient last wrote into the source's note from Zotero's notes. */
  note: Schema.NullOr(Schema.String),
  /**
   * The Markdown converted from Zotero's saved note when it differs from `note` (for example,
   * local Markdown sent as plain paragraphs whose round-trip escapes characters).
   */
  zoteroNote: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /**
   * Zotero's notes as it wrote them: each by key with the sha256 of its HTML, and the HTML while
   * the notes fit 1,000,000 characters and the 2 MiB sync-file limit; absent when last read
   * before they were kept.
   */
  notes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        itemKey: NonEmptyString,
        sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
        html: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  /** Whether the initial import sync write omitted any original note HTML for size; preserved across later sync writes. */
  importOmittedOriginalNoteHtml: Schema.optionalKey(Schema.Boolean),
  /** The import operation whose initial write saved this baseline; preserved across later sync writes. */
  importOperationId: Schema.optionalKey(NonEmptyString),
  attachmentKeys: Schema.Array(NonEmptyString),
  /** Each Zotero file's PDF here, by sha256; absent when imported before it was kept. */
  pdfs: Schema.optionalKey(Schema.Record(NonEmptyString, NonEmptyString)),
});
export type ScientSourceZoteroSync = typeof ScientSourceZoteroSync.Type;

export const ScientSourceMetadataValidationIssue = Schema.Struct({
  field: NonEmptyString,
  message: NonEmptyString,
});
export type ScientSourceMetadataValidationIssue = typeof ScientSourceMetadataValidationIssue.Type;

export const ScientSourceCandidate = Schema.Struct({
  sourceKey: NonEmptyString,
  /** A key kept from the importing system; the store generates one when absent. */
  citationKey: Schema.optionalKey(ScientSourceCitationKey),
  type: ScientSourceType,
  customType: Schema.optionalKey(NullableText),
  title: NullableText,
  creators: Schema.Array(ScientSourceCreator),
  incompleteCreatorRoles: Schema.optionalKey(ScientSourceIncompleteCreatorRoles),
  issuedRaw: NullableText,
  issuedYear: Schema.NullOr(Schema.Int),
  identifiers: Schema.Array(ScientSourceIdentifier),
  abstract: NullableText,
  abstractSections: Schema.optionalKey(BoundedAbstractSections),
  containerTitle: NullableText,
  publisher: NullableText,
  volume: NullableText,
  issue: NullableText,
  pages: NullableText,
  language: NullableText,
  url: NullableText,
  more: Schema.optionalKey(ScientSourceMore),
  tags: Schema.Array(Schema.String),
  externalReferences: Schema.Array(ScientSourceExternalReference),
  fieldProvenance: Schema.Array(ScientSourceFieldProvenance),
  pdfAvailable: Schema.Boolean,
  pdfFileName: NullableText,
  pdfAttachmentCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  note: Schema.optionalKey(ScientSourceNote),
});
export type ScientSourceCandidate = typeof ScientSourceCandidate.Type;

/** Durable project-local handoff between upload review and the resumable importer. */
export const ScientSourceStagedMaterial = Schema.Struct({
  formatVersion: Schema.Literal(1),
  sourceKey: NonEmptyString,
  candidate: ScientSourceCandidate,
  pdfFileName: NonEmptyString,
  pdfRelativePath: NonEmptyString,
  pdfSha256: NonEmptyString,
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: NonEmptyString,
});
export type ScientSourceStagedMaterial = typeof ScientSourceStagedMaterial.Type;

export const ScientSourceMetadataDiagnostic = Schema.Struct({
  field: NonEmptyString,
  severity: Schema.Literals(["info", "warning"]),
  message: NonEmptyString,
});
export type ScientSourceMetadataDiagnostic = typeof ScientSourceMetadataDiagnostic.Type;

export const ScientSourceDuplicateKind = Schema.Literals([
  "same-origin",
  "same-identifier",
  "same-pdf",
  "possible-metadata-match",
  "new",
]);
export type ScientSourceDuplicateKind = typeof ScientSourceDuplicateKind.Type;

export const ScientSourceDuplicateAssessment = Schema.Struct({
  kind: ScientSourceDuplicateKind,
  matchingSourceIds: Schema.Array(NonEmptyString),
  reason: NonEmptyString,
});
export type ScientSourceDuplicateAssessment = typeof ScientSourceDuplicateAssessment.Type;

export const ScientSourceMetadataUpdateResult = Schema.Struct({
  outcome: Schema.Literals(["updated", "unchanged", "stale", "duplicate"]),
  record: ScientSourceRecord,
  duplicate: ScientSourceDuplicateAssessment,
  validationIssues: Schema.Array(ScientSourceMetadataValidationIssue),
  /** Project documents whose citations followed a deliberate key rename. */
  citationKeyRenamedIn: Schema.optionalKey(Schema.Array(NonEmptyString)),
  /** Documents a key rename could not reach, with why; their citations still use the old key. */
  citationKeyRenameSkipped: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: NonEmptyString, reason: NonEmptyString })),
  ),
});
export type ScientSourceMetadataUpdateResult = typeof ScientSourceMetadataUpdateResult.Type;

export const ScientSourceNoteUpdateResult = Schema.Struct({
  outcome: Schema.Literals(["updated", "unchanged", "stale"]),
  record: ScientSourceRecord,
});
export type ScientSourceNoteUpdateResult = typeof ScientSourceNoteUpdateResult.Type;

export const ScientSourceRemovalResult = Schema.Struct({
  outcome: Schema.Literals(["removed", "not-found", "stale"]),
  sourceId: NonEmptyString,
  revision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  removedAttachmentCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  retainedAttachmentCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** A removed source waits in the project trash until it is restored or the trash is emptied. */
  restorable: Schema.optionalKey(Schema.Boolean),
});
export type ScientSourceRemovalResult = typeof ScientSourceRemovalResult.Type;

/** A removed source, kept whole with its attachment references until the trash is emptied. */
export const ScientSourceTrashEntry = Schema.Struct({
  /** 1 in a project store (names the project), 2 in the library (names none), as its record. */
  formatVersion: Schema.Literals([1, 2]),
  sourceId: NonEmptyString,
  projectId: Schema.optionalKey(NonEmptyString),
  /** Unique to this removal; a request to delete it for good names it. Older entries lack it. */
  removalId: Schema.optionalKey(NonEmptyString),
  removedAt: NonEmptyString,
  removedBy: ScientSourceActor,
  record: ScientSourceRecord,
  /** Set when a library merge put the source here; only that merge's Undo brings it back. */
  mergedInto: Schema.optionalKey(
    Schema.Struct({ sourceId: NonEmptyString, mergeId: NonEmptyString }),
  ),
});
export type ScientSourceTrashEntry = typeof ScientSourceTrashEntry.Type;

export const ScientSourceTrashSummary = Schema.Struct({
  sourceId: NonEmptyString,
  removalId: NonEmptyString,
  revision: ScientSourceRecord.fields.revision,
  type: ScientSourceType,
  title: NullableText,
  creators: Schema.Array(ScientSourceCreator),
  issuedYear: Schema.NullOr(Schema.Int),
  removedAt: NonEmptyString,
  removedBy: ScientSourceActor,
  /** Library only: projects that still cite it and keep citing it from their own copy. */
  citedBy: Schema.optionalKey(Schema.Array(NonEmptyString)),
});
export type ScientSourceTrashSummary = typeof ScientSourceTrashSummary.Type;

export const ScientSourceStoreIssue = Schema.Struct({
  /** Project-relative path with forward slashes. */
  path: Schema.String,
  message: Schema.String,
});
export type ScientSourceStoreIssue = typeof ScientSourceStoreIssue.Type;

export const ScientSourceTrashListing = Schema.Struct({
  entries: Schema.Array(ScientSourceTrashSummary),
  issues: Schema.Array(ScientSourceStoreIssue),
  /** Names exactly these entries at these revisions; emptying the Trash sends it back. */
  revision: Schema.optionalKey(NonEmptyString),
  /** Removal IDs of deletions for good that stopped part way; no longer listed or restorable. */
  unfinished: Schema.optionalKey(Schema.Array(NonEmptyString)),
});
export type ScientSourceTrashListing = typeof ScientSourceTrashListing.Type;

const RecentChangeBase = { at: NonEmptyString, by: ScientSourceActor };

/**
 * One recorded change to the Library that can still be taken back or looked at: a bulk edit, a
 * merge, an import, a source in the Trash, a restore from a backup, or sources added from
 * another Library. Source IDs are the Library's.
 */
export const ScientLibraryRecentChange = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("bulk-edit"),
    /** The newest request's batch ID; `parts` has every request of the edit, oldest first. */
    id: NonEmptyString,
    ...RecentChangeBase,
    parts: Schema.Array(
      Schema.Struct({ batchId: NonEmptyString, sourceCount: Schema.Int, undone: Schema.Boolean }),
    ),
    /** The oldest requests of the edit are no longer kept; the counts are of what remains. */
    partsMissing: Schema.Boolean,
    sourceCount: Schema.Int,
    tagsAdded: Schema.Array(Schema.String),
    tagsRemoved: Schema.Array(Schema.String),
    typeChanged: Schema.Int,
    collections: Schema.Array(
      Schema.Struct({
        /** Null once the collection was deleted. */
        name: Schema.NullOr(Schema.String),
        added: Schema.Int,
        removed: Schema.Int,
        created: Schema.Boolean,
      }),
    ),
    undone: Schema.Boolean,
    /** Sources and collections an Undo left as they were, because they changed since. */
    left: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal("merge"),
    /** The merge ID. */
    id: NonEmptyString,
    ...RecentChangeBase,
    /** Scient merged them on its own rule (same identifier, PDF or Zotero item). */
    automatic: Schema.Boolean,
    keptSourceId: NonEmptyString,
    keptTitle: Schema.NullOr(Schema.String),
    mergedTitle: Schema.NullOr(Schema.String),
    undo: Schema.Literals(["available", "undone", "kept-source-gone", "merged-source-gone"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("import"),
    /** The operation ID. */
    id: NonEmptyString,
    ...RecentChangeBase,
    intake: Schema.Literals(["zotero", "local-pdf", "identifier", "file"]),
    outcome: Schema.Literals(["completed", "cancelled"]),
    imported: Schema.Int,
    /** How many of them are in the Library now: a merged one counts as the source that kept it. */
    available: Schema.Int,
    failed: Schema.Int,
    /** How many kinds of things the import read and did not bring; absent when none. */
    notBrought: Schema.optionalKey(Schema.Int),
    /** A large import that stopped before its end: how many references are still to come. */
    remaining: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({
    kind: Schema.Literal("trash"),
    /** The source ID. */
    id: NonEmptyString,
    ...RecentChangeBase,
    title: Schema.NullOr(Schema.String),
    revision: Schema.Int,
  }),
  /** A backup took the Library's place. It has no Undo; it says where the old Library is. */
  Schema.Struct({
    kind: Schema.Literal("restore"),
    /** The restore ID. */
    id: NonEmptyString,
    ...RecentChangeBase,
    backupCreatedAt: NonEmptyString,
    /** A Library an earlier restore had kept was put back; `backupCreatedAt` is when it was set aside. */
    putBack: Schema.optionalKey(Schema.Boolean),
    sources: Schema.Int,
    pdfs: Schema.Int,
    /** The replaced Library's folder and source count, while that folder is still there. */
    kept: Schema.NullOr(Schema.Struct({ path: NonEmptyString, sources: Schema.Int })),
  }),
  /** Sources added from another Library; Undo moves the unchanged ones to the Trash. */
  Schema.Struct({
    kind: Schema.Literal("join"),
    /** The join ID. */
    id: NonEmptyString,
    ...RecentChangeBase,
    /** A backup, or the Library a restore replaced. */
    from: Schema.Literals(["backup", "replaced"]),
    backupCreatedAt: Schema.NullOr(NonEmptyString),
    /** `stopped`: it did not finish; what it added is in the Library. */
    state: Schema.Literals(["done", "stopped", "undone"]),
    added: Schema.Int,
    /** Sources both Libraries hold that differ, or that may be the same paper: left as here. */
    different: Schema.Int,
    /** In this Library's Trash or deleted for good here: not brought back. */
    removedHere: Schema.Int,
    /** After Undo: sources that had changed since and stayed. */
    left: Schema.Int,
  }),
]);
export type ScientLibraryRecentChange = typeof ScientLibraryRecentChange.Type;

/** One side of a paper both Libraries hold, as the differences list shows it. */
export const ScientLibraryJoinSide = Schema.Struct({
  sourceId: NonEmptyString,
  title: Schema.NullOr(Schema.String),
  /** First author and year, to tell papers apart. */
  by: Schema.String,
  /** Everything the record says, as one value: an action is refused once this has changed. */
  fingerprint: NonEmptyString,
  note: Schema.String,
  tags: Schema.Array(Schema.String),
  read: Schema.Boolean,
  starred: Schema.Boolean,
  /** `available`: the file is in that Library's folder. */
  pdfs: Schema.Array(
    Schema.Struct({ sha256: NonEmptyString, fileName: Schema.String, available: Schema.Boolean }),
  ),
});
export type ScientLibraryJoinSide = typeof ScientLibraryJoinSide.Type;

export const ScientLibraryJoinRelation = Schema.Literals([
  "same-id",
  "merged-here",
  "rebuilt-there",
  "rebuilt-here",
  "same-paper",
  "possibly-same",
]);
export const ScientLibraryJoinPart = Schema.Literals([
  "details",
  "tags",
  "note",
  "reading",
  "pdfs",
  "highlights",
]);

export const ScientLibraryJoinDifferenceRow = Schema.Struct({
  otherSourceId: NonEmptyString,
  /** How the two stand now; `not-here`: no paper here could be the other one any more. */
  relation: Schema.Union([ScientLibraryJoinRelation, Schema.Literal("not-here")]),
  /** What differs now; what was recorded, while the other Library's folder is away. */
  parts: Schema.Array(ScientLibraryJoinPart),
  here: Schema.NullOr(ScientLibraryJoinSide),
  /** `possibly-same`: every source here it may be. */
  candidates: Schema.Array(
    Schema.Struct({ sourceId: NonEmptyString, title: Schema.NullOr(Schema.String) }),
  ),
  /** Null while the other Library's folder is away; `otherTitle` is then what was recorded. */
  other: Schema.NullOr(ScientLibraryJoinSide),
  otherTitle: Schema.NullOr(Schema.String),
  /** The detail fields that differ, each with both values. */
  details: Schema.Array(
    Schema.Struct({ field: Schema.String, here: Schema.String, other: Schema.String }),
  ),
});
export type ScientLibraryJoinDifferenceRow = typeof ScientLibraryJoinDifferenceRow.Type;

/** The papers a join left as they are here, with both sides; nothing in it is a change. */
export const ScientLibraryJoinDifferences = Schema.Struct({
  joinId: NonEmptyString,
  from: Schema.Literals(["backup", "replaced"]),
  backupCreatedAt: Schema.NullOr(Schema.String),
  /** The folder the join read. */
  folder: Schema.String,
  /** False when that folder is away, or is no longer the snapshot the join read. */
  available: Schema.Boolean,
  /** How many differences the join recorded; rows that no longer differ are left out. */
  total: Schema.Int,
  /** Where the next page starts in what was recorded, or null at the end. */
  nextOffset: Schema.NullOr(Schema.Int),
  rows: Schema.Array(ScientLibraryJoinDifferenceRow),
  /** Removed here and still in the other Library: not brought back, listed only. */
  removedHere: Schema.Array(
    Schema.Struct({
      otherSourceId: NonEmptyString,
      state: Schema.Literals(["trash", "deleted"]),
      title: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ScientLibraryJoinDifferences = typeof ScientLibraryJoinDifferences.Type;

export const ScientLibraryRecentChanges = Schema.Struct({
  /** Newest first. */
  changes: Schema.Array(ScientLibraryRecentChange),
  /** Older changes exist than the ones returned. */
  more: Schema.Boolean,
  /** Only when one import's sources were asked for: those in the Library now. */
  importSourceIds: Schema.optionalKey(Schema.Array(NonEmptyString)),
  /** Only when one join's differences were asked for. */
  joinDifferences: Schema.optionalKey(ScientLibraryJoinDifferences),
  /**
   * Only when one import's "not brought" list was asked for: each thing in words, how many,
   * and the sources it concerns that are in the Library now.
   */
  importNotBrought: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        what: Schema.String,
        amount: Schema.String,
        sourceIds: Schema.Array(NonEmptyString),
      }),
    ),
  ),
});
export type ScientLibraryRecentChanges = typeof ScientLibraryRecentChanges.Type;

/** Where this project's Markdown and LaTeX documents cite one source, under any of its keys. */
export const ScientSourceUses = Schema.Struct({
  /** The project's keys for the source; several after merges or duplicate .bib entries. */
  citationKeys: Schema.Array(NonEmptyString),
  occurrences: Schema.Array(
    Schema.Struct({
      /** Project-relative, with `/`. */
      path: NonEmptyString,
      line: Schema.Int,
      column: Schema.Int,
      /** As the document writes it. */
      citationKey: NonEmptyString,
      locator: Schema.NullOr(Schema.String),
      /** The sentence or line around the citation, on one line. */
      context: Schema.String,
      /** Where the citation is in `context`. */
      contextCitation: Schema.Struct({ start: Schema.Int, end: Schema.Int }),
      /**
       * `project`: the project's own key. `bibliography`: the document's own bibliography
       * defines the key; `confirmed` when its identifiers name this source's work.
       */
      through: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("project") }),
        Schema.Struct({
          kind: Schema.Literal("bibliography"),
          path: NonEmptyString,
          confirmed: Schema.Boolean,
        }),
      ]),
    }),
  ),
  /** `\nocite`: in a document's bibliography without a citation in its text; not counted. */
  listed: Schema.Array(
    Schema.Struct({ path: NonEmptyString, line: Schema.Int, citationKey: NonEmptyString }),
  ),
  /** Documents whose own bibliography gives one of the keys to another work. */
  elsewhere: Schema.Array(
    Schema.Struct({ path: NonEmptyString, key: NonEmptyString, bibliography: NonEmptyString }),
  ),
  /** How many documents were read. */
  documents: Schema.Int,
  skipped: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
  /** False when anything was skipped or could not be read: absence is then not proven. */
  complete: Schema.Boolean,
});
export type ScientSourceUses = typeof ScientSourceUses.Type;

/** What each citation key of one document names, read with that document's bibliographies. */
export const ScientSourceCitationKeys = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      /** As requested. */
      key: NonEmptyString,
      /**
       * `library`: a project work, which the document's bibliographies leave undefined or confirm.
       * `unconfirmed`: a project key they leave open. `other-work`: they give it to another
       * work. `not-library`: not a project key.
       */
      status: Schema.Literals(["library", "unconfirmed", "other-work", "not-library"]),
      /** The Library sources it may name here; empty unless library or unconfirmed. */
      sourceIds: Schema.Array(NonEmptyString),
      /** The project bibliography that defines it, or leaves it open, when there is one. */
      bibliography: Schema.NullOr(NonEmptyString),
    }),
  ),
  /** False when the document, a bibliography or a LaTeX file could not be read. */
  complete: Schema.Boolean,
});
export type ScientSourceCitationKeys = typeof ScientSourceCitationKeys.Type;

export const ScientSourceRestoreResult = Schema.Struct({
  outcome: Schema.Literals(["restored", "not-found", "exists", "duplicate"]),
  sourceId: NonEmptyString,
  record: Schema.NullOr(ScientSourceRecord),
  matchingSourceIds: Schema.Array(NonEmptyString),
});
export type ScientSourceRestoreResult = typeof ScientSourceRestoreResult.Type;

export const ScientSourcePermanentDeletionResult = Schema.Struct({
  /** `changed`: the Trash is no longer the listing the request named, so nothing was deleted. */
  outcome: Schema.Literals(["deleted", "changed"]),
  deletedSourceIds: Schema.Array(NonEmptyString),
  removedFileCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ScientSourcePermanentDeletionResult = typeof ScientSourcePermanentDeletionResult.Type;

export const ScientSourceRevisionSummary = Schema.Struct({
  revision: ScientSourceRecord.fields.revision,
  savedAt: NonEmptyString,
  savedBy: ScientSourceActor,
  /** Fields that differ from the previous kept revision; empty for the first one. */
  changes: Schema.Array(NonEmptyString),
  current: Schema.Boolean,
});
export type ScientSourceRevisionSummary = typeof ScientSourceRevisionSummary.Type;

export const ScientSourceRevertResult = Schema.Struct({
  outcome: Schema.Literals(["reverted", "unchanged", "stale", "not-found", "duplicate"]),
  record: ScientSourceRecord,
  matchingSourceIds: Schema.Array(NonEmptyString),
});
export type ScientSourceRevertResult = typeof ScientSourceRevertResult.Type;

export const ScientSourcePreflightItem = Schema.Struct({
  candidate: ScientSourceCandidate,
  duplicate: ScientSourceDuplicateAssessment,
  metadataDiagnostics: Schema.Array(ScientSourceMetadataDiagnostic),
});
export type ScientSourcePreflightItem = typeof ScientSourcePreflightItem.Type;

/**
 * Something an import read where the source came from and did not bring, or brought changed,
 * for one item. `kind` says what sort of thing, `name` which one (a field's name there, a
 * file's type), `count` how many. The panel and the agent's result say it in words.
 */
export const ScientSourceNotBrought = Schema.Struct({
  kind: Schema.Literals([
    /** A bibliographic field the record has no place for; `name` is the field there. */
    "field",
    /** A line of Zotero's Extra that Scient does not read; `name` is the line's name. */
    "extra",
    /** A file that is not a PDF; `name` is its content type. */
    "file",
    /** A link kept as an attachment. */
    "link",
    /** PDFs not copied; `name`: `over-limit` or `unavailable`. */
    "pdf",
    /** The notes together were longer than a note may be and were cut; `original`: Zotero's HTML of some was not kept. */
    "note-cut",
    /** Notes whose formatting became plain text: imports made before notes came as Markdown. */
    "note-formatting",
    /** Images in notes, which are not carried. */
    "note-images",
    /** Highlights and comments: `unplaced` (kept, not on the page), `no-file`, `later` (not saved), `too-long`; unnamed before. */
    "highlights",
    /** Links to related items. */
    "related",
    /** Tags a program added, which arrive as ordinary tags. */
    "automatic-tags",
    /** Notes that belong to no reference (an import of references passes them by). */
    "notes-alone",
    /** Files that belong to no reference. */
    "files-alone",
    /** Zotero could not be asked how many notes and files belong to no reference. */
    "alone-uncounted",
    /** References that were already here: nothing of Zotero's copy was taken. */
    "already-here",
    /** Collections not made; `name`: `unmade`, `unfiled` (a reference's), `unread` (not listed). */
    "collection",
  ]),
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  count: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ScientSourceNotBrought = typeof ScientSourceNotBrought.Type;

/**
 * What became of one key a reference file cites a work by. `added`: this project cites the work
 * by it from now on; `cited`: it did already. `taken`: it already cites another source here, which
 * keeps it. `library`: a My Library import, which writes nothing in a project.
 */
export const ScientSourceItemCitationKey = Schema.Struct({
  citationKey: NonEmptyString,
  outcome: Schema.Literals(["added", "cited", "taken", "library"]),
});
export type ScientSourceItemCitationKey = typeof ScientSourceItemCitationKey.Type;

export const ScientSourceOperationItem = Schema.Struct({
  itemKey: NonEmptyString,
  allowPossibleMetadataMatch: Schema.optionalKey(Schema.Boolean),
  state: Schema.Literals(["pending", "imported", "skipped", "failed"]),
  // Optional for compatibility with operations created before duplicate
  // dispositions were recorded explicitly.
  duplicateKind: Schema.optionalKey(ScientSourceDuplicateKind),
  sourceId: NullableText,
  message: NullableText,
  /** What the import read for this item and did not bring; absent when it brought it all. */
  notBrought: Schema.optionalKey(
    Schema.Array(ScientSourceNotBrought).check(Schema.isMaxLength(80)),
  ),
  /** A reference-file entry's keys, its own first, then those of later entries for the same work. */
  citationKeys: Schema.optionalKey(
    Schema.Array(ScientSourceItemCitationKey).check(Schema.isMaxLength(50)),
  ),
  /** The key this project cites the work by when none of the file's keys could be used. */
  projectKey: Schema.optionalKey(NonEmptyString),
  /** An author list the file ended with "and others": filled in from its DOI, or kept short. */
  authorList: Schema.optionalKey(Schema.Literals(["completed", "incomplete"])),
  /** A PDF of a paper already here (`sourceId`), added to that source instead of a new one. */
  attachedPdf: Schema.optionalKey(Schema.Literal(true)),
});
export type ScientSourceOperationItem = typeof ScientSourceOperationItem.Type;

/**
 * Every import item is durably checkpointed for restart. Larger transfers need a versioned
 * append-only format, not ever-larger arrays and repeated whole-file rewrites.
 */
export const SCIENT_SOURCE_IMPORT_ITEM_LIMIT = 500;

export const ScientSourceImportOperation = Schema.Struct({
  /** 1 in a project store (names its project), 2 in the library (names the library). */
  formatVersion: Schema.Literals([1, 2]),
  operationId: NonEmptyString,
  projectId: Schema.optionalKey(NonEmptyString),
  libraryId: Schema.optionalKey(NonEmptyString),
  adapter: Schema.Literals(["zotero", "local-files", "agent", "zotero-web", "file"]),
  actor: Schema.Literals(["user", "agent"]),
  intake: Schema.Literals(["zotero", "local-pdf", "identifier", "file"]),
  state: Schema.Literals(["running", "cancelled", "completed"]),
  createdAt: NonEmptyString,
  updatedAt: NonEmptyString,
  items: Schema.Array(ScientSourceOperationItem),
  /** A Zotero import from a group library; absent for My Library and other adapters. */
  zoteroGroupId: Schema.optionalKey(Schema.String),
  /** Library imports started from a project: the checkout instance each imported source is pinned in. */
  pinInstanceId: Schema.optionalKey(NonEmptyString),
  /** What the place imported from holds that belongs to no item, and so was not brought. */
  notBrought: Schema.optionalKey(
    Schema.Array(ScientSourceNotBrought).check(Schema.isMaxLength(20)),
  ),
  /**
   * A Zotero scope too large for one operation is imported as a run of them: this is one
   * part. `remaining` items of the scope come in later parts; `scope` lets a later session
   * begin the next one.
   */
  run: Schema.optionalKey(
    Schema.Struct({
      runId: NonEmptyString,
      part: Schema.Int.check(Schema.isGreaterThan(0)),
      remaining: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      scope: Schema.suspend(() => ZoteroImportScope),
    }),
  ),
});
export type ScientSourceImportOperation = typeof ScientSourceImportOperation.Type;

export const ScientSourceImportReceipt = Schema.Struct({
  /** 1 in a project store (names its project), 2 in the library (names the library). */
  formatVersion: Schema.Literals([1, 2]),
  operationId: NonEmptyString,
  projectId: Schema.optionalKey(NonEmptyString),
  libraryId: Schema.optionalKey(NonEmptyString),
  outcome: Schema.Literals(["completed", "cancelled"]),
  finishedAt: NonEmptyString,
  importedSourceIds: Schema.Array(NonEmptyString),
  skippedItemKeys: Schema.Array(NonEmptyString),
  failedItemKeys: Schema.Array(NonEmptyString),
  unprocessedItemKeys: Schema.Array(NonEmptyString),
  /** A part of a large import: the run it belongs to, so its parts are listed as one import. */
  runId: Schema.optionalKey(NonEmptyString),
});
export type ScientSourceImportReceipt = typeof ScientSourceImportReceipt.Type;

export const ScientSourcesOverview = Schema.Struct({
  projectState: Schema.Literals(["ordinary", "initialized", "recoverable", "conflicting"]),
  issues: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      message: Schema.String,
    }),
  ),
  records: Schema.Array(ScientSourceRecord),
  activeOperation: Schema.NullOr(ScientSourceImportOperation),
  /** Record files that could not be read; the rest of the Library still lists. */
  unreadableRecords: Schema.optionalKey(Schema.Array(ScientSourceStoreIssue)),
  trashedCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Deletions for good that stopped part way; the Trash offers to finish them. */
  unfinishedDeletions: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type ScientSourcesOverview = typeof ScientSourcesOverview.Type;

export const ZoteroConnectionState = Schema.Literals([
  "ready",
  "access-disabled",
  "incompatible",
  "malformed",
  "unreachable",
]);
export type ZoteroConnectionState = typeof ZoteroConnectionState.Type;

/** Zotero on this computer (local API) or the user's library on zotero.org (key from Accounts). */
export const ZoteroConnection = Schema.Literals(["local", "web"]);
export type ZoteroConnection = typeof ZoteroConnection.Type;

/** A zotero.org group's numeric ID; Zotero on this computer uses the same ID for a synced group. */
export const ZoteroGroupId = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,11}$/u));
export type ZoteroGroupId = typeof ZoteroGroupId.Type;

/**
 * Group items are linked as `groups/<groupId>` and My Library items by the bare user ID, so a
 * group and a user that share a number, or items that share a key, never meet.
 */
export const zoteroGroupLibraryId = (groupId: string): string => `groups/${groupId}`;

export function zoteroGroupIdOfLibrary(libraryId: string): string | null {
  return /^groups\/([1-9][0-9]{0,11})$/u.exec(libraryId)?.[1] ?? null;
}

/** A group library the connection can read; `canWrite` only on zotero.org with a key that can. */
export const ZoteroGroup = Schema.Struct({
  groupId: ZoteroGroupId,
  name: NonEmptyString,
  canWrite: Schema.Boolean,
});
export type ZoteroGroup = typeof ZoteroGroup.Type;

/** Fields a Zotero refresh compares; the citation key never changes from Zotero. */
export const ScientSourceZoteroRefreshField = Schema.Literals([
  "type",
  "customType",
  "title",
  "creators",
  "issuedRaw",
  "issuedYear",
  "identifiers",
  "abstract",
  "containerTitle",
  "publisher",
  "volume",
  "issue",
  "pages",
  "language",
  "url",
  "tags",
  /** The further details (edition, place of publication, …), compared one by one. */
  "more",
  "note",
]);
export type ScientSourceZoteroRefreshField = typeof ScientSourceZoteroRefreshField.Type;

/** A field edited here that Zotero also changed; the value here was kept. */
export const ScientSourceZoteroConflict = Schema.Struct({
  field: ScientSourceZoteroRefreshField,
  local: Schema.String,
  zotero: Schema.String,
});
export type ScientSourceZoteroConflict = typeof ScientSourceZoteroConflict.Type;

export const ScientSourceZoteroRefreshItem = Schema.Struct({
  sourceId: NonEmptyString,
  title: NullableText,
  outcome: Schema.Literals(["updated", "unchanged", "missing", "stale", "failed"]),
  changedFields: Schema.Array(NonEmptyString),
  addedPdfCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  conflicts: Schema.Array(ScientSourceZoteroConflict),
  message: NullableText,
  /** Highlights it could not bring: `highlights` named `unplaced`, `no-file` or `too-long`. */
  notBrought: Schema.optionalKey(Schema.Array(ScientSourceNotBrought)),
});
export type ScientSourceZoteroRefreshItem = typeof ScientSourceZoteroRefreshItem.Type;

export const ScientSourceZoteroRefreshResult = Schema.Struct({
  connection: ZoteroConnection,
  items: Schema.Array(ScientSourceZoteroRefreshItem),
  /** A batch of a whole-Library refresh: how many sources came from Zotero in all. */
  total: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** The last source of this batch, to ask for the batch after it; absent after the last. */
  next: Schema.optionalKey(NonEmptyString),
});
export type ScientSourceZoteroRefreshResult = typeof ScientSourceZoteroRefreshResult.Type;

export const ScientSourceZoteroSendItem = Schema.Struct({
  sourceId: NonEmptyString,
  title: NullableText,
  outcome: Schema.Literals(["created", "updated", "unchanged", "changed-in-zotero", "failed"]),
  itemKey: NullableText,
  message: NullableText,
  /** With PDFs asked for: each of the source's PDFs, and why one was not sent. */
  pdfs: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        fileName: NonEmptyString,
        outcome: Schema.Literals(["sent", "in-zotero", "not-sent"]),
        message: NullableText,
      }),
    ),
  ),
});
export type ScientSourceZoteroSendItem = typeof ScientSourceZoteroSendItem.Type;

export const ScientSourceZoteroSendResult = Schema.Struct({
  items: Schema.Array(ScientSourceZoteroSendItem),
});
export type ScientSourceZoteroSendResult = typeof ScientSourceZoteroSendResult.Type;

export const ZoteroConnectionStatus = Schema.Struct({
  state: ZoteroConnectionState,
  apiVersion: Schema.NullOr(Schema.Int),
  message: NonEmptyString,
  // Absent on statuses from before zotero.org support, which were always local.
  connection: Schema.optionalKey(ZoteroConnection),
  canWrite: Schema.optionalKey(Schema.Boolean),
  /** False when a zotero.org key reads groups but not its owner's My Library. */
  myLibrary: Schema.optionalKey(Schema.Boolean),
  /** Group libraries besides My Library; listed only when the connection is ready. */
  groups: Schema.optionalKey(Schema.Array(ZoteroGroup)),
});
export type ZoteroConnectionStatus = typeof ZoteroConnectionStatus.Type;

/** A Zotero source boundary. Collections are Zotero's project-like grouping primitive. */
export const ZoteroImportScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("library") }),
  Schema.Struct({
    kind: Schema.Literal("collection"),
    collectionKey: NonEmptyString,
    includeSubcollections: Schema.Boolean,
  }),
]);
export type ZoteroImportScope = typeof ZoteroImportScope.Type;

export const ZoteroCollection = Schema.Struct({
  key: NonEmptyString,
  name: NonEmptyString,
  parentCollectionKey: NullableText,
});
export type ZoteroCollection = typeof ZoteroCollection.Type;

export const ZoteroCollectionsResult = Schema.Struct({
  collections: Schema.Array(ZoteroCollection),
});
export type ZoteroCollectionsResult = typeof ZoteroCollectionsResult.Type;

export const ZoteroLibraryPage = Schema.Struct({
  scope: ZoteroImportScope,
  items: Schema.Array(ScientSourceCandidate),
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nextStart: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  hasMore: Schema.Boolean,
});
export type ZoteroLibraryPage = typeof ZoteroLibraryPage.Type;
