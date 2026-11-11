import {
  MAX_SOURCE_IDENTIFIER_BATCH,
  ScientSourceIdentifierAddItem,
  ScientSourceEditableMetadata,
  ScientSourceImportOperation,
  ScientSourceMetadataDiagnostic,
  ScientSourceMetadataUpdateResult,
  ScientSourceNote,
  ScientSourceNoteUpdateResult,
  ScientSourceRecord,
  ScientSourcePermanentDeletionResult,
  ScientSourceRemovalResult,
  ScientSourceRestoreResult,
  ScientSourceRevertResult,
  ScientSourceRevisionSummary,
  ScientSourceSummary,
  ScientSourceTrashListing,
  ScientSourcePreflightItem,
  ScientSourceWebPage,
  ScientSourcesBulkRequestChange,
  ScientSourcesBulkResult,
  ScientSystematicReviewAction,
  ScientSystematicReviewChangeResult,
  ScientSystematicReviewDetail,
  ScientSystematicReviewList,
  ScientSourcesOrganization,
  ScientSourcesOrganizeAction,
  ScientSourcesOrganizeResult,
  ScientSourcesOverview as ScientSourcesStoreOverview,
  ScientSourceZoteroRefreshField,
  ScientSourceZoteroRefreshResult,
  ScientSourceZoteroSendResult,
  ZoteroConnection,
  ZoteroConnectionStatus,
  ZoteroCollection,
  ZoteroCollectionsResult,
  ZoteroGroup,
  ZoteroGroupId,
  ZoteroImportScope,
  ZoteroLibraryPage,
} from "@scientfactory/scient-sources";
import {
  BibliographyFormatSchema,
  BibliographyFieldLoss,
  BibliographyImportReport,
} from "@scientfactory/scient-sources/bibliography";
import * as Schema from "effect/Schema";
import * as Multipart from "effect/http/Multipart";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

import { AssetCreateUrlResult } from "./assets.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty());
const BoundedPageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));

export const ScientSourcesOverviewRequest = Schema.Struct({ root: NonEmptyString });
export type ScientSourcesOverviewRequest = typeof ScientSourcesOverviewRequest.Type;

export const ScientSourceDetailRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
});
export type ScientSourceDetailRequest = typeof ScientSourceDetailRequest.Type;

export const ScientSourceDetailResult = ScientSourceRecord;
export type ScientSourceDetailResult = typeof ScientSourceDetailResult.Type;

export const ScientSourceAttachmentPreviewRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
  attachmentId: NonEmptyString,
});
export type ScientSourceAttachmentPreviewRequest = typeof ScientSourceAttachmentPreviewRequest.Type;

export const ScientSourceAttachmentPreviewResult = Schema.Struct({
  ...AssetCreateUrlResult.fields,
  /** The attachment's content-addressed bytes, so reader quotes can record them. */
  material: Schema.optional(
    Schema.Struct({
      sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
      byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    }),
  ),
});
export type ScientSourceAttachmentPreviewResult = typeof ScientSourceAttachmentPreviewResult.Type;

export const ScientSourcesFullTextSearchRequest = Schema.Struct({
  root: NonEmptyString,
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  /** Searches only these sources, before ranking and the limit; absent searches the whole Library. */
  sourceIds: Schema.optionalKey(
    Schema.Array(NonEmptyString).pipe(Schema.check(Schema.isMaxLength(20_000))),
  ),
});
export type ScientSourcesFullTextSearchRequest = typeof ScientSourcesFullTextSearchRequest.Type;

