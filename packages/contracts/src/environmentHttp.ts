import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  AuthAccessTokenResult,
  AuthBrowserSessionRequest,
  AuthBrowserSessionResult,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthPairingCredentialResult,
  AuthPairingLink,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthEnvironmentScope,
  AuthTokenExchangeRequest,
  AuthSessionState,
  AuthWebSocketTicketResult,
  ServerAuthSessionMethod,
} from "./auth.ts";
import { AuthSessionId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  ClientOrchestrationCommand,
  DispatchResult,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
} from "./orchestration.ts";
import {
  PullRequestDiffInput,
  PullRequestDiffResult,
  PullRequestOperationError,
  PullRequestUnavailableError,
} from "./pullRequest.ts";
import {
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialRequest,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentHealthResponse,
  RelayEnvironmentLinkProof,
  RelayEnvironmentMintResponse,
  RelayLinkProofRequest,
} from "./relay.ts";
import {
  ScientProjectInspectRequest,
  ScientProjectInspection,
  ScientProjectInitializeRequest,
  ScientProjectInitializationResult,
} from "./scientProject.ts";
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
} from "./scientSources.ts";
import {
  ScientLatexBuildRequest,
  ScientLatexBuildSnapshot,
  ScientLatexCancelRequest,
  ScientLatexForwardSyncRequest,
  ScientLatexForwardSyncResult,
  ScientLatexInverseSyncRequest,
  ScientLatexInverseSyncResult,
  ScientLatexManagedInstallState,
  ScientLatexStatusRequest,
  ScientLatexToolchainReport,
  ScientLatexToolchainRequest,
} from "./scientLatex.ts";
import {
  ScientAnalyticsDeletionResult,
  ScientAnalyticsPreferenceUpdate,
  ScientAnalyticsRecordResult,
  ScientAnalyticsStatus,
  ScientAnalyticsUiEvent,
} from "./scientAnalytics.ts";
// SCIENT-FORK:START — Scient thread queue contracts.
import {
  ScientThreadQueueEnqueueRequest,
  ScientThreadQueueListRequest,
  ScientThreadQueueRemoveRequest,
  ScientThreadQueueReorderRequest,
  ScientThreadQueueSnapshot,
} from "./scientThreadQueue.ts";
// SCIENT-FORK:END

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

const OptionalDpopProofHeaders = Schema.Struct({
  dpop: Schema.optionalKey(Schema.String),
});

export const EnvironmentRequestInvalidReason = Schema.Literals([
  "invalid_scope",
  "scope_not_granted",
  "invalid_command",
]);
export type EnvironmentRequestInvalidReason = typeof EnvironmentRequestInvalidReason.Type;

export const EnvironmentAuthInvalidReason = Schema.Literals([
  "missing_credential",
  "invalid_credential",
]);
export type EnvironmentAuthInvalidReason = typeof EnvironmentAuthInvalidReason.Type;

export const EnvironmentOperationForbiddenReason = Schema.Literals([
  "current_session_revoke_not_allowed",
]);
export type EnvironmentOperationForbiddenReason = typeof EnvironmentOperationForbiddenReason.Type;

export const EnvironmentInternalErrorReason = Schema.Literals([
  "bootstrap_validation_failed",
  "browser_session_issuance_failed",
  "browser_session_cookie_failed",
  "access_token_issuance_failed",
  "websocket_ticket_issuance_failed",
  "pairing_credential_issuance_failed",
  "pairing_links_load_failed",
  "pairing_link_revoke_failed",
  "client_sessions_load_failed",
  "client_session_revoke_failed",
  "orchestration_snapshot_failed",
  "orchestration_thread_snapshot_failed",
  "orchestration_dispatch_failed",
  "scient_project_inspection_failed",
  "scient_project_initialization_failed",
  "scient_sources_operation_failed",
  "scient_latex_build_failed",
  "scient_latex_navigation_failed",
  "scient_latex_toolchain_failed",
  "scient_latex_install_failed",
  "scient_analytics_consent_update_failed",
  "scient_analytics_deletion_failed",
  // SCIENT-FORK:START
  "scient_thread_queue_operation_failed",
  // SCIENT-FORK:END
  "internal_error",
]);
export type EnvironmentInternalErrorReason = typeof EnvironmentInternalErrorReason.Type;

