import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { PositiveInt } from "./baseSchemas.ts";

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty());
const ShortString = NonEmptyString.check(Schema.isMaxLength(512));
const hasNoControlCharacters = Schema.makeFilter((value: string) =>
  [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code > 0x1f && code !== 0x7f;
  })
    ? true
    : "Value must not contain control characters.",
);
const hasNoNullCharacter = Schema.makeFilter((value: string) =>
  [...value].every((character) => character.charCodeAt(0) !== 0)
    ? true
    : "Value must not contain a null character.",
);
const SafeShortString = ShortString.check(hasNoControlCharacters);
const PathString = NonEmptyString.check(Schema.isMaxLength(4_096), hasNoNullCharacter);
const OptionalShortString = Schema.optionalKey(SafeShortString);
const OpaqueId = NonEmptyString.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu),
);
const GitObjectId = NonEmptyString.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu));

export const ScientOverleafAccountKind = Schema.Literals(["cloud", "server-pro"]);
export type ScientOverleafAccountKind = typeof ScientOverleafAccountKind.Type;

export const ScientOverleafCommitPolicyKind = Schema.Literals(["neutral", "custom", "prompt"]);
export type ScientOverleafCommitPolicyKind = typeof ScientOverleafCommitPolicyKind.Type;

export const ScientOverleafCommitPolicy = Schema.Struct({
  kind: ScientOverleafCommitPolicyKind,
  message: Schema.optionalKey(SafeShortString),
});
export type ScientOverleafCommitPolicy = typeof ScientOverleafCommitPolicy.Type;