const TextOffset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ScientSourcesFullTextSearchResult = Schema.Struct({
  hits: Schema.Array(
    Schema.Struct({
      sourceId: NonEmptyString,
      attachmentId: NonEmptyString,
      fileName: NonEmptyString,
      title: Schema.NullOr(Schema.String),
      page: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      start: TextOffset,
      end: TextOffset,
      passage: Schema.String,
      matchedTerms: Schema.Array(Schema.String),
      selector: Schema.Struct({
        extractorVersion: NonEmptyString,
        viewBox: Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite, Schema.Finite]),
        rotation: Schema.Int,
        userUnit: Schema.Finite,
        pageTextHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
        quote: Schema.String,
        prefix: Schema.String,
        suffix: Schema.String,
      }),
    }),
  ),
  status: Schema.Struct({
    pdfs: TextOffset,
    searchable: TextOffset,
    pending: TextOffset,
    withoutText: TextOffset,
    unreadable: TextOffset,
  }),
});
export type ScientSourcesFullTextSearchResult = typeof ScientSourcesFullTextSearchResult.Type;

export const ScientSourceSavePageRequest = Schema.Struct({
  root: NonEmptyString,
  page: ScientSourceWebPage,
});
export type ScientSourceSavePageRequest = typeof ScientSourceSavePageRequest.Type;

export const ScientSourceSavePageResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literals(["added", "existing"]),
    sourceId: NonEmptyString,
    revision: Schema.Int.check(Schema.isGreaterThan(0)),
    passageSaved: Schema.Boolean,
  }),
  Schema.Struct({
    outcome: Schema.Literal("not-added"),
    reason: Schema.Literals(["identifier-not-found", "identifier-mismatch", "possible-duplicate"]),
    message: Schema.String,
    matchingSourceIds: Schema.Array(NonEmptyString),
  }),
]);
export type ScientSourceSavePageResult = typeof ScientSourceSavePageResult.Type;

export const ScientSourceJournalIconRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
});
export type ScientSourceJournalIconRequest = typeof ScientSourceJournalIconRequest.Type;

export const ScientSourceJournalIconResult = Schema.Struct({
  icon: Schema.NullOr(
    Schema.Struct({
      ...AssetCreateUrlResult.fields,
      journalTitle: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
    }),
  ),
});
export type ScientSourceJournalIconResult = typeof ScientSourceJournalIconResult.Type;

export const ScientSourceMetadataUpdateRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  metadata: ScientSourceEditableMetadata,
  allowPossibleMetadataMatch: Schema.optionalKey(Schema.Boolean),
});
export type ScientSourceMetadataUpdateRequest = typeof ScientSourceMetadataUpdateRequest.Type;

export const ScientSourceNoteUpdateRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  note: ScientSourceNote,
});
export type ScientSourceNoteUpdateRequest = typeof ScientSourceNoteUpdateRequest.Type;
export { ScientSourceNoteUpdateResult };

export const ScientSourceMetadataRefreshRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ScientSourceMetadataRefreshRequest = typeof ScientSourceMetadataRefreshRequest.Type;

export const ScientSourceMetadataRefreshResult = Schema.Struct({
  outcome: Schema.Literals(["refreshed", "unchanged", "stale", "unavailable", "duplicate"]),
  record: ScientSourceRecord,
  changedFields: Schema.Array(NonEmptyString),
  message: Schema.NullOr(Schema.String),
});
export type ScientSourceMetadataRefreshResult = typeof ScientSourceMetadataRefreshResult.Type;

export const ScientSourceRemovalRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ScientSourceRemovalRequest = typeof ScientSourceRemovalRequest.Type;

export const ScientSourcesOrganizeRequest = Schema.Struct({
  root: NonEmptyString,
  change: ScientSourcesOrganizeAction,
});
export type ScientSourcesOrganizeRequest = typeof ScientSourcesOrganizeRequest.Type;

export const ScientSystematicReviewsRequest = Schema.Struct({ root: NonEmptyString });
export type ScientSystematicReviewsRequest = typeof ScientSystematicReviewsRequest.Type;

export const ScientSystematicReviewRequest = Schema.Struct({
  root: NonEmptyString,
  reviewId: NonEmptyString,
});
export type ScientSystematicReviewRequest = typeof ScientSystematicReviewRequest.Type;

