import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import type {
  EnvironmentAuthenticatedAuth as EnvironmentAuthenticatedAuthMiddleware,
  EnvironmentAuthInvalidError as EnvironmentAuthInvalidErrorSchema,
  EnvironmentHttpCommonError as EnvironmentHttpCommonErrorSchema,
  EnvironmentInternalError as EnvironmentInternalErrorSchema,
  EnvironmentOperationForbiddenError as EnvironmentOperationForbiddenErrorSchema,
  EnvironmentRequestInvalidError as EnvironmentRequestInvalidErrorSchema,
  EnvironmentResourceNotFoundError as EnvironmentResourceNotFoundErrorSchema,
  EnvironmentScopeRequiredError as EnvironmentScopeRequiredErrorSchema,
} from "../environmentHttp.ts";
import {
  ScientProjectInspectRequest,
  ScientProjectInspection,
  ScientProjectInitializeRequest,
  ScientProjectInitializationResult,
} from "../scientProject.ts";
import {
  ScientSourceImportOperation,
  ScientSourceAttachmentPreviewRequest,
  ScientSourceAttachmentPreviewResult,
  ScientSourceDetailRequest,
  ScientSourceDetailResult,
  ScientSourceJournalIconRequest,
  ScientSourceJournalIconResult,
  ScientSourceMetadataRefreshRequest,
  ScientSourceMetadataRefreshResult,
  ScientSourceMetadataUpdateRequest,
  ScientSourceMetadataUpdateResult,
  ScientSourceNoteUpdateRequest,
  ScientSourceReviewUpdateRequest,
  ScientSourceNoteUpdateResult,
  ScientSourceReviewUpdateResult,
  ScientSourceRemovalRequest,
  ScientSourceRemovalResult,
  ScientSourcesAdvanceImportRequest,
  ScientSourcesBeginImportRequest,
  ScientSourcesCancelImportRequest,
  ScientSourcesRetryImportRequest,
  ScientSourcesDiscardStagedRequest,
  ScientSourcesDiscardStagedResult,
  ScientSourcesLocalPdfUploadRequest,
  ScientSourcesLocalPdfUploadResult,
  ScientSourcesOverviewResult,
  ScientSourcesOverviewRequest,
  ScientSourcesPreflightRequest,
  ScientSourcesPreflightResult,
  ZoteroConnectionStatus,
  ZoteroCollectionsRequest,
  ZoteroCollectionsResult,
  ZoteroLibraryPage,
  ZoteroLibraryRequest,
  ZoteroScopedImportRequest,
  ZoteroStatusRequest,
} from "../scientSources.ts";
import {
  ScientLatexBuildRequest,
  ScientLatexBuildSnapshot,
  ScientLatexCancelRequest,
  ScientLatexForwardSyncRequest,
  ScientLatexForwardSyncResult,
  ScientLatexInverseSyncRequest,
  ScientLatexInverseSyncResult,
  ScientLatexManagedInstallState,
  ScientLatexResolveRequest,
  ScientLatexResolveResult,
  ScientLatexStatusRequest,
  ScientLatexToolchainReport,
  ScientLatexToolchainRequest,
} from "../scientLatex.ts";
import {
  ScientMarkdownImageConflictError,
  ScientMarkdownImageInvalidError,
  ScientMarkdownImageTooLargeError,
  ScientMarkdownImageUploadRequest,
  ScientMarkdownImageUploadResult,
} from "../scientMarkdown.ts";
import {
  ScientAnalyticsDeletionResult,
  ScientAnalyticsPreferenceUpdate,
  ScientAnalyticsRecordResult,
  ScientAnalyticsStatus,
  ScientAnalyticsUiEvent,
} from "../scientAnalytics.ts";
import {
  ScientThreadQueueEnqueueRequest,
  ScientThreadQueueListRequest,
  ScientThreadQueueControlRequest,
  ScientThreadQueueRemoveRequest,
  ScientThreadQueueReorderRequest,
  ScientThreadQueueSnapshot,
  ScientThreadQueueUpdateRequest,
} from "../scientThreadQueue.ts";
import {
  ScientPandocToolStatus,
  ScientWordExportError,
  ScientWordFileExportRequest,
  ScientWordLatexExportRequest,
  ScientWordFileExportResult,
} from "../scientPandoc.ts";
import {
  ScientConversationExportError,
  ScientConversationExportPreparation,
  ScientConversationExportPrepareRequest,
  ScientConversationExportRequest,
  ScientConversationExportResult,
  ScientWordDiagramPlan,
} from "../scientConversationExport.ts";
import {
  ScientConversationImportCancelRequest,
  ScientConversationImportCancelResult,
  ScientConversationImportConfirmRequest,
  ScientConversationImportCreateUploadRequest,
  ScientConversationImportError,
  ScientConversationImportPreview,
  ScientConversationImportPreviewRequest,
  ScientConversationImportResult,
  ScientConversationImportUpload,
} from "../scientConversationImport.ts";