export class EnvironmentRequestInvalidError extends Schema.TaggedErrorClass<EnvironmentRequestInvalidError>()(
  "EnvironmentRequestInvalidError",
  {
    code: Schema.Literal("invalid_request"),
    reason: EnvironmentRequestInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentRequestInvalidError)(this, { status: 400 });
  }

  override get message(): string {
    return `The environment rejected the request (${this.reason}).`;
  }
}

export class EnvironmentAuthInvalidError extends Schema.TaggedErrorClass<EnvironmentAuthInvalidError>()(
  "EnvironmentAuthInvalidError",
  {
    code: Schema.Literal("auth_invalid"),
    reason: EnvironmentAuthInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentAuthInvalidError)(this, { status: 401 });
  }

  override get message(): string {
    return `The environment rejected this client's credentials (${this.reason}).`;
  }
}

export class EnvironmentScopeRequiredError extends Schema.TaggedErrorClass<EnvironmentScopeRequiredError>()(
  "EnvironmentScopeRequiredError",
  {
    code: Schema.Literal("insufficient_scope"),
    requiredScope: AuthEnvironmentScope,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentScopeRequiredError)(this, { status: 403 });
  }

  override get message(): string {
    return `This request needs the ${this.requiredScope} scope, which this client does not have.`;
  }
}

export class EnvironmentOperationForbiddenError extends Schema.TaggedErrorClass<EnvironmentOperationForbiddenError>()(
  "EnvironmentOperationForbiddenError",
  {
    code: Schema.Literal("operation_forbidden"),
    reason: EnvironmentOperationForbiddenReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentOperationForbiddenError)(this, { status: 403 });
  }

  override get message(): string {
    return `The environment refused this operation (${this.reason}).`;
  }
}

export class EnvironmentInternalError extends Schema.TaggedErrorClass<EnvironmentInternalError>()(
  "EnvironmentInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: EnvironmentInternalErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentInternalError)(this, { status: 500 });
  }

  override get message(): string {
    return `The environment failed to answer this request (${this.reason}).`;
  }
}

export const EnvironmentResourceNotFoundReason = Schema.Literals(["thread_not_found"]);
export type EnvironmentResourceNotFoundReason = typeof EnvironmentResourceNotFoundReason.Type;

export class EnvironmentResourceNotFoundError extends Schema.TaggedErrorClass<EnvironmentResourceNotFoundError>()(
  "EnvironmentResourceNotFoundError",
  {
    code: Schema.Literal("not_found"),
    reason: EnvironmentResourceNotFoundReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 404 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentResourceNotFoundError)(this, { status: 404 });
  }

  override get message(): string {
    return `The environment could not find what this request named (${this.reason}).`;
  }
}

export const EnvironmentHttpCommonError = Schema.Union([
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
]);
export type EnvironmentHttpCommonError = typeof EnvironmentHttpCommonError.Type;

const EnvironmentAuthenticationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;

export class EnvironmentHttpBadRequestError extends Schema.TaggedErrorClass<EnvironmentHttpBadRequestError>()(
  "EnvironmentHttpBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpBadRequestError)(this, { status: 400 });
  }
}

export class EnvironmentHttpUnauthorizedError extends Schema.TaggedErrorClass<EnvironmentHttpUnauthorizedError>()(
  "EnvironmentHttpUnauthorizedError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpUnauthorizedError)(this, { status: 401 });
  }
}

export class EnvironmentHttpForbiddenError extends Schema.TaggedErrorClass<EnvironmentHttpForbiddenError>()(
  "EnvironmentHttpForbiddenError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpForbiddenError)(this, { status: 403 });
  }
}

