import * as Schema from "effect/Schema";

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty());
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

export const ScientSourceExternalReference = Schema.Struct({
  system: NonEmptyString,
  libraryId: NonEmptyString,
  itemKey: NonEmptyString,
  itemVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  rawItemType: NonEmptyString,
});
export type ScientSourceExternalReference = typeof ScientSourceExternalReference.Type;

export const ScientSourceFieldProvenance = Schema.Struct({
  field: NonEmptyString,
  origin: Schema.Literals([
    "zotero",
    "local-pdf",
    "doi",
    "pubmed",
    "crossref",
    "europe-pmc",
    "derived",
    "user",
  ]),
  sourceField: NullableText,
  sourceIdentifier: Schema.optionalKey(ScientSourceIdentifier),
  retrievedAt: Schema.optionalKey(NonEmptyString),
});
export type ScientSourceFieldProvenance = typeof ScientSourceFieldProvenance.Type;

export const ScientSourceAttachment = Schema.Struct({
  attachmentId: NonEmptyString,
  kind: Schema.Literal("pdf"),
  fileName: NonEmptyString,
  mediaType: Schema.Literal("application/pdf"),
  sha256: NonEmptyString,
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  relativePath: NonEmptyString,
  importedAt: NonEmptyString,
});
export type ScientSourceAttachment = typeof ScientSourceAttachment.Type;

export const ScientSourceAttachmentSummary = Schema.Struct({
  attachmentId: ScientSourceAttachment.fields.attachmentId,
  kind: ScientSourceAttachment.fields.kind,
  fileName: ScientSourceAttachment.fields.fileName,
  mediaType: ScientSourceAttachment.fields.mediaType,
});
export type ScientSourceAttachmentSummary = typeof ScientSourceAttachmentSummary.Type;

export const ScientSourceRecord = Schema.Struct({
  formatVersion: Schema.Literal(1),
  sourceId: NonEmptyString,
  projectId: NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
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
  attachments: Schema.Array(ScientSourceAttachment),
  fieldProvenance: Schema.Array(ScientSourceFieldProvenance),
  importedAt: NonEmptyString,
  updatedAt: Schema.optionalKey(NonEmptyString),
});
export type ScientSourceRecord = typeof ScientSourceRecord.Type;

/**
 * Bounded list projection. Large abstracts, provenance, and external sync
 * evidence stay behind the per-source detail boundary.
 */
export const ScientSourceSummary = Schema.Struct({
  sourceId: ScientSourceRecord.fields.sourceId,
  revision: ScientSourceRecord.fields.revision,
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
});
export type ScientSourceSummary = typeof ScientSourceSummary.Type;

export function scientSourceSummaryFromRecord(record: ScientSourceRecord): ScientSourceSummary {
  return {
    sourceId: record.sourceId,
    revision: record.revision,
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
  };
}

/** The fields a researcher may correct without changing source identity or files. */
export const ScientSourceEditableMetadata = Schema.Struct({
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

export const ScientSourceRemovalResult = Schema.Struct({
  outcome: Schema.Literals(["removed", "not-found", "stale"]),
  sourceId: NonEmptyString,
  revision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  removedAttachmentCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  retainedAttachmentCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ScientSourceRemovalResult = typeof ScientSourceRemovalResult.Type;

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

export const ScientSourceImportOperation = Schema.Struct({
  formatVersion: Schema.Literal(1),
  operationId: NonEmptyString,
  projectId: NonEmptyString,
  adapter: Schema.Literals(["zotero", "local-files"]),
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

export const ZoteroConnectionStatus = Schema.Struct({
  state: ZoteroConnectionState,
  apiVersion: Schema.NullOr(Schema.Int),
  message: NonEmptyString,
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