/** Scient reasons inside environmentHttp's EnvironmentInternalErrorReason, in wire order. */
export const SCIENT_ENVIRONMENT_INTERNAL_ERROR_REASONS = [
  "orchestration_dispatch_failed",
  "scient_project_inspection_failed",
  "scient_project_initialization_failed",
  "scient_sources_operation_failed",
  "scient_latex_build_failed",
  "scient_latex_navigation_failed",
  "scient_latex_toolchain_failed",
  "scient_latex_install_failed",
  "scient_markdown_operation_failed",
  "scient_analytics_consent_update_failed",
  "scient_analytics_deletion_failed",
  "scient_thread_queue_operation_failed",
  "scient_conversation_export_failed",
  "scient_conversation_import_failed",
  "scient_word_export_failed",
] as const;

export class ScientThreadQueueOperationError extends Schema.TaggedError<ScientThreadQueueOperationError>()(
  "ScientThreadQueueOperationError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(ScientThreadQueueOperationError)(this, { status: 409 });
  }
}

/**
 * Builds the Scient-owned environment HTTP groups from the inherited
 * environment HTTP seams. environmentHttp.ts passes its own headers, errors and
 * middleware so the groups keep the exact schemas and middleware identity.
 */
export function makeScientEnvironmentHttpGroups({
  OptionalBearerHeaders,
  EnvironmentHttpCommonError,
  EnvironmentAuthenticatedAuth,
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
}: {
  readonly OptionalBearerHeaders: Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly dpop: Schema.optionalKey<Schema.String>;
  }>;
  readonly EnvironmentHttpCommonError: typeof EnvironmentHttpCommonErrorSchema;
  readonly EnvironmentAuthenticatedAuth: typeof EnvironmentAuthenticatedAuthMiddleware;
  readonly EnvironmentRequestInvalidError: typeof EnvironmentRequestInvalidErrorSchema;
  readonly EnvironmentAuthInvalidError: typeof EnvironmentAuthInvalidErrorSchema;
  readonly EnvironmentScopeRequiredError: typeof EnvironmentScopeRequiredErrorSchema;
  readonly EnvironmentOperationForbiddenError: typeof EnvironmentOperationForbiddenErrorSchema;
  readonly EnvironmentResourceNotFoundError: typeof EnvironmentResourceNotFoundErrorSchema;
  readonly EnvironmentInternalError: typeof EnvironmentInternalErrorSchema;
}) {
  // Scient-owned HTTP groups are appended after the inherited environment API
  // groups so upstream can add new first-party groups without editing the same
  // class-definition or composition seams.
  class EnvironmentScientProjectHttpApi extends HttpApiGroup.make("scientProject")
    .add(
      HttpApiEndpoint.post("inspect", "/api/scient/projects/inspect", {
        headers: OptionalBearerHeaders,
        payload: ScientProjectInspectRequest,
        success: ScientProjectInspection,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("initialize", "/api/scient/projects/initialize", {
        headers: OptionalBearerHeaders,
        payload: ScientProjectInitializeRequest,
        success: ScientProjectInitializationResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    ) {}

  class EnvironmentScientSourcesHttpApi extends HttpApiGroup.make("scientSources")
    .add(
      HttpApiEndpoint.post("overview", "/api/scient/sources/overview", {
        headers: OptionalBearerHeaders,
        payload: ScientSourcesOverviewRequest,
        success: ScientSourcesOverviewResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("detail", "/api/scient/sources/detail", {
        headers: OptionalBearerHeaders,
        payload: ScientSourceDetailRequest,
        success: ScientSourceDetailResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("attachmentPreview", "/api/scient/sources/attachments/preview", {
        headers: OptionalBearerHeaders,
        payload: ScientSourceAttachmentPreviewRequest,
        success: ScientSourceAttachmentPreviewResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("journalIcon", "/api/scient/sources/journal-icon", {
        headers: OptionalBearerHeaders,
        payload: ScientSourceJournalIconRequest,
        success: ScientSourceJournalIconResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("refreshMetadata", "/api/scient/sources/metadata/refresh", {
        headers: OptionalBearerHeaders,
        payload: ScientSourceMetadataRefreshRequest,
        success: ScientSourceMetadataRefreshResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("updateMetadata", "/api/scient/sources/metadata/update", {
        headers: OptionalBearerHeaders,
        payload: ScientSourceMetadataUpdateRequest,
        success: ScientSourceMetadataUpdateResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("updateNote", "/api/scient/sources/note/update", {
        headers: OptionalBearerHeaders,
        payload: ScientSourceNoteUpdateRequest,
        success: ScientSourceNoteUpdateResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("updateReview", "/api/scient/sources/review/update", {
        headers: OptionalBearerHeaders,
        payload: ScientSourceReviewUpdateRequest,
        success: ScientSourceReviewUpdateResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("remove", "/api/scient/sources/remove", {
        headers: OptionalBearerHeaders,
        payload: ScientSourceRemovalRequest,
        success: ScientSourceRemovalResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("zoteroStatus", "/api/scient/sources/zotero/status", {
        headers: OptionalBearerHeaders,
        payload: ZoteroStatusRequest,
        success: ZoteroConnectionStatus,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("zoteroLibrary", "/api/scient/sources/zotero/library", {
        headers: OptionalBearerHeaders,
        payload: ZoteroLibraryRequest,
        success: ZoteroLibraryPage,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("zoteroCollections", "/api/scient/sources/zotero/collections", {
        headers: OptionalBearerHeaders,
        payload: ZoteroCollectionsRequest,
        success: ZoteroCollectionsResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("preflight", "/api/scient/sources/import/preflight", {
        headers: OptionalBearerHeaders,
        payload: ScientSourcesPreflightRequest,
        success: ScientSourcesPreflightResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("localPdfUpload", "/api/scient/sources/local-files/upload", {
        headers: OptionalBearerHeaders,
        payload: ScientSourcesLocalPdfUploadRequest,
        success: ScientSourcesLocalPdfUploadResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("localBeginImport", "/api/scient/sources/local-files/import/begin", {
        headers: OptionalBearerHeaders,
        payload: ScientSourcesBeginImportRequest,
        success: ScientSourceImportOperation,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("localDiscard", "/api/scient/sources/local-files/discard", {
        headers: OptionalBearerHeaders,
        payload: ScientSourcesDiscardStagedRequest,
        success: ScientSourcesDiscardStagedResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("beginImport", "/api/scient/sources/import/begin", {
        headers: OptionalBearerHeaders,
        payload: ScientSourcesBeginImportRequest,
        success: ScientSourceImportOperation,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("beginScopedImport", "/api/scient/sources/zotero/import-scope/begin", {
        headers: OptionalBearerHeaders,
        payload: ZoteroScopedImportRequest,
        success: ScientSourceImportOperation,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("advanceImport", "/api/scient/sources/import/advance", {
        headers: OptionalBearerHeaders,
        payload: ScientSourcesAdvanceImportRequest,
        success: ScientSourceImportOperation,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("cancelImport", "/api/scient/sources/import/cancel", {
        headers: OptionalBearerHeaders,
        payload: ScientSourcesCancelImportRequest,
        success: ScientSourceImportOperation,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("retryImport", "/api/scient/sources/import/retry", {
        headers: OptionalBearerHeaders,
        payload: ScientSourcesRetryImportRequest,
        success: ScientSourceImportOperation,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    ) {}

  class EnvironmentScientLatexHttpApi extends HttpApiGroup.make("scientLatex")
    .add(
      HttpApiEndpoint.post("imageUpload", "/api/scient/latex/images/upload", {
        headers: OptionalBearerHeaders,
        payload: ScientMarkdownImageUploadRequest,
        success: ScientMarkdownImageUploadResult,
        error: [
          EnvironmentRequestInvalidError,
          EnvironmentAuthInvalidError,
          EnvironmentScopeRequiredError,
          EnvironmentOperationForbiddenError,
          EnvironmentResourceNotFoundError,
          EnvironmentInternalError,
          ScientMarkdownImageInvalidError,
          ScientMarkdownImageTooLargeError,
          ScientMarkdownImageConflictError,
        ],
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("resolve", "/api/scient/latex/resolve", {
        headers: OptionalBearerHeaders,
        payload: ScientLatexResolveRequest,
        success: ScientLatexResolveResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("build", "/api/scient/latex/build", {
        headers: OptionalBearerHeaders,
        payload: ScientLatexBuildRequest,
        success: ScientLatexBuildSnapshot,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("status", "/api/scient/latex/status", {
        headers: OptionalBearerHeaders,
        payload: ScientLatexStatusRequest,
        success: ScientLatexBuildSnapshot,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("cancel", "/api/scient/latex/cancel", {
        headers: OptionalBearerHeaders,
        payload: ScientLatexCancelRequest,
        success: ScientLatexBuildSnapshot,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("forwardSync", "/api/scient/latex/synctex/forward", {
        headers: OptionalBearerHeaders,
        payload: ScientLatexForwardSyncRequest,
        success: ScientLatexForwardSyncResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("inverseSync", "/api/scient/latex/synctex/inverse", {
        headers: OptionalBearerHeaders,
        payload: ScientLatexInverseSyncRequest,
        success: ScientLatexInverseSyncResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("toolchain", "/api/scient/latex/toolchain", {
        headers: OptionalBearerHeaders,
        payload: ScientLatexToolchainRequest,
        success: ScientLatexToolchainReport,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      // Begins the managed install and answers with the state it left behind; the
      // toolchain endpoint is what clients poll to watch it finish.
      HttpApiEndpoint.post("installToolchain", "/api/scient/latex/toolchain/install", {
        headers: OptionalBearerHeaders,
        success: ScientLatexManagedInstallState,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    ) {}

  class EnvironmentScientMarkdownHttpApi extends HttpApiGroup.make("scientMarkdown").add(
    HttpApiEndpoint.post("imageUpload", "/api/scient/markdown/images/upload", {
      headers: OptionalBearerHeaders,
      payload: ScientMarkdownImageUploadRequest,
      success: ScientMarkdownImageUploadResult,
      error: [
        EnvironmentRequestInvalidError,
        EnvironmentAuthInvalidError,
        EnvironmentScopeRequiredError,
        EnvironmentOperationForbiddenError,
        EnvironmentResourceNotFoundError,
        EnvironmentInternalError,
        ScientMarkdownImageInvalidError,
        ScientMarkdownImageTooLargeError,
        ScientMarkdownImageConflictError,
      ],
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

  class EnvironmentScientAnalyticsHttpApi extends HttpApiGroup.make("scientAnalytics")
    .add(
      HttpApiEndpoint.get("status", "/api/scient/analytics/status", {
        headers: OptionalBearerHeaders,
        success: ScientAnalyticsStatus,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("preferences", "/api/scient/analytics/preferences", {
        headers: OptionalBearerHeaders,
        payload: ScientAnalyticsPreferenceUpdate,
        success: ScientAnalyticsStatus,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("record", "/api/scient/analytics/events", {
        headers: OptionalBearerHeaders,
        payload: ScientAnalyticsUiEvent,
        success: ScientAnalyticsRecordResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("deleteData", "/api/scient/analytics/delete", {
        headers: OptionalBearerHeaders,
        success: ScientAnalyticsDeletionResult,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    ) {}

  // Scient thread queue group. Appended after inherited
  // groups like the other Scient groups so upstream additions never collide
  // with this class or the composition seam below.

  class EnvironmentScientThreadQueueHttpApi extends HttpApiGroup.make("scientThreadQueue")
    .add(
      HttpApiEndpoint.post("list", "/api/scient/thread-queue/v2/list", {
        headers: OptionalBearerHeaders,
        payload: ScientThreadQueueListRequest,
        success: ScientThreadQueueSnapshot,
        error: [EnvironmentHttpCommonError, ScientThreadQueueOperationError],
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("enqueue", "/api/scient/thread-queue/v2/enqueue", {
        headers: OptionalBearerHeaders,
        payload: ScientThreadQueueEnqueueRequest,
        success: ScientThreadQueueSnapshot,
        error: [EnvironmentHttpCommonError, ScientThreadQueueOperationError],
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("update", "/api/scient/thread-queue/v2/update", {
        headers: OptionalBearerHeaders,
        payload: ScientThreadQueueUpdateRequest,
        success: ScientThreadQueueSnapshot,
        error: [EnvironmentHttpCommonError, ScientThreadQueueOperationError],
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("remove", "/api/scient/thread-queue/v2/remove", {
        headers: OptionalBearerHeaders,
        payload: ScientThreadQueueRemoveRequest,
        success: ScientThreadQueueSnapshot,
        error: [EnvironmentHttpCommonError, ScientThreadQueueOperationError],
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("reorder", "/api/scient/thread-queue/v2/reorder", {
        headers: OptionalBearerHeaders,
        payload: ScientThreadQueueReorderRequest,
        success: ScientThreadQueueSnapshot,
        error: [EnvironmentHttpCommonError, ScientThreadQueueOperationError],
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("control", "/api/scient/thread-queue/v2/control", {
        headers: OptionalBearerHeaders,
        payload: ScientThreadQueueControlRequest,
        success: ScientThreadQueueSnapshot,
        error: [EnvironmentHttpCommonError, ScientThreadQueueOperationError],
      }).middleware(EnvironmentAuthenticatedAuth),
    ) {}

  // Scient conversation export group, appended like the
  // thread queue group so upstream additions never collide with it.
  class EnvironmentScientConversationExportHttpApi extends HttpApiGroup.make(
    "scientConversationExport",
  )
    .add(
      HttpApiEndpoint.post("prepare", "/api/scient/conversation-export/v1/prepare", {
        headers: OptionalBearerHeaders,
        payload: ScientConversationExportPrepareRequest,
        success: ScientConversationExportPreparation,
        error: [EnvironmentHttpCommonError, ScientConversationExportError],
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post(
        "prepareWordDiagrams",
        "/api/scient/conversation-export/v1/word-diagrams",
        {
          headers: OptionalBearerHeaders,
          payload: ScientConversationExportRequest,
          success: ScientWordDiagramPlan,
          error: [EnvironmentHttpCommonError, ScientConversationExportError],
        },
      ).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("export", "/api/scient/conversation-export/v1/export", {
        headers: OptionalBearerHeaders,
        payload: ScientConversationExportRequest,
        success: ScientConversationExportResult,
        error: [EnvironmentHttpCommonError, ScientConversationExportError],
      }).middleware(EnvironmentAuthenticatedAuth),
    ) {}

  // Scient conversation import group. The file itself is
  // uploaded through the signed URL `createUpload` returns, not through this group.
  // Every handler requires SCIENT_CONVERSATION_IMPORT_REQUIRED_SCOPE.
  class EnvironmentScientConversationImportHttpApi extends HttpApiGroup.make(
    "scientConversationImport",
  )
    .add(
      HttpApiEndpoint.post("createUpload", "/api/scient/conversation-import/v1/create-upload", {
        headers: OptionalBearerHeaders,
        payload: ScientConversationImportCreateUploadRequest,
        success: ScientConversationImportUpload,
        error: [EnvironmentHttpCommonError, ScientConversationImportError],
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("preview", "/api/scient/conversation-import/v1/preview", {
        headers: OptionalBearerHeaders,
        payload: ScientConversationImportPreviewRequest,
        success: ScientConversationImportPreview,
        error: [EnvironmentHttpCommonError, ScientConversationImportError],
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("import", "/api/scient/conversation-import/v1/import", {
        headers: OptionalBearerHeaders,
        payload: ScientConversationImportConfirmRequest,
        success: ScientConversationImportResult,
        error: [EnvironmentHttpCommonError, ScientConversationImportError],
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("cancel", "/api/scient/conversation-import/v1/cancel", {
        headers: OptionalBearerHeaders,
        payload: ScientConversationImportCancelRequest,
        success: ScientConversationImportCancelResult,
        error: [EnvironmentHttpCommonError, ScientConversationImportError],
      }).middleware(EnvironmentAuthenticatedAuth),
    ) {}

  // Scient Word export group: the managed Pandoc tool and
  // project-file export, appended like the other Scient groups.
  class EnvironmentScientWordExportHttpApi extends HttpApiGroup.make("scientWordExport")
    .add(
      HttpApiEndpoint.post("tool", "/api/scient/word-export/v1/tool", {
        headers: OptionalBearerHeaders,
        success: ScientPandocToolStatus,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      // Begins the managed install and answers with the state it left; clients
      // poll `tool` to watch it finish.
      HttpApiEndpoint.post("installTool", "/api/scient/word-export/v1/tool/install", {
        headers: OptionalBearerHeaders,
        success: ScientPandocToolStatus,
        error: EnvironmentHttpCommonError,
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("prepareFileDiagrams", "/api/scient/word-export/v1/file-diagrams", {
        headers: OptionalBearerHeaders,
        payload: ScientWordFileExportRequest,
        success: ScientWordDiagramPlan,
        error: [EnvironmentHttpCommonError, ScientWordExportError],
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("exportFile", "/api/scient/word-export/v1/file", {
        headers: OptionalBearerHeaders,
        payload: ScientWordFileExportRequest,
        success: ScientWordFileExportResult,
        error: [EnvironmentHttpCommonError, ScientWordExportError],
      }).middleware(EnvironmentAuthenticatedAuth),
    )
    .add(
      HttpApiEndpoint.post("exportLatex", "/api/scient/word-export/v1/latex", {
        headers: OptionalBearerHeaders,
        payload: ScientWordLatexExportRequest,
        success: ScientWordFileExportResult,
        error: [EnvironmentHttpCommonError, ScientWordExportError],
      }).middleware(EnvironmentAuthenticatedAuth),
    ) {}

  return {
    EnvironmentScientProjectHttpApi,
    EnvironmentScientSourcesHttpApi,
    EnvironmentScientLatexHttpApi,
    EnvironmentScientMarkdownHttpApi,
    EnvironmentScientAnalyticsHttpApi,
    EnvironmentScientThreadQueueHttpApi,
    EnvironmentScientConversationExportHttpApi,
    EnvironmentScientConversationImportHttpApi,
    EnvironmentScientWordExportHttpApi,
  };
}
