import {
  ScientSourceImportOperation,
  ScientSourceMetadataDiagnostic,
  ScientSourcePreflightItem,
  ScientSourcesOverview as ScientSourcesStoreOverview,
  ZoteroConnectionStatus,
  ZoteroLibraryPage,
} from "@scientfactory/scient-sources";
import * as Schema from "effect/Schema";

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty());
const BoundedPageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));

export const ScientSourcesOverviewRequest = Schema.Struct({ root: NonEmptyString });
export type ScientSourcesOverviewRequest = typeof ScientSourcesOverviewRequest.Type;

export const ZoteroStatusRequest = Schema.Struct({});
export type ZoteroStatusRequest = typeof ZoteroStatusRequest.Type;

export const ZoteroLibraryRequest = Schema.Struct({
  query: Schema.String,
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  limit: BoundedPageSize,
});
export type ZoteroLibraryRequest = typeof ZoteroLibraryRequest.Type;

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

export const ScientSourcesBeginImportRequest = Schema.Struct({
  root: NonEmptyString,
  operationId: NonEmptyString,
  itemKeys: Schema.Array(NonEmptyString).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
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

export { ScientSourceImportOperation, ZoteroConnectionStatus, ZoteroLibraryPage };
export const ScientSourceAttachmentLocation = Schema.Struct({
  attachmentId: NonEmptyString,
  absolutePath: NonEmptyString,
});
export type ScientSourceAttachmentLocation = typeof ScientSourceAttachmentLocation.Type;

export const ScientSourceRecordDiagnostics = Schema.Struct({
  sourceId: NonEmptyString,
  diagnostics: Schema.Array(ScientSourceMetadataDiagnostic),
});
export type ScientSourceRecordDiagnostics = typeof ScientSourceRecordDiagnostics.Type;

export const ScientSourcesOverviewResult = Schema.Struct({
  ...ScientSourcesStoreOverview.fields,
  attachmentLocations: Schema.Array(ScientSourceAttachmentLocation),
  recordDiagnostics: Schema.Array(ScientSourceRecordDiagnostics),
});
export type ScientSourcesOverviewResult = typeof ScientSourcesOverviewResult.Type;