export class EnvironmentHttpInternalServerError extends Schema.TaggedErrorClass<EnvironmentHttpInternalServerError>()(
  "EnvironmentHttpInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpInternalServerError)(this, { status: 500 });
  }
}

export class EnvironmentHttpConflictError extends Schema.TaggedErrorClass<EnvironmentHttpConflictError>()(
  "EnvironmentHttpConflictError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpConflictError)(this, { status: 409 });
  }
}

export class EnvironmentCloudEndpointUnavailableError extends Schema.TaggedErrorClass<EnvironmentCloudEndpointUnavailableError>()(
  "EnvironmentCloudEndpointUnavailableError",
  {
    message: Schema.String,
    endpointRuntimeStatus: Schema.Unknown,
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentCloudEndpointUnavailableError)(this, {
      status: 503,
    });
  }
}
const EnvironmentSessionCreationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentTokenExchangeErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentScopedOperationErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentPairingCredentialErrors = [
  EnvironmentRequestInvalidError,
  ...EnvironmentScopedOperationErrors,
] as const;
const EnvironmentSessionRevokeErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationThreadSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationDispatchErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;

export interface EnvironmentSessionPrincipalShape {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlySet<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt?: DateTime.DateTime;
}

export class EnvironmentAuthenticatedPrincipal extends Context.Service<
  EnvironmentAuthenticatedPrincipal,
  EnvironmentSessionPrincipalShape
>()("@t3tools/contracts/environmentHttp/EnvironmentAuthenticatedPrincipal") {}

export class EnvironmentAuthenticatedAuth extends HttpApiMiddleware.Service<
  EnvironmentAuthenticatedAuth,
  { provides: EnvironmentAuthenticatedPrincipal }
>()("EnvironmentAuthenticatedAuth", {
  error: EnvironmentAuthenticationErrors,
}) {}

const EnvironmentHttpCloudErrors = [
  EnvironmentHttpBadRequestError,
  EnvironmentHttpUnauthorizedError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpConflictError,
  EnvironmentHttpInternalServerError,
  EnvironmentScopeRequiredError,
] as const;

export const EnvironmentCloudRelayConfigResult = Schema.Struct({
  ok: Schema.Boolean,
  endpointRuntimeStatus: Schema.Unknown,
});
export type EnvironmentCloudRelayConfigResult = typeof EnvironmentCloudRelayConfigResult.Type;

export const EnvironmentCloudLinkStateResult = Schema.Struct({
  linked: Schema.Boolean,
  cloudUserId: Schema.NullOr(Schema.String),
  relayUrl: Schema.NullOr(Schema.String),
  relayIssuer: Schema.NullOr(Schema.String),
  // A managed Cloudflare tunnel is provisioned for this link. False for a
  // publish-only link (activity publishing without a relay-managed tunnel), so
  // clients can present the two capabilities as independent settings.
  // Optional so newer clients tolerate older environment servers.
  managedTunnelActive: Schema.optional(Schema.Boolean),
  publishAgentActivity: Schema.Boolean,
});
export type EnvironmentCloudLinkStateResult = typeof EnvironmentCloudLinkStateResult.Type;

export const EnvironmentCloudPreferencesRequest = Schema.Struct({
  publishAgentActivity: Schema.Boolean,
});
export type EnvironmentCloudPreferencesRequest = typeof EnvironmentCloudPreferencesRequest.Type;

export const AuthPairingLinkRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthPairingLinkRevokeResult = typeof AuthPairingLinkRevokeResult.Type;

export const AuthClientSessionRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthClientSessionRevokeResult = typeof AuthClientSessionRevokeResult.Type;

export const AuthOtherClientSessionsRevokeResult = Schema.Struct({
  revokedCount: Schema.Number,
});
export type AuthOtherClientSessionsRevokeResult = typeof AuthOtherClientSessionsRevokeResult.Type;

export class EnvironmentMetadataHttpApi extends HttpApiGroup.make("metadata").add(
  HttpApiEndpoint.get("descriptor", "/.well-known/t3/environment", {
    success: ExecutionEnvironmentDescriptor,
  }),
) {}

