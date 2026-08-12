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
  origin: Schema.Literals(["zotero", "derived", "user"]),
  sourceField: NullableText,
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

export const ScientSourceRecord = Schema.Struct({
  formatVersion: Schema.Literal(1),
  sourceId: NonEmptyString,
  projectId: NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  type: ScientSourceType,
  title: NullableText,
  creators: Schema.Array(ScientSourceCreator),
  issuedRaw: NullableText,
  issuedYear: Schema.NullOr(Schema.Int),
  identifiers: Schema.Array(ScientSourceIdentifier),
  abstract: NullableText,
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
});
export type ScientSourceRecord = typeof ScientSourceRecord.Type;

export const ScientSourceCandidate = Schema.Struct({
  type: ScientSourceType,
  title: NullableText,
  creators: Schema.Array(ScientSourceCreator),
  issuedRaw: NullableText,
  issuedYear: Schema.NullOr(Schema.Int),
  identifiers: Schema.Array(ScientSourceIdentifier),
  abstract: NullableText,
  containerTitle: NullableText,
  publisher: NullableText,
  volume: NullableText,
  issue: NullableText,
  pages: NullableText,
  language: NullableText,
  url: NullableText,
  tags: Schema.Array(Schema.String),
  externalReference: ScientSourceExternalReference,
  fieldProvenance: Schema.Array(ScientSourceFieldProvenance),
  pdfAvailable: Schema.Boolean,
  pdfFileName: NullableText,
});
export type ScientSourceCandidate = typeof ScientSourceCandidate.Type;

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

export const ScientSourcePreflightItem = Schema.Struct({
  candidate: ScientSourceCandidate,
  duplicate: ScientSourceDuplicateAssessment,
  metadataDiagnostics: Schema.Array(ScientSourceMetadataDiagnostic),
});
export type ScientSourcePreflightItem = typeof ScientSourcePreflightItem.Type;

export const ScientSourceOperationItem = Schema.Struct({
  itemKey: NonEmptyString,
  state: Schema.Literals(["pending", "imported", "skipped", "failed"]),
  sourceId: NullableText,
  message: NullableText,
});
export type ScientSourceOperationItem = typeof ScientSourceOperationItem.Type;

export const ScientSourceImportOperation = Schema.Struct({
  formatVersion: Schema.Literal(1),
  operationId: NonEmptyString,
  projectId: NonEmptyString,
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

export const ZoteroLibraryPage = Schema.Struct({
  items: Schema.Array(ScientSourceCandidate),
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nextStart: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  hasMore: Schema.Boolean,
});
export type ZoteroLibraryPage = typeof ZoteroLibraryPage.Type;