export const ScientSystematicReviewResult = Schema.Struct({
  detail: Schema.NullOr(ScientSystematicReviewDetail),
});
export type ScientSystematicReviewResult = typeof ScientSystematicReviewResult.Type;

export const ScientSystematicReviewChangeRequest = Schema.Struct({
  root: NonEmptyString,
  change: ScientSystematicReviewAction,
});
export type ScientSystematicReviewChangeRequest = typeof ScientSystematicReviewChangeRequest.Type;

export const ScientSourcesBulkUpdateRequest = Schema.Struct({
  root: NonEmptyString,
  change: ScientSourcesBulkRequestChange,
});
export type ScientSourcesBulkUpdateRequest = typeof ScientSourcesBulkUpdateRequest.Type;
export const ScientSourcesAddByIdentifierRequest = Schema.Struct({
  root: NonEmptyString,
  entries: Schema.Array(Schema.String.check(Schema.isMaxLength(1_000))).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SOURCE_IDENTIFIER_BATCH)),
  ),
});
export type ScientSourcesAddByIdentifierRequest = typeof ScientSourcesAddByIdentifierRequest.Type;

export const ScientSourcesAddByIdentifierResult = Schema.Struct({
  results: Schema.Array(ScientSourceIdentifierAddItem),
});
export type ScientSourcesAddByIdentifierResult = typeof ScientSourcesAddByIdentifierResult.Type;

export const ScientSourcesTrashRequest = Schema.Struct({ root: NonEmptyString });
export type ScientSourcesTrashRequest = typeof ScientSourcesTrashRequest.Type;

export const ScientSourceRestoreRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
});
export type ScientSourceRestoreRequest = typeof ScientSourceRestoreRequest.Type;

/** Without sourceIds the whole trash is emptied. */
export const ScientSourcesPermanentDeletionRequest = Schema.Struct({
  root: NonEmptyString,
  sourceIds: Schema.optionalKey(
    Schema.Array(NonEmptyString).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  ),
});
export type ScientSourcesPermanentDeletionRequest =
  typeof ScientSourcesPermanentDeletionRequest.Type;

export const ScientSourceRevisionsRequest = ScientSourceDetailRequest;
export type ScientSourceRevisionsRequest = typeof ScientSourceRevisionsRequest.Type;

export const ScientSourceRevisionsResult = Schema.Struct({
  revisions: Schema.Array(ScientSourceRevisionSummary),
});
export type ScientSourceRevisionsResult = typeof ScientSourceRevisionsResult.Type;

export const ScientSourceRevertRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  toRevision: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ScientSourceRevertRequest = typeof ScientSourceRevertRequest.Type;

/** Without a connection, Zotero on this computer is preferred, then zotero.org. */
export const ZoteroStatusRequest = Schema.Struct({
  connection: Schema.optionalKey(ZoteroConnection),
});
export type ZoteroStatusRequest = typeof ZoteroStatusRequest.Type;

const BoundedSourceIds = Schema.Array(NonEmptyString).pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
);
const RefreshFields = Schema.Array(ScientSourceZoteroRefreshField).pipe(
  Schema.check(Schema.isMaxLength(32)),
);

/** Without sourceIds, every source imported from Zotero is refreshed. */
export const ScientSourcesZoteroRefreshRequest = Schema.Struct({
  root: NonEmptyString,
  sourceIds: Schema.optionalKey(BoundedSourceIds),
  connection: Schema.optionalKey(ZoteroConnection),
  useZotero: Schema.optionalKey(RefreshFields),
  keepLocal: Schema.optionalKey(RefreshFields),
});
export type ScientSourcesZoteroRefreshRequest = typeof ScientSourcesZoteroRefreshRequest.Type;

/** Without a groupId, sources go to My Library. */
export const ScientSourcesZoteroSendRequest = Schema.Struct({
  root: NonEmptyString,
  sourceIds: BoundedSourceIds,
  groupId: Schema.optionalKey(ZoteroGroupId),
});
export type ScientSourcesZoteroSendRequest = typeof ScientSourcesZoteroSendRequest.Type;