export class EnvironmentAuthHttpApi extends HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.get("session", "/api/auth/session", {
      headers: OptionalBearerHeaders,
      success: AuthSessionState,
      error: [EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("browserSession", "/api/auth/browser-session", {
      payload: AuthBrowserSessionRequest,
      success: AuthBrowserSessionResult,
      error: EnvironmentSessionCreationErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("token", "/oauth/token", {
      headers: OptionalDpopProofHeaders,
      payload: AuthTokenExchangeRequest,
      success: AuthAccessTokenResult,
      error: EnvironmentTokenExchangeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("webSocketTicket", "/api/auth/websocket-ticket", {
      headers: OptionalBearerHeaders,
      success: AuthWebSocketTicketResult,
      error: [EnvironmentInternalError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("pairingCredential", "/api/auth/pairing-token", {
      headers: OptionalBearerHeaders,
      payload: AuthCreatePairingCredentialInput,
      success: AuthPairingCredentialResult,
      error: EnvironmentPairingCredentialErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("pairingLinks", "/api/auth/pairing-links", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(AuthPairingLink),
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokePairingLink", "/api/auth/pairing-links/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokePairingLinkInput,
      success: AuthPairingLinkRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("clients", "/api/auth/clients", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(AuthClientSession),
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeClient", "/api/auth/clients/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokeClientSessionInput,
      success: AuthClientSessionRevokeResult,
      error: EnvironmentSessionRevokeErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeOtherClients", "/api/auth/clients/revoke-others", {
      headers: OptionalBearerHeaders,
      success: AuthOtherClientSessionsRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

const EnvironmentOrchestrationThreadSnapshotParams = Schema.Struct({
  threadId: ThreadId,
});

// Query-string window for windowed thread snapshots (GET payloads must encode
// to strings). Both fields optional: omitting them keeps the full-snapshot
// behavior, so pagination stays opt-in per request.
const EnvironmentOrchestrationThreadSnapshotQuery = {
  turnLimit: Schema.optional(
    Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ),
  beforeCursor: Schema.optional(TrimmedNonEmptyString),
};

export class EnvironmentOrchestrationHttpApi extends HttpApiGroup.make("orchestration")
  .add(
    HttpApiEndpoint.get("snapshot", "/api/orchestration/snapshot", {
      headers: OptionalBearerHeaders,
      success: OrchestrationReadModel,
      error: EnvironmentOrchestrationSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("shellSnapshot", "/api/orchestration/shell", {
      headers: OptionalBearerHeaders,
      success: OrchestrationShellSnapshot,
      error: EnvironmentOrchestrationSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadSnapshot", "/api/orchestration/threads/:threadId", {
      headers: OptionalBearerHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      payload: EnvironmentOrchestrationThreadSnapshotQuery,
      success: OrchestrationThreadDetailSnapshot,
      error: EnvironmentOrchestrationThreadSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("dispatch", "/api/orchestration/dispatch", {
      headers: OptionalBearerHeaders,
      payload: ClientOrchestrationCommand,
      success: DispatchResult,
      error: EnvironmentOrchestrationDispatchErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

/** Large, compressible pull-request payloads travel over HTTP rather than the RPC socket. */
export class EnvironmentPullRequestsHttpApi extends HttpApiGroup.make("pullRequests").add(
  HttpApiEndpoint.post("diff", "/api/pull-requests/diff", {
    headers: OptionalBearerHeaders,
    payload: PullRequestDiffInput,
    success: PullRequestDiffResult,
    error: [
      PullRequestUnavailableError,
      PullRequestOperationError,
      EnvironmentAuthInvalidError,
      EnvironmentScopeRequiredError,
      EnvironmentInternalError,
    ],
  }).middleware(EnvironmentAuthenticatedAuth),
) {}

export class EnvironmentConnectHttpApi extends HttpApiGroup.make("connect")
  .add(
    HttpApiEndpoint.post("linkProof", "/api/connect/link-proof", {
      headers: OptionalBearerHeaders,
      payload: RelayLinkProofRequest,
      success: RelayEnvironmentLinkProof,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("relayConfig", "/api/connect/relay-config", {
      headers: OptionalBearerHeaders,
      payload: RelayEnvironmentConfigRequest,
      success: EnvironmentCloudRelayConfigResult,
      error: [...EnvironmentHttpCloudErrors, EnvironmentCloudEndpointUnavailableError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("linkState", "/api/connect/link-state", {
      headers: OptionalBearerHeaders,
      success: EnvironmentCloudLinkStateResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("unlink", "/api/connect/unlink", {
      headers: OptionalBearerHeaders,
      success: EnvironmentCloudRelayConfigResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("preferences", "/api/connect/preferences", {
      headers: OptionalBearerHeaders,
      payload: EnvironmentCloudPreferencesRequest,
      success: EnvironmentCloudLinkStateResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("health", "/api/t3-connect/health", {
      payload: RelayCloudEnvironmentHealthRequest,
      success: RelayEnvironmentHealthResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("mintCredential", "/api/connect/mint-credential", {
      payload: RelayCloudMintCredentialRequest,
      success: RelayEnvironmentMintResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("t3MintCredential", "/api/t3-connect/mint-credential", {
      payload: RelayCloudMintCredentialRequest,
      success: RelayEnvironmentMintResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  ) {}

// Scient-owned HTTP groups are appended after the inherited environment API
// groups so upstream can add new first-party groups without editing the same
// class-definition or composition seams.
export class EnvironmentScientProjectHttpApi extends HttpApiGroup.make("scientProject")
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

export class EnvironmentScientSourcesHttpApi extends HttpApiGroup.make("scientSources")
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

export class EnvironmentScientLatexHttpApi extends HttpApiGroup.make("scientLatex")
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

export class EnvironmentScientAnalyticsHttpApi extends HttpApiGroup.make("scientAnalytics")
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

// SCIENT-FORK:START — Scient thread queue group. Appended after inherited
// groups like the other Scient groups so upstream additions never collide
// with this class or the composition seam below.
export class EnvironmentScientThreadQueueHttpApi extends HttpApiGroup.make("scientThreadQueue")
  .add(
    HttpApiEndpoint.post("list", "/api/scient/thread-queue/list", {
      headers: OptionalBearerHeaders,
      payload: ScientThreadQueueListRequest,
      success: ScientThreadQueueSnapshot,
      error: EnvironmentHttpCommonError,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("enqueue", "/api/scient/thread-queue/enqueue", {
      headers: OptionalBearerHeaders,
      payload: ScientThreadQueueEnqueueRequest,
      success: ScientThreadQueueSnapshot,
      error: EnvironmentHttpCommonError,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("remove", "/api/scient/thread-queue/remove", {
      headers: OptionalBearerHeaders,
      payload: ScientThreadQueueRemoveRequest,
      success: ScientThreadQueueSnapshot,
      error: EnvironmentHttpCommonError,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("reorder", "/api/scient/thread-queue/reorder", {
      headers: OptionalBearerHeaders,
      payload: ScientThreadQueueReorderRequest,
      success: ScientThreadQueueSnapshot,
      error: EnvironmentHttpCommonError,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}
// SCIENT-FORK:END

export class EnvironmentHttpApi extends HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentAuthHttpApi)
  .add(EnvironmentOrchestrationHttpApi)
  .add(EnvironmentPullRequestsHttpApi)
  .add(EnvironmentScientProjectHttpApi)
  .add(EnvironmentScientSourcesHttpApi)
  .add(EnvironmentScientAnalyticsHttpApi)
  .add(EnvironmentScientLatexHttpApi)
  // SCIENT-FORK:START
  .add(EnvironmentScientThreadQueueHttpApi)
  // SCIENT-FORK:END
  .add(EnvironmentConnectHttpApi) {}
