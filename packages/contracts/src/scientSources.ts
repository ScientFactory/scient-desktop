import {
  ScientSourceEditableMetadata,
  ScientSourceImportOperation,
  ScientSourceMetadataDiagnostic,
  ScientSourceMetadataUpdateResult,
  ScientSourceNote,
  ScientSourceNoteUpdateResult,
  ScientSourceReviewUpdateResult,
  ScientSourceRecord,
  ScientSourceRemovalResult,
  ScientSourceSummary,
  ScientSourcePreflightItem,
  ScientSourcesOverview as ScientSourcesStoreOverview,
  ZoteroConnectionStatus,
  ZoteroCollection,
  ZoteroCollectionsResult,
  ZoteroImportScope,
  ZoteroLibraryPage,
} from "@scientfactory/scient-sources";
import * as Schema from "effect/Schema";
import * as Multipart from "effect/unstable/http/Multipart";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

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

export const ScientSourceAttachmentPreviewResult = AssetCreateUrlResult;
export type ScientSourceAttachmentPreviewResult = typeof ScientSourceAttachmentPreviewResult.Type;

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

export const ScientSourceReviewUpdateRequest = Schema.Struct({
  root: NonEmptyString,
  sourceId: NonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  review: Schema.Literal("none"),
});
export type ScientSourceReviewUpdateRequest = typeof ScientSourceReviewUpdateRequest.Type;
export { ScientSourceReviewUpdateResult };

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

export const ZoteroStatusRequest = Schema.Struct({});
export type ZoteroStatusRequest = typeof ZoteroStatusRequest.Type;

export const ZoteroLibraryRequest = Schema.Struct({
  scope: ZoteroImportScope,
  query: Schema.String,
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  limit: BoundedPageSize,
});
export type ZoteroLibraryRequest = typeof ZoteroLibraryRequest.Type;

export const ZoteroCollectionsRequest = Schema.Struct({});
export type ZoteroCollectionsRequest = typeof ZoteroCollectionsRequest.Type;

export const ZoteroScopedImportRequest = Schema.Struct({
  root: NonEmptyString,
  operationId: NonEmptyString,
  scope: ZoteroImportScope,
});
export type ZoteroScopedImportRequest = typeof ZoteroScopedImportRequest.Type;

export const ScientSourcesPreflightRequest = Schema.Struct({
  root: NonEmptyString,
  itemKeys: Schema.Array(NonEmptyString).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  ),
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
  ScientSourceMetadataUpdateResult,
  ScientSourceRemovalResult,
  ZoteroConnectionStatus,
  ZoteroCollection,
  ZoteroCollectionsResult,
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
});
export type ScientSourcesOverviewResult = typeof ScientSourcesOverviewResult.Type;
