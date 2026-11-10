import * as Schema from "effect/Schema";

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
  "other",
]);
export type ScientSourceType = typeof ScientSourceType.Type;

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

const BoundedCreators = Schema.Array(ScientSourceCreator).pipe(
  Schema.check(Schema.isMaxLength(256)),
);
const BoundedIdentifiers = Schema.Array(ScientSourceIdentifier).pipe(
  Schema.check(Schema.isMaxLength(256)),
);
const BoundedTags = Schema.Array(Schema.String).pipe(Schema.check(Schema.isMaxLength(1_000)));

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
});
export type ScientSourceExternalReference = typeof ScientSourceExternalReference.Type;

export const ScientSourceOrigin = Schema.Struct({
  actor: Schema.Literals(["user", "agent"]),
  intake: Schema.Literals(["zotero", "local-pdf", "identifier", "paper", "web"]),
  operationId: NonEmptyString,
  // Older records may still say "pending"; nothing gates on it any more.
  review: Schema.Literals(["none", "pending"]),
});
export type ScientSourceOrigin = typeof ScientSourceOrigin.Type;

export const ScientSourceActor = Schema.Literals(["user", "agent"]);
export type ScientSourceActor = typeof ScientSourceActor.Type;

/** Whether an agent-added source's identifier was confirmed against its registry. */
export const ScientSourceVerification = Schema.Struct({
  state: Schema.Literals(["verified", "unchecked", "unverified"]),
  identifier: Schema.optionalKey(ScientSourceIdentifier),
  checkedAt: Schema.optionalKey(NonEmptyString),
});
export type ScientSourceVerification = typeof ScientSourceVerification.Type;

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

export const ScientSourceRecord = Schema.Struct({
  formatVersion: Schema.Literal(1),
  sourceId: NonEmptyString,
  projectId: NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  citationKey: Schema.optionalKey(ScientSourceCitationKey),
  type: ScientSourceType,
  customType: Schema.optionalKey(NullableText),
  title: NullableText,
  creators: Schema.Array(ScientSourceCreator),
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
  tags: Schema.Array(Schema.String),
  externalReferences: Schema.Array(ScientSourceExternalReference),
  attachments: Schema.Array(ScientSourceAttachment),
  fieldProvenance: Schema.Array(ScientSourceFieldProvenance),
  origin: Schema.optionalKey(ScientSourceOrigin),
  verification: Schema.optionalKey(ScientSourceVerification),
  importedAt: NonEmptyString,
  updatedAt: Schema.optionalKey(NonEmptyString),
  updatedBy: Schema.optionalKey(ScientSourceActor),
});
export type ScientSourceRecord = typeof ScientSourceRecord.Type;

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
  url: ScientSourceRecord.fields.url,
  externalReferences: ScientSourceRecord.fields.externalReferences,
  attachments: Schema.Array(ScientSourceAttachmentSummary),
  importedAt: ScientSourceRecord.fields.importedAt,
  updatedAt: ScientSourceRecord.fields.updatedAt,
  origin: Schema.optional(ScientSourceOrigin),
  verification: Schema.optional(ScientSourceVerification),
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
    url: record.url,
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
});
export type ScientSourceEditableMetadata = typeof ScientSourceEditableMetadata.Type;

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
  formatVersion: Schema.Literal(1),
  sourceId: NonEmptyString,
  projectId: NonEmptyString,
  removedAt: NonEmptyString,
  removedBy: ScientSourceActor,
  record: ScientSourceRecord,
});
export type ScientSourceTrashEntry = typeof ScientSourceTrashEntry.Type;

export const ScientSourceTrashSummary = Schema.Struct({
  sourceId: NonEmptyString,
  revision: ScientSourceRecord.fields.revision,
  type: ScientSourceType,
  title: NullableText,
  creators: Schema.Array(ScientSourceCreator),
  issuedYear: Schema.NullOr(Schema.Int),
  removedAt: NonEmptyString,
  removedBy: ScientSourceActor,
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
});
export type ScientSourceTrashListing = typeof ScientSourceTrashListing.Type;

export const ScientSourceRestoreResult = Schema.Struct({
  outcome: Schema.Literals(["restored", "not-found", "exists", "duplicate"]),
  sourceId: NonEmptyString,
  record: Schema.NullOr(ScientSourceRecord),
  matchingSourceIds: Schema.Array(NonEmptyString),
});
export type ScientSourceRestoreResult = typeof ScientSourceRestoreResult.Type;

export const ScientSourcePermanentDeletionResult = Schema.Struct({
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
  /** PDFs of the earlier revision whose files were already deleted when the trash was emptied. */
  missingAttachmentCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  matchingSourceIds: Schema.Array(NonEmptyString),
});
export type ScientSourceRevertResult = typeof ScientSourceRevertResult.Type;

export const ScientSourcePreflightItem = Schema.Struct({
  candidate: ScientSourceCandidate,
  duplicate: ScientSourceDuplicateAssessment,
  metadataDiagnostics: Schema.Array(ScientSourceMetadataDiagnostic),
});
export type ScientSourcePreflightItem = typeof ScientSourcePreflightItem.Type;

export const ScientSourceOperationItem = Schema.Struct({
  itemKey: NonEmptyString,
  allowPossibleMetadataMatch: Schema.optionalKey(Schema.Boolean),
  state: Schema.Literals(["pending", "imported", "skipped", "failed"]),
  // Optional for compatibility with operations created before duplicate
  // dispositions were recorded explicitly.
  duplicateKind: Schema.optionalKey(ScientSourceDuplicateKind),
  sourceId: NullableText,
  message: NullableText,
});
export type ScientSourceOperationItem = typeof ScientSourceOperationItem.Type;

/**
 * Every import item is durably checkpointed for restart. Larger transfers need a versioned
 * append-only format, not ever-larger arrays and repeated whole-file rewrites.
 */
export const SCIENT_SOURCE_IMPORT_ITEM_LIMIT = 500;

export const ScientSourceImportOperation = Schema.Struct({
  formatVersion: Schema.Literal(1),
  operationId: NonEmptyString,
  projectId: NonEmptyString,
  adapter: Schema.Literals(["zotero", "local-files", "agent", "zotero-web"]),
  actor: Schema.Literals(["user", "agent"]),
  intake: Schema.Literals(["zotero", "local-pdf", "identifier"]),
  state: Schema.Literals(["running", "cancelled", "completed"]),
  createdAt: NonEmptyString,
  updatedAt: NonEmptyString,
  items: Schema.Array(ScientSourceOperationItem),
});
export type ScientSourceImportOperation = typeof ScientSourceImportOperation.Type;

export const ScientSourceImportReceipt = Schema.Struct({
  formatVersion: Schema.Literal(1),
  operationId: NonEmptyString,
  projectId: NonEmptyString,
  outcome: Schema.Literals(["completed", "cancelled"]),
  finishedAt: NonEmptyString,
  importedSourceIds: Schema.Array(NonEmptyString),
  skippedItemKeys: Schema.Array(NonEmptyString),
  failedItemKeys: Schema.Array(NonEmptyString),
  unprocessedItemKeys: Schema.Array(NonEmptyString),
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

export const ZoteroConnectionStatus = Schema.Struct({
  state: ZoteroConnectionState,
  apiVersion: Schema.NullOr(Schema.Int),
  message: NonEmptyString,
  // Absent on statuses from before zotero.org support, which were always local.
  connection: Schema.optionalKey(ZoteroConnection),
  canWrite: Schema.optionalKey(Schema.Boolean),
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