export const ZoteroLibraryRequest = Schema.Struct({
  scope: ZoteroImportScope,
  query: Schema.String,
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  limit: BoundedPageSize,
  connection: Schema.optionalKey(ZoteroConnection),
  groupId: Schema.optionalKey(ZoteroGroupId),
});
export type ZoteroLibraryRequest = typeof ZoteroLibraryRequest.Type;

export const ZoteroCollectionsRequest = Schema.Struct({
  connection: Schema.optionalKey(ZoteroConnection),
  groupId: Schema.optionalKey(ZoteroGroupId),
});
export type ZoteroCollectionsRequest = typeof ZoteroCollectionsRequest.Type;

export const ZoteroScopedImportRequest = Schema.Struct({
  root: NonEmptyString,
  operationId: NonEmptyString,
  scope: ZoteroImportScope,
  connection: Schema.optionalKey(ZoteroConnection),
  groupId: Schema.optionalKey(ZoteroGroupId),
});
export type ZoteroScopedImportRequest = typeof ZoteroScopedImportRequest.Type;

export const ScientSourcesPreflightRequest = Schema.Struct({
  root: NonEmptyString,
  itemKeys: Schema.Array(NonEmptyString).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  ),
  connection: Schema.optionalKey(ZoteroConnection),
  groupId: Schema.optionalKey(ZoteroGroupId),
});
export type ScientSourcesPreflightRequest = typeof ScientSourcesPreflightRequest.Type;

export const ScientSourcesPreflightResult = Schema.Struct({
  items: Schema.Array(ScientSourcePreflightItem),
});
export type ScientSourcesPreflightResult = typeof ScientSourcesPreflightResult.Type;

export const ScientSourcesLocalPdfUploadRequest = Schema.Struct({
  root: NonEmptyString,
  file: Multipart.SingleFileSchema,
}).pipe(
  HttpApiSchema.asMultipart({
    maxParts: 2,
    maxFieldSize: 16 * 1024,
    maxFileSize: 512 * 1024 * 1024,
    maxTotalSize: 512 * 1024 * 1024 + 64 * 1024,
  }),
);
export type ScientSourcesLocalPdfUploadRequest = typeof ScientSourcesLocalPdfUploadRequest.Type;

export const ScientSourcesLocalPdfUploadResult = Schema.Struct({
  item: ScientSourcePreflightItem,
});
export type ScientSourcesLocalPdfUploadResult = typeof ScientSourcesLocalPdfUploadResult.Type;

export const ScientSourcesFileImportRequest = Schema.Struct({
  root: NonEmptyString,
  operationId: NonEmptyString,
  file: Multipart.SingleFileSchema,
  /** The file's path on the server's computer, when the client is that computer; PDFs it links in its folder are attached. */
  sourcePath: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_096))),
}).pipe(
  HttpApiSchema.asMultipart({
    maxParts: 4,
    maxFieldSize: 16 * 1024,
    maxFileSize: 32 * 1024 * 1024,
    maxTotalSize: 32 * 1024 * 1024 + 64 * 1024,
  }),
);
export type ScientSourcesFileImportRequest = typeof ScientSourcesFileImportRequest.Type;

export const ScientSourcesFileImportResult = Schema.Struct({
  operation: Schema.NullOr(ScientSourceImportOperation),
  report: BibliographyImportReport,
});
export type ScientSourcesFileImportResult = typeof ScientSourcesFileImportResult.Type;

export const ScientSourcesExportRequest = Schema.Struct({
  root: NonEmptyString,
  format: BibliographyFormatSchema,
  sourceIds: Schema.optionalKey(
    Schema.Array(NonEmptyString).pipe(Schema.check(Schema.isMaxLength(20_000))),
  ),
  includeNotes: Schema.optionalKey(Schema.Boolean),
});
export type ScientSourcesExportRequest = typeof ScientSourcesExportRequest.Type;