export const ScientOverleafOperationPhase = Schema.Literals([
  "preparing",
  "awaiting_commit_message",
  "fetching",
  "rebasing",
  "awaiting_conflicts",
  "awaiting_push_confirmation",
  "pushing",
  "push_outcome_unknown",
  "projecting",
  "remote_synced_local_pending",
  "awaiting_local_conflicts",
  "publishing",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type ScientOverleafOperationPhase = typeof ScientOverleafOperationPhase.Type;

export const ScientOverleafErrorCode = Schema.Literals([
  "authentication_failed",
  "git_access_unavailable",
  "network_failed",
  "dns_failed",
  "tls_failed",
  "rate_limited",
  "push_race",
  "push_outcome_unknown",
  "conflict",
  "review_required",
  "limit_acknowledgement_required",
  "unsafe_tree",
  "unsupported_tree",
  "workspace_changed",
  "local_projection_pending",
  "filesystem_failed",
  "disk_failed",
  "corrupt_state",
  "interrupted_state",
  "operation_active",
  "invalid_request",
  "not_found",
]);
export type ScientOverleafErrorCode = typeof ScientOverleafErrorCode.Type;

export class ScientOverleafOperationError extends Schema.TaggedErrorClass<ScientOverleafOperationError>()(
  "ScientOverleafOperationError",
  {
    code: ScientOverleafErrorCode,
    message: Schema.String,
    retryable: Schema.Boolean,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(ScientOverleafOperationError)(this, { status: 409 });
  }
}

export const ScientOverleafAccount = Schema.Struct({
  accountId: OpaqueId,
  label: SafeShortString,
  kind: ScientOverleafAccountKind,
  host: SafeShortString,
  authorName: SafeShortString,
  authorEmail: SafeShortString,
  credentialStatus: Schema.Literals(["saved", "missing"]),
  createdAtEpochMs: Schema.Number,
  updatedAtEpochMs: Schema.Number,
  lastValidatedAtEpochMs: Schema.NullOr(Schema.Number),
});
export type ScientOverleafAccount = typeof ScientOverleafAccount.Type;

export const ScientOverleafConnectionState = Schema.Literals([
  "ready",
  "local_ahead",
  "operation_active",
  "push_outcome_unknown",
  "local_projection_pending",
  "repair_required",
]);
export type ScientOverleafConnectionState = typeof ScientOverleafConnectionState.Type;

export const ScientOverleafConnection = Schema.Struct({
  connectionId: OpaqueId,
  accountId: OpaqueId,
  label: SafeShortString,
  workspaceRoot: PathString,
  relativeFolder: Schema.String.check(Schema.isMaxLength(4_096)),
  projectUrl: SafeShortString,
  gitUrl: SafeShortString,
  host: SafeShortString,
  branch: Schema.Literal("master"),
  commitPolicy: ScientOverleafCommitPolicy,
  suppressRenameWarning: Schema.Boolean,
  state: ScientOverleafConnectionState,
  remoteBaselineCommit: Schema.NullOr(GitObjectId),
  lastConvergedCommit: Schema.NullOr(GitObjectId),
  localAhead: Schema.Boolean,
  localOnlyCompanions: Schema.Array(PathString),
  lastSyncedAtEpochMs: Schema.NullOr(Schema.Number),
});
export type ScientOverleafConnection = typeof ScientOverleafConnection.Type;

export const ScientOverleafChangeKind = Schema.Literals([
  "added",
  "modified",
  "renamed",
  "deleted",
]);
export type ScientOverleafChangeKind = typeof ScientOverleafChangeKind.Type;

export const ScientOverleafChange = Schema.Struct({
  kind: ScientOverleafChangeKind,
  path: PathString,
  oldPath: Schema.optionalKey(PathString),
  similarity: Schema.optionalKey(Schema.Number),
});
export type ScientOverleafChange = typeof ScientOverleafChange.Type;

export const ScientOverleafWarningKind = Schema.Literals([
  "deletion",
  "historical_revert",
  "whole_tree_revert",
  "rename",
  "file_count",
  "large_file",
  "large_editable_text",
  "large_editable_material",
  "project_size",
  "track_changes_metadata",
  "replacement",
]);
export type ScientOverleafWarningKind = typeof ScientOverleafWarningKind.Type;

export const ScientOverleafWarning = Schema.Struct({
  kind: ScientOverleafWarningKind,
  message: Schema.String,
  paths: Schema.Array(PathString),
  blocking: Schema.Boolean,
  suppressible: Schema.Boolean,
});
export type ScientOverleafWarning = typeof ScientOverleafWarning.Type;

export const ScientOverleafReview = Schema.Struct({
  candidateCommit: GitObjectId,
  changes: Schema.Array(ScientOverleafChange),
  warnings: Schema.Array(ScientOverleafWarning),
  requiresConfirmation: Schema.Boolean,
});
export type ScientOverleafReview = typeof ScientOverleafReview.Type;

export const ScientOverleafConflictKind = Schema.Literals([
  "content",
  "binary",
  "delete_modify",
  "rename",
  "file_directory",
]);
export type ScientOverleafConflictKind = typeof ScientOverleafConflictKind.Type;

export const ScientOverleafConflict = Schema.Struct({
  conflictId: NonEmptyString,
  kind: ScientOverleafConflictKind,
  path: PathString,
  overleafPath: Schema.optionalKey(PathString),
  localPath: Schema.optionalKey(PathString),
  baseSize: Schema.NullOr(Schema.Number),
  overleafSize: Schema.NullOr(Schema.Number),
  localSize: Schema.NullOr(Schema.Number),
  baseHash: Schema.NullOr(Schema.String),
  overleafHash: Schema.NullOr(Schema.String),
  localHash: Schema.NullOr(Schema.String),
  previewable: Schema.Boolean,
  resolved: Schema.Boolean,
});
export type ScientOverleafConflict = typeof ScientOverleafConflict.Type;

export const ScientOverleafConflictDetail = Schema.Struct({
  conflict: ScientOverleafConflict,
  base: Schema.NullOr(Schema.String),
  overleaf: Schema.NullOr(Schema.String),
  local: Schema.NullOr(Schema.String),
});
export type ScientOverleafConflictDetail = typeof ScientOverleafConflictDetail.Type;

export const ScientOverleafOperationSnapshot = Schema.Struct({
  operationId: OpaqueId,
  generation: PositiveInt,
  kind: Schema.Literals(["connect", "sync", "reconcile", "repair", "disconnect"]),
  connectStage: Schema.NullOr(Schema.Literals(["preflight", "connected"])),
  connectionId: Schema.NullOr(OpaqueId),
  phase: ScientOverleafOperationPhase,
  startedAtEpochMs: Schema.Number,
  updatedAtEpochMs: Schema.Number,
  message: Schema.String,
  review: Schema.NullOr(ScientOverleafReview),
  conflicts: Schema.Array(ScientOverleafConflict),
  errorCode: Schema.NullOr(ScientOverleafErrorCode),
  retryable: Schema.Boolean,
});
export type ScientOverleafOperationSnapshot = typeof ScientOverleafOperationSnapshot.Type;

export const ScientOverleafOverviewRequest = Schema.Struct({
  workspaceRoot: PathString,
});
export type ScientOverleafOverviewRequest = typeof ScientOverleafOverviewRequest.Type;

export const ScientOverleafOverview = Schema.Struct({
  accounts: Schema.Array(ScientOverleafAccount),
  connections: Schema.Array(ScientOverleafConnection),
  operations: Schema.Array(ScientOverleafOperationSnapshot),
});
export type ScientOverleafOverview = typeof ScientOverleafOverview.Type;

export const ScientOverleafSaveAccountRequest = Schema.Struct({
  accountId: Schema.optionalKey(OpaqueId),
  label: SafeShortString,
  kind: ScientOverleafAccountKind,
  host: SafeShortString,
  authorName: SafeShortString,
  authorEmail: SafeShortString,
  token: Schema.optionalKey(NonEmptyString.check(Schema.isMaxLength(8_192))),
});
export type ScientOverleafSaveAccountRequest = typeof ScientOverleafSaveAccountRequest.Type;

export const ScientOverleafAccountRequest = Schema.Struct({ accountId: OpaqueId });
export type ScientOverleafAccountRequest = typeof ScientOverleafAccountRequest.Type;

export const ScientOverleafPreflightStartRequest = Schema.Struct({
  accountId: OpaqueId,
  workspaceRoot: PathString,
  relativeFolder: Schema.String.check(Schema.isMaxLength(4_096)),
  projectInput: NonEmptyString.check(Schema.isMaxLength(8_192)),
  label: OptionalShortString,
  commitPolicy: ScientOverleafCommitPolicy,
});
export type ScientOverleafPreflightStartRequest = typeof ScientOverleafPreflightStartRequest.Type;

export const ScientOverleafOperationRequest = Schema.Struct({ operationId: OpaqueId });
export type ScientOverleafOperationRequest = typeof ScientOverleafOperationRequest.Type;

export const ScientOverleafContinueRequest = Schema.Struct({
  operationId: OpaqueId,
  commitMessage: OptionalShortString,
});
export type ScientOverleafContinueRequest = typeof ScientOverleafContinueRequest.Type;

export const ScientOverleafConnectionRequest = Schema.Struct({ connectionId: OpaqueId });
export type ScientOverleafConnectionRequest = typeof ScientOverleafConnectionRequest.Type;

export const ScientOverleafPreflightCompleteRequest = Schema.Struct({
  operationId: OpaqueId,
  generation: PositiveInt,
  mode: Schema.Literals(["combine", "replace-local", "replace-overleaf"]),
  acknowledgeWarnings: Schema.Boolean,
  commitMessage: OptionalShortString,
});
export type ScientOverleafPreflightCompleteRequest =
  typeof ScientOverleafPreflightCompleteRequest.Type;

export const ScientOverleafConnectionSettingsRequest = Schema.Struct({
  connectionId: OpaqueId,
  label: OptionalShortString,
  commitPolicy: Schema.optionalKey(ScientOverleafCommitPolicy),
  suppressRenameWarning: Schema.optionalKey(Schema.Boolean),
  includeCompanionPath: Schema.optionalKey(PathString),
});
export type ScientOverleafConnectionSettingsRequest =
  typeof ScientOverleafConnectionSettingsRequest.Type;

export const ScientOverleafSyncStartRequest = Schema.Struct({
  connectionId: OpaqueId,
  commitMessage: OptionalShortString,
});
export type ScientOverleafSyncStartRequest = typeof ScientOverleafSyncStartRequest.Type;

export const ScientOverleafReviewConfirmationRequest = Schema.Struct({
  operationId: OpaqueId,
  generation: PositiveInt,
  candidateCommit: GitObjectId,
  acknowledgeWarnings: Schema.Boolean,
  suppressFutureRenameWarnings: Schema.Boolean,
});
export type ScientOverleafReviewConfirmationRequest =
  typeof ScientOverleafReviewConfirmationRequest.Type;

export const ScientOverleafConflictRequest = Schema.Struct({
  operationId: OpaqueId,
  conflictId: NonEmptyString,
});
export type ScientOverleafConflictRequest = typeof ScientOverleafConflictRequest.Type;

export const ScientOverleafConflictResolutionRequest = Schema.Struct({
  operationId: OpaqueId,
  generation: PositiveInt,
  conflictId: NonEmptyString,
  resolution: Schema.Literals(["overleaf", "local", "delete", "both"]),
  keepBothPath: Schema.optionalKey(PathString),
  keepOtherSide: Schema.Boolean,
  companionPath: Schema.optionalKey(PathString),
});
export type ScientOverleafConflictResolutionRequest =
  typeof ScientOverleafConflictResolutionRequest.Type;

export const ScientOverleafDisconnectRequest = Schema.Struct({
  connectionId: OpaqueId,
  mode: Schema.Literals(["check", "sync-and-disconnect", "disconnect-without-sync"]),
  commitMessage: OptionalShortString,
});
export type ScientOverleafDisconnectRequest = typeof ScientOverleafDisconnectRequest.Type;

export const ScientOverleafDisconnectResult = Schema.Struct({
  disconnected: Schema.Boolean,
  hasUnsyncedChanges: Schema.Boolean,
  companionPaths: Schema.Array(PathString),
  operation: Schema.NullOr(ScientOverleafOperationSnapshot),
});
export type ScientOverleafDisconnectResult = typeof ScientOverleafDisconnectResult.Type;

export const ScientOverleafVoidResult = Schema.Struct({ ok: Schema.Literal(true) });
export type ScientOverleafVoidResult = typeof ScientOverleafVoidResult.Type;
