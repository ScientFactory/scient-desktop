import { EnvironmentId, IsoDateTime, ProjectId, VcsDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  WorkspaceAuthorityGeneration,
  WorkspaceAuthorityScopeRevision,
  WorkspaceBindingId,
} from "@scientfactory/operations";

export { WorkspaceAuthorityGeneration, WorkspaceAuthorityScopeRevision, WorkspaceBindingId };

export const WorkspaceBindingTrustState = Schema.Literals([
  "verified",
  "unseen",
  "ambiguous",
  "revoked",
]);
export type WorkspaceBindingTrustState = typeof WorkspaceBindingTrustState.Type;

export const ScientProjectIdentityState = Schema.Literals([
  "ordinary",
  "initialized",
  "recoverable",
  "conflicting",
]);
export type ScientProjectIdentityState = typeof ScientProjectIdentityState.Type;

/**
 * Stable, non-secret subset of T3's normalized repository identity.
 *
 * The raw remote URL is deliberately excluded because it can contain
 * credentials and should not become persisted authority evidence.
 */
export const WorkspaceRepositoryEvidence = Schema.Struct({
  canonicalKey: Schema.NonEmptyString,
  source: Schema.Literal("git-remote"),
  remoteName: Schema.NonEmptyString,
});
export type WorkspaceRepositoryEvidence = typeof WorkspaceRepositoryEvidence.Type;

/**
 * Exact checkout evidence retained from T3's VCS detection.
 *
 * `rootPath` distinguishes linked worktrees. `metadataPath` identifies the
 * shared repository administration directory when the VCS can establish it.
 */
export const WorkspaceWorktreeEvidence = Schema.Struct({
  kind: VcsDriverKind,
  rootPath: Schema.NonEmptyString,
  metadataPath: Schema.NullOr(Schema.NonEmptyString),
});
export type WorkspaceWorktreeEvidence = typeof WorkspaceWorktreeEvidence.Type;

/**
 * Host-local identity for the root directory when the filesystem exposes it.
 *
 * Device and inode are stored as strings so the record remains lossless when
 * the platform reports bigint values. They are app-private evidence, never a
 * portable project identifier or an agent-visible path grant.
 */
export const WorkspaceRootFileSystemEvidence = Schema.Struct({
  device: Schema.NonEmptyString,
  inode: Schema.NonEmptyString,
});
export type WorkspaceRootFileSystemEvidence = typeof WorkspaceRootFileSystemEvidence.Type;

export const ObservedWorkspaceEvidence = Schema.Struct({
  canonicalRoot: Schema.NonEmptyString,
  rootFileSystemIdentity: Schema.NullOr(WorkspaceRootFileSystemEvidence),
  scientProjectId: Schema.NullOr(Schema.NonEmptyString),
  scientProjectIdentityState: ScientProjectIdentityState,
  repositoryIdentity: Schema.NullOr(WorkspaceRepositoryEvidence),
  worktreeIdentity: Schema.NullOr(WorkspaceWorktreeEvidence),
  trustState: WorkspaceBindingTrustState,
  observedAt: IsoDateTime,
});
export type ObservedWorkspaceEvidence = typeof ObservedWorkspaceEvidence.Type;

export const WorkspaceBindingRecordV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  bindingId: WorkspaceBindingId,
  environmentId: EnvironmentId,
  hostProjectId: ProjectId,
  canonicalRoot: Schema.NonEmptyString,
  rootFileSystemIdentity: Schema.NullOr(WorkspaceRootFileSystemEvidence),
  scientProjectId: Schema.NullOr(Schema.NonEmptyString),
  repositoryIdentity: Schema.NullOr(WorkspaceRepositoryEvidence),
  worktreeIdentity: Schema.NullOr(WorkspaceWorktreeEvidence),
  lineageBindingId: Schema.NullOr(WorkspaceBindingId),
  trustState: WorkspaceBindingTrustState,
  authorityGeneration: WorkspaceAuthorityGeneration,
  createdAt: IsoDateTime,
  lastVerifiedAt: IsoDateTime,
  supersededBy: Schema.NullOr(WorkspaceBindingId),
});
export type WorkspaceBindingRecordV1 = typeof WorkspaceBindingRecordV1.Type;

export const WorkspaceBindingSafeDiagnostic = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  bindingId: WorkspaceBindingId,
  environmentId: EnvironmentId,
  hostProjectId: ProjectId,
  scientProjectId: Schema.NullOr(Schema.NonEmptyString),
  hasRepositoryEvidence: Schema.Boolean,
  hasRootFileSystemIdentity: Schema.Boolean,
  hasWorktreeEvidence: Schema.Boolean,
  lineageBindingId: Schema.NullOr(WorkspaceBindingId),
  trustState: WorkspaceBindingTrustState,
  authorityGeneration: WorkspaceAuthorityGeneration,
  createdAt: IsoDateTime,
  lastVerifiedAt: IsoDateTime,
  supersededBy: Schema.NullOr(WorkspaceBindingId),
});
export type WorkspaceBindingSafeDiagnostic = typeof WorkspaceBindingSafeDiagnostic.Type;

export const WorkspaceBindingRelation = Schema.Literals([
  "only-binding",
  "trusted-lineage",
  "unverified-shared-project-id",
]);
export type WorkspaceBindingRelation = typeof WorkspaceBindingRelation.Type;

export const ResolvedWorkspaceBinding = Schema.Struct({
  binding: WorkspaceBindingRecordV1,
  relation: WorkspaceBindingRelation,
  relatedBindingCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ResolvedWorkspaceBinding = typeof ResolvedWorkspaceBinding.Type;

export interface ResolvedThreadWorkspaceBinding extends ResolvedWorkspaceBinding {
  readonly scopeRevision: WorkspaceAuthorityScopeRevision;
}

export class WorkspaceBindingStoreError extends Schema.TaggedError<WorkspaceBindingStoreError>()(
  "WorkspaceBindingStoreError",
  {
    operation: Schema.String,
    kind: Schema.Literals([
      "persistence-failed",
      "invalid-record",
      "root-conflict",
      "lineage-conflict",
      "binding-not-found",
      "binding-revoked",
      "replacement-conflict",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class WorkspaceBindingResolutionError extends Schema.TaggedError<WorkspaceBindingResolutionError>()(
  "WorkspaceBindingResolutionError",
  {
    operation: Schema.String,
    kind: Schema.Literals([
      "thread-not-found",
      "project-required",
      "project-not-found",
      "workspace-unavailable",
      "identity-inspection-failed",
      "repository-inspection-failed",
      "lineage-conflict",
      "stale-authority",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const toSafeWorkspaceBindingDiagnostic = (
  binding: WorkspaceBindingRecordV1,
): WorkspaceBindingSafeDiagnostic => ({
  schemaVersion: 1,
  bindingId: binding.bindingId,
  environmentId: binding.environmentId,
  hostProjectId: binding.hostProjectId,
  scientProjectId: binding.scientProjectId,
  hasRepositoryEvidence: binding.repositoryIdentity !== null,
  hasRootFileSystemIdentity: binding.rootFileSystemIdentity !== null,
  hasWorktreeEvidence: binding.worktreeIdentity !== null,
  lineageBindingId: binding.lineageBindingId,
  trustState: binding.trustState,
  authorityGeneration: binding.authorityGeneration,
  createdAt: binding.createdAt,
  lastVerifiedAt: binding.lastVerifiedAt,
  supersededBy: binding.supersededBy,
});