export const ScientSourcesExportResult = Schema.Struct({
  format: BibliographyFormatSchema,
  fileName: NonEmptyString,
  content: Schema.String,
  sourceCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  missingSourceIds: Schema.Array(NonEmptyString),
  /** Details the format has no place for, so the file does not carry them. */
  notKept: Schema.Array(BibliographyFieldLoss),
});
export type ScientSourcesExportResult = typeof ScientSourcesExportResult.Type;

export const ScientSourcesDiscardStagedRequest = ScientSourcesPreflightRequest;
export type ScientSourcesDiscardStagedRequest = typeof ScientSourcesDiscardStagedRequest.Type;

export const ScientSourcesDiscardStagedResult = Schema.Struct({
  discarded: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ScientSourcesDiscardStagedResult = typeof ScientSourcesDiscardStagedResult.Type;

export const ScientSourcesBeginImportRequest = Schema.Struct({
  root: NonEmptyString,
  operationId: NonEmptyString,
  itemKeys: Schema.Array(NonEmptyString).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  ),
  possibleMetadataMatchOverrides: Schema.Array(NonEmptyString).pipe(
    Schema.check(Schema.isMaxLength(500)),
  ),
  connection: Schema.optionalKey(ZoteroConnection),
  groupId: Schema.optionalKey(ZoteroGroupId),
});
export type ScientSourcesBeginImportRequest = typeof ScientSourcesBeginImportRequest.Type;

export const ScientSourcesAdvanceImportRequest = Schema.Struct({
  root: NonEmptyString,
  operationId: NonEmptyString,
});
export type ScientSourcesAdvanceImportRequest = typeof ScientSourcesAdvanceImportRequest.Type;

export const ScientSourcesCancelImportRequest = ScientSourcesAdvanceImportRequest;
export type ScientSourcesCancelImportRequest = typeof ScientSourcesCancelImportRequest.Type;

export const ScientSourcesRetryImportRequest = Schema.Struct({
  root: NonEmptyString,
  operationId: NonEmptyString,
  itemKeys: Schema.Array(NonEmptyString).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  ),
});
export type ScientSourcesRetryImportRequest = typeof ScientSourcesRetryImportRequest.Type;

export {
  ScientSourceImportOperation,
  ScientSourcesBulkResult,
  ScientSourcesOrganizeResult,
  ScientSystematicReviewChangeResult,
  ScientSystematicReviewList,
  ScientSourceMetadataUpdateResult,
  ScientSourcePermanentDeletionResult,
  ScientSourceRemovalResult,
  ScientSourceRestoreResult,
  ScientSourceRevertResult,
  ScientSourceTrashListing,
  ScientSourceZoteroRefreshField,
  ScientSourceZoteroRefreshResult,
  ScientSourceZoteroSendResult,
  ZoteroConnection,
  ZoteroConnectionStatus,
  ZoteroCollection,
  ZoteroCollectionsResult,
  ZoteroGroup,
  ZoteroGroupId,
  ZoteroImportScope,
  ZoteroLibraryPage,
};
export const ScientSourceRecordDiagnostics = Schema.Struct({
  sourceId: NonEmptyString,
  diagnostics: Schema.Array(ScientSourceMetadataDiagnostic),
});
export type ScientSourceRecordDiagnostics = typeof ScientSourceRecordDiagnostics.Type;

export const ScientSourcesOverviewResult = Schema.Struct({
  ...ScientSourcesStoreOverview.fields,
  records: Schema.Array(ScientSourceSummary),
  recordDiagnostics: Schema.Array(ScientSourceRecordDiagnostics),
  // Optional so a client can read an older server's overview.
  organization: Schema.optionalKey(ScientSourcesOrganization),
});
export type ScientSourcesOverviewResult = typeof ScientSourcesOverviewResult.Type;
