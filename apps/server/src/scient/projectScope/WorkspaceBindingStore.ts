import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runScientMigrations } from "../../orchestration/scient-fork/scientMigrator.ts";
import {
  type ObservedWorkspaceEvidence,
  type ResolvedWorkspaceBinding,
  WorkspaceAuthorityGeneration,
  type WorkspaceBindingId,
  WorkspaceBindingId as WorkspaceBindingIdSchema,
  type WorkspaceBindingRecordV1,
  WorkspaceBindingRecordV1 as WorkspaceBindingRecordSchema,
  type WorkspaceBindingRelation,
  WorkspaceRootFileSystemEvidence,
  WorkspaceBindingStoreError,
  WorkspaceRepositoryEvidence,
  WorkspaceWorktreeEvidence,
} from "./WorkspaceBinding.ts";

const StoredWorkspaceBindingRow = Schema.Struct({
  binding_id: Schema.String,
  schema_version: Schema.Int,
  environment_id: Schema.String,
  host_project_id: Schema.String,
  canonical_root: Schema.String,
  root_filesystem_identity_json: Schema.NullOr(Schema.String),
  scient_project_id: Schema.NullOr(Schema.String),
  repository_identity_json: Schema.NullOr(Schema.String),
  worktree_identity_json: Schema.NullOr(Schema.String),
  lineage_binding_id: Schema.NullOr(Schema.String),
  trust_state: Schema.String,
  authority_generation: Schema.Int,
  created_at: Schema.String,
  last_verified_at: Schema.String,
  superseded_by: Schema.NullOr(Schema.String),
});
type StoredWorkspaceBindingRow = typeof StoredWorkspaceBindingRow.Type;

const RepositoryEvidenceJson = Schema.fromJsonString(WorkspaceRepositoryEvidence);
const RootFileSystemEvidenceJson = Schema.fromJsonString(WorkspaceRootFileSystemEvidence);
const WorktreeEvidenceJson = Schema.fromJsonString(WorkspaceWorktreeEvidence);
const decodeStoredRow = Schema.decodeUnknownEffect(StoredWorkspaceBindingRow);
const decodeRepositoryEvidence = Schema.decodeUnknownEffect(RepositoryEvidenceJson);
const decodeRootFileSystemEvidence = Schema.decodeUnknownEffect(RootFileSystemEvidenceJson);
const decodeWorktreeEvidence = Schema.decodeUnknownEffect(WorktreeEvidenceJson);
const decodeBinding = Schema.decodeUnknownEffect(WorkspaceBindingRecordSchema);
const encodeRepositoryEvidence = Schema.encodeEffect(RepositoryEvidenceJson);
const encodeRootFileSystemEvidence = Schema.encodeEffect(RootFileSystemEvidenceJson);
const encodeWorktreeEvidence = Schema.encodeEffect(WorktreeEvidenceJson);
const isWorkspaceBindingStoreError = Schema.is(WorkspaceBindingStoreError);

export interface VerifyObservedWorkspaceInput {
  readonly environmentId: WorkspaceBindingRecordV1["environmentId"];
  readonly hostProjectId: WorkspaceBindingRecordV1["hostProjectId"];
  readonly evidence: ObservedWorkspaceEvidence;
  /** Accepted only from a trusted host worktree-creation path. */
  readonly lineageBindingId?: WorkspaceBindingId | null;
  /** Host resolver has confirmed that this binding's former registration is inactive. */
  readonly reassociateBindingId?: WorkspaceBindingId;
}

export interface ConfirmWorkspaceReplacementInput extends VerifyObservedWorkspaceInput {
  readonly currentBindingId: WorkspaceBindingId;
}

export class WorkspaceBindingStore extends Context.Service<
  WorkspaceBindingStore,
  {
    readonly verifyObserved: (
      input: VerifyObservedWorkspaceInput,
    ) => Effect.Effect<ResolvedWorkspaceBinding, WorkspaceBindingStoreError>;
    readonly confirmReplacement: (
      input: ConfirmWorkspaceReplacementInput,
    ) => Effect.Effect<ResolvedWorkspaceBinding, WorkspaceBindingStoreError>;
    /**
     * Persistence-only generation check. Protected operations must additionally
     * re-resolve their current host context through WorkspaceBindingResolver.
     */
    readonly assertCurrent: (input: {
      readonly bindingId: WorkspaceBindingId;
      readonly authorityGeneration: WorkspaceBindingRecordV1["authorityGeneration"];
    }) => Effect.Effect<WorkspaceBindingRecordV1, WorkspaceBindingStoreError>;
    readonly revoke: (
      bindingId: WorkspaceBindingId,
    ) => Effect.Effect<WorkspaceBindingRecordV1, WorkspaceBindingStoreError>;
    readonly getById: (
      bindingId: WorkspaceBindingId,
    ) => Effect.Effect<WorkspaceBindingRecordV1 | null, WorkspaceBindingStoreError>;
    readonly getActiveByRoot: (input: {
      readonly environmentId: WorkspaceBindingRecordV1["environmentId"];
      readonly canonicalRoot: string;
    }) => Effect.Effect<WorkspaceBindingRecordV1 | null, WorkspaceBindingStoreError>;
    readonly listByScientProjectId: (input: {
      readonly environmentId: WorkspaceBindingRecordV1["environmentId"];
      readonly scientProjectId: string;
      readonly includeSuperseded?: boolean;
    }) => Effect.Effect<ReadonlyArray<WorkspaceBindingRecordV1>, WorkspaceBindingStoreError>;
  }
>()("t3/scient/projectScope/WorkspaceBindingStore") {}

const storeFailure = (operation: string, cause: unknown) =>
  isWorkspaceBindingStoreError(cause)
    ? cause
    : new WorkspaceBindingStoreError({
        operation,
        kind: "persistence-failed",
        cause,
      });

const decodeRow = Effect.fn("WorkspaceBindingStore.decodeRow")(function* (
  input: unknown,
): Effect.fn.Return<WorkspaceBindingRecordV1, WorkspaceBindingStoreError> {
  const row = yield* decodeStoredRow(input).pipe(
    Effect.mapError(
      (cause) =>
        new WorkspaceBindingStoreError({
          operation: "decode-row",
          kind: "invalid-record",
          cause,
        }),
    ),
  );
  const repositoryIdentity = row.repository_identity_json
    ? yield* decodeRepositoryEvidence(row.repository_identity_json).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceBindingStoreError({
              operation: "decode-repository-evidence",
              kind: "invalid-record",
              cause,
            }),
        ),
      )
    : null;
  const rootFileSystemIdentity = row.root_filesystem_identity_json
    ? yield* decodeRootFileSystemEvidence(row.root_filesystem_identity_json).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceBindingStoreError({
              operation: "decode-root-filesystem-evidence",
              kind: "invalid-record",
              cause,
            }),
        ),
      )
    : null;
  const worktreeIdentity = row.worktree_identity_json
    ? yield* decodeWorktreeEvidence(row.worktree_identity_json).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceBindingStoreError({
              operation: "decode-worktree-evidence",
              kind: "invalid-record",
              cause,
            }),
        ),
      )
    : null;

  return yield* decodeBinding({
    schemaVersion: row.schema_version,
    bindingId: row.binding_id,
    environmentId: row.environment_id,
    hostProjectId: row.host_project_id,
    canonicalRoot: row.canonical_root,
    rootFileSystemIdentity,
    scientProjectId: row.scient_project_id,
    repositoryIdentity,
    worktreeIdentity,
    lineageBindingId: row.lineage_binding_id,
    trustState: row.trust_state,
    authorityGeneration: row.authority_generation,
    createdAt: row.created_at,
    lastVerifiedAt: row.last_verified_at,
    supersededBy: row.superseded_by,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new WorkspaceBindingStoreError({
          operation: "decode-binding",
          kind: "invalid-record",
          cause,
        }),
    ),
  );
});

const authorityEvidenceEqual = (
  binding: WorkspaceBindingRecordV1,
  evidence: ObservedWorkspaceEvidence,
): boolean =>
  binding.rootFileSystemIdentity?.device === evidence.rootFileSystemIdentity?.device &&
  binding.rootFileSystemIdentity?.inode === evidence.rootFileSystemIdentity?.inode &&
  binding.scientProjectId === evidence.scientProjectId &&
  binding.trustState === evidence.trustState &&
  binding.repositoryIdentity?.canonicalKey === evidence.repositoryIdentity?.canonicalKey &&
  binding.repositoryIdentity?.source === evidence.repositoryIdentity?.source &&
  binding.worktreeIdentity?.kind === evidence.worktreeIdentity?.kind &&
  binding.worktreeIdentity?.rootPath === evidence.worktreeIdentity?.rootPath &&
  binding.worktreeIdentity?.metadataPath === evidence.worktreeIdentity?.metadataPath;

const samePhysicalRoot = (
  binding: WorkspaceBindingRecordV1,
  evidence: ObservedWorkspaceEvidence,
): boolean =>
  binding.rootFileSystemIdentity !== null &&
  evidence.rootFileSystemIdentity !== null &&
  binding.rootFileSystemIdentity.device === evidence.rootFileSystemIdentity.device &&
  binding.rootFileSystemIdentity.inode === evidence.rootFileSystemIdentity.inode;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  yield* runScientMigrations(sql);

  const selectColumns = `
    binding_id, schema_version, environment_id, host_project_id,
    canonical_root, root_filesystem_identity_json, scient_project_id, repository_identity_json,
    worktree_identity_json, lineage_binding_id, trust_state,
    authority_generation, created_at, last_verified_at, superseded_by
  `;

  const rowsById = (bindingId: WorkspaceBindingId) =>
    sql.unsafe<StoredWorkspaceBindingRow>(
      `SELECT ${selectColumns} FROM scient_workspace_bindings WHERE binding_id = ?`,
      [bindingId],
    );

  const rowsByActiveAuthority = (input: VerifyObservedWorkspaceInput) =>
    sql.unsafe<StoredWorkspaceBindingRow>(
      `SELECT ${selectColumns}
       FROM scient_workspace_bindings
       WHERE environment_id = ? AND host_project_id = ? AND canonical_root = ?
         AND superseded_by IS NULL`,
      [input.environmentId, input.hostProjectId, input.evidence.canonicalRoot],
    );

  const rowsByActiveRoot = (input: VerifyObservedWorkspaceInput) =>
    sql.unsafe<StoredWorkspaceBindingRow>(
      `SELECT ${selectColumns}
       FROM scient_workspace_bindings
       WHERE environment_id = ? AND canonical_root = ? AND superseded_by IS NULL`,
      [input.environmentId, input.evidence.canonicalRoot],
    );

  const getByIdInternal = Effect.fn("WorkspaceBindingStore.getByIdInternal")(function* (
    bindingId: WorkspaceBindingId,
  ) {
    const rows = yield* rowsById(bindingId);
    return rows[0] ? yield* decodeRow(rows[0]) : null;
  });

  const encodeEvidence = Effect.fn("WorkspaceBindingStore.encodeEvidence")(function* (
    evidence: ObservedWorkspaceEvidence,
  ) {
    const repositoryIdentityJson = evidence.repositoryIdentity
      ? yield* encodeRepositoryEvidence(evidence.repositoryIdentity)
      : null;
    const rootFileSystemIdentityJson = evidence.rootFileSystemIdentity
      ? yield* encodeRootFileSystemEvidence(evidence.rootFileSystemIdentity)
      : null;
    const worktreeIdentityJson = evidence.worktreeIdentity
      ? yield* encodeWorktreeEvidence(evidence.worktreeIdentity)
      : null;
    return { repositoryIdentityJson, rootFileSystemIdentityJson, worktreeIdentityJson };
  });

  const insertBinding = Effect.fn("WorkspaceBindingStore.insertBinding")(function* (input: {
    readonly bindingId: WorkspaceBindingId;
    readonly environmentId: WorkspaceBindingRecordV1["environmentId"];
    readonly hostProjectId: WorkspaceBindingRecordV1["hostProjectId"];
    readonly evidence: ObservedWorkspaceEvidence;
    readonly lineageBindingId: WorkspaceBindingId | null;
    readonly authorityGeneration: WorkspaceBindingRecordV1["authorityGeneration"];
    readonly createdAt: string;
  }) {
    const encoded = yield* encodeEvidence(input.evidence);
    yield* sql`
      INSERT INTO scient_workspace_bindings (
        binding_id, schema_version, environment_id, host_project_id,
        canonical_root, root_filesystem_identity_json, scient_project_id, repository_identity_json,
        worktree_identity_json, lineage_binding_id, trust_state,
        authority_generation, created_at, last_verified_at, superseded_by
      ) VALUES (
        ${input.bindingId}, 1, ${input.environmentId}, ${input.hostProjectId},
        ${input.evidence.canonicalRoot}, ${encoded.rootFileSystemIdentityJson}, ${input.evidence.scientProjectId},
        ${encoded.repositoryIdentityJson}, ${encoded.worktreeIdentityJson},
        ${input.lineageBindingId}, ${input.evidence.trustState},
        ${input.authorityGeneration}, ${input.createdAt}, ${input.evidence.observedAt}, NULL
      )
    `;
    const inserted = yield* getByIdInternal(input.bindingId);
    if (!inserted) {
      return yield* new WorkspaceBindingStoreError({
        operation: "insert-binding",
        kind: "persistence-failed",
      });
    }
    return inserted;
  });

  const validateLineage = Effect.fn("WorkspaceBindingStore.validateLineage")(function* (input: {
    readonly lineageBindingId: WorkspaceBindingId | null;
    readonly environmentId: WorkspaceBindingRecordV1["environmentId"];
    readonly evidence: ObservedWorkspaceEvidence;
  }) {
    if (input.lineageBindingId === null) return;
    const parent = yield* getByIdInternal(input.lineageBindingId);
    const parentWorktree = parent?.worktreeIdentity ?? null;
    const childWorktree = input.evidence.worktreeIdentity;
    if (
      !parent ||
      parent.supersededBy !== null ||
      parent.trustState !== "verified" ||
      input.evidence.trustState !== "verified" ||
      parent.environmentId !== input.environmentId ||
      parent.scientProjectId === null ||
      parent.scientProjectId !== input.evidence.scientProjectId ||
      parentWorktree === null ||
      childWorktree === null ||
      parentWorktree.kind !== childWorktree.kind ||
      parentWorktree.metadataPath === null ||
      parentWorktree.metadataPath !== childWorktree.metadataPath ||
      (parent.repositoryIdentity !== null &&
        input.evidence.repositoryIdentity !== null &&
        parent.repositoryIdentity.canonicalKey !== input.evidence.repositoryIdentity.canonicalKey)
    ) {
      return yield* new WorkspaceBindingStoreError({
        operation: "validate-lineage",
        kind: "lineage-conflict",
      });
    }
  });

  const listByScientProjectIdInternal = Effect.fn(
    "WorkspaceBindingStore.listByScientProjectIdInternal",
  )(function* (input: {
    readonly environmentId: WorkspaceBindingRecordV1["environmentId"];
    readonly scientProjectId: string;
    readonly includeSuperseded: boolean;
  }) {
    const rows = yield* sql.unsafe<StoredWorkspaceBindingRow>(
      `SELECT ${selectColumns}
       FROM scient_workspace_bindings
       WHERE environment_id = ? AND scient_project_id = ?
         ${input.includeSuperseded ? "" : "AND superseded_by IS NULL"}
       ORDER BY created_at, binding_id`,
      [input.environmentId, input.scientProjectId],
    );
    return yield* Effect.forEach(rows, decodeRow);
  });

  const relationFor = Effect.fn("WorkspaceBindingStore.relationFor")(function* (
    binding: WorkspaceBindingRecordV1,
  ) {
    if (binding.scientProjectId === null) {
      return { relation: "only-binding" as const, relatedBindingCount: 0 };
    }
    const all = yield* listByScientProjectIdInternal({
      environmentId: binding.environmentId,
      scientProjectId: binding.scientProjectId,
      includeSuperseded: true,
    });
    const active = all.filter(
      (candidate) => candidate.supersededBy === null && candidate.bindingId !== binding.bindingId,
    );
    if (active.length === 0) {
      return { relation: "only-binding" as const, relatedBindingCount: 0 };
    }

    const byId = new Map(all.map((candidate) => [candidate.bindingId, candidate] as const));
    const lineageRoot = (candidate: WorkspaceBindingRecordV1): WorkspaceBindingId => {
      const visited = new Set<WorkspaceBindingId>();
      let current = candidate;
      while (current.lineageBindingId !== null && !visited.has(current.bindingId)) {
        visited.add(current.bindingId);
        const parent = byId.get(current.lineageBindingId);
        if (!parent) break;
        current = parent;
      }
      return current.bindingId;
    };
    const root = lineageRoot(binding);
    const allRelatedAreTrusted = active.every((candidate) => lineageRoot(candidate) === root);
    const relation: WorkspaceBindingRelation = allRelatedAreTrusted
      ? "trusted-lineage"
      : "unverified-shared-project-id";
    return {
      relation,
      relatedBindingCount: active.length,
    };
  });

  const resolved = Effect.fn("WorkspaceBindingStore.resolved")(function* (
    binding: WorkspaceBindingRecordV1,
  ) {
    const relation = yield* relationFor(binding);
    return { binding, ...relation };
  });

  const verifyObserved: WorkspaceBindingStore["Service"]["verifyObserved"] = Effect.fn(
    "WorkspaceBindingStore.verifyObserved",
  )(function* (input) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const exactRows = yield* rowsByActiveAuthority(input);
          let existing = exactRows[0] ? yield* decodeRow(exactRows[0]) : null;
          if (!existing) {
            const rootRows = yield* rowsByActiveRoot(input);
            const previous = rootRows[0] ? yield* decodeRow(rootRows[0]) : null;
            if (previous) {
              if (
                previous.bindingId !== input.reassociateBindingId ||
                previous.trustState !== "verified" ||
                input.evidence.trustState !== "verified" ||
                !samePhysicalRoot(previous, input.evidence)
              ) {
                return yield* new WorkspaceBindingStoreError({
                  operation: "verify-observed",
                  kind: "root-conflict",
                });
              }
              existing = previous;
            }
          }
          if (existing?.trustState === "revoked") {
            return yield* new WorkspaceBindingStoreError({
              operation: "verify-observed",
              kind: "binding-revoked",
            });
          }
          if (
            existing &&
            existing.hostProjectId === input.hostProjectId &&
            authorityEvidenceEqual(existing, input.evidence)
          ) {
            // A remote alias is provenance, not a different checkout or grant.
            // Refresh it without detaching this workspace's retained history.
            const repositoryIdentityJson = input.evidence.repositoryIdentity
              ? yield* encodeRepositoryEvidence(input.evidence.repositoryIdentity)
              : null;
            yield* sql`
              UPDATE scient_workspace_bindings
              SET last_verified_at = ${input.evidence.observedAt},
                  repository_identity_json = ${repositoryIdentityJson}
              WHERE binding_id = ${existing.bindingId} AND superseded_by IS NULL
            `;
            return yield* resolved({
              ...existing,
              repositoryIdentity: input.evidence.repositoryIdentity,
              lastVerifiedAt: input.evidence.observedAt,
            });
          }

          if (existing && samePhysicalRoot(existing, input.evidence)) {
            // The directory owns history; metadata and host registration own
            // current authority. Updating the latter must not orphan the former.
            const encoded = yield* encodeEvidence(input.evidence);
            const generation = WorkspaceAuthorityGeneration.make(existing.authorityGeneration + 1);
            yield* sql`
              UPDATE scient_workspace_bindings
              SET host_project_id = ${input.hostProjectId},
                  scient_project_id = ${input.evidence.scientProjectId},
                  repository_identity_json = ${encoded.repositoryIdentityJson},
                  worktree_identity_json = ${encoded.worktreeIdentityJson},
                  trust_state = ${input.evidence.trustState},
                  authority_generation = ${generation},
                  last_verified_at = ${input.evidence.observedAt}
              WHERE binding_id = ${existing.bindingId} AND superseded_by IS NULL
            `;
            return yield* resolved({
              ...existing,
              hostProjectId: input.hostProjectId,
              scientProjectId: input.evidence.scientProjectId,
              repositoryIdentity: input.evidence.repositoryIdentity,
              worktreeIdentity: input.evidence.worktreeIdentity,
              trustState: input.evidence.trustState,
              authorityGeneration: generation,
              lastVerifiedAt: input.evidence.observedAt,
            });
          }
          if (existing && input.evidence.rootFileSystemIdentity === null) {
            return yield* new WorkspaceBindingStoreError({
              operation: "verify-observed",
              kind: "root-conflict",
            });
          }

          const lineageBindingId = existing
            ? existing.lineageBindingId
            : (input.lineageBindingId ?? null);
          yield* validateLineage({
            lineageBindingId,
            environmentId: input.environmentId,
            evidence: input.evidence,
          });

          const bindingId = WorkspaceBindingIdSchema.make(yield* crypto.randomUUIDv4);
          const authorityGeneration = WorkspaceAuthorityGeneration.make(
            existing ? existing.authorityGeneration + 1 : 1,
          );
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          if (existing) {
            yield* sql`
              UPDATE scient_workspace_bindings
              SET superseded_by = ${bindingId}
              WHERE binding_id = ${existing.bindingId} AND superseded_by IS NULL
            `;
          }
          const binding = yield* insertBinding({
            bindingId,
            environmentId: input.environmentId,
            hostProjectId: input.hostProjectId,
            evidence: input.evidence,
            lineageBindingId,
            authorityGeneration,
            createdAt,
          });
          return yield* resolved(binding);
        }),
      )
      .pipe(Effect.mapError((cause) => storeFailure("verify-observed", cause)));
  });

  const confirmReplacement: WorkspaceBindingStore["Service"]["confirmReplacement"] = Effect.fn(
    "WorkspaceBindingStore.confirmReplacement",
  )(function* (input) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* getByIdInternal(input.currentBindingId);
          if (!current || current.supersededBy !== null) {
            return yield* new WorkspaceBindingStoreError({
              operation: "confirm-replacement",
              kind: "binding-not-found",
            });
          }
          if (current.trustState === "revoked") {
            return yield* new WorkspaceBindingStoreError({
              operation: "confirm-replacement",
              kind: "binding-revoked",
            });
          }
          if (
            current.environmentId !== input.environmentId ||
            current.hostProjectId !== input.hostProjectId ||
            input.evidence.trustState !== "verified" ||
            current.scientProjectId !== input.evidence.scientProjectId ||
            current.canonicalRoot === input.evidence.canonicalRoot
          ) {
            return yield* new WorkspaceBindingStoreError({
              operation: "confirm-replacement",
              kind: "replacement-conflict",
            });
          }
          const rootRows = yield* rowsByActiveRoot(input);
          if (rootRows.length > 0) {
            return yield* new WorkspaceBindingStoreError({
              operation: "confirm-replacement",
              kind: "replacement-conflict",
            });
          }
          if (
            current.repositoryIdentity !== null &&
            input.evidence.repositoryIdentity !== null &&
            current.repositoryIdentity.canonicalKey !==
              input.evidence.repositoryIdentity.canonicalKey
          ) {
            return yield* new WorkspaceBindingStoreError({
              operation: "confirm-replacement",
              kind: "replacement-conflict",
            });
          }

          const bindingId = WorkspaceBindingIdSchema.make(yield* crypto.randomUUIDv4);
          const authorityGeneration = WorkspaceAuthorityGeneration.make(
            current.authorityGeneration + 1,
          );
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            UPDATE scient_workspace_bindings
            SET superseded_by = ${bindingId}
            WHERE binding_id = ${current.bindingId} AND superseded_by IS NULL
          `;
          const replacement = yield* insertBinding({
            bindingId,
            environmentId: input.environmentId,
            hostProjectId: input.hostProjectId,
            evidence: input.evidence,
            lineageBindingId: current.bindingId,
            authorityGeneration,
            createdAt,
          });
          return yield* resolved(replacement);
        }),
      )
      .pipe(Effect.mapError((cause) => storeFailure("confirm-replacement", cause)));
  });

  const assertCurrent: WorkspaceBindingStore["Service"]["assertCurrent"] = Effect.fn(
    "WorkspaceBindingStore.assertCurrent",
  )(
    function* (input) {
      const binding = yield* getByIdInternal(input.bindingId);
      if (
        !binding ||
        binding.supersededBy !== null ||
        binding.trustState !== "verified" ||
        binding.authorityGeneration !== input.authorityGeneration
      ) {
        return yield* new WorkspaceBindingStoreError({
          operation: "assert-current",
          kind: binding?.trustState === "revoked" ? "binding-revoked" : "binding-not-found",
        });
      }
      return binding;
    },
    Effect.mapError((cause) => storeFailure("assert-current", cause)),
  );

  const revoke: WorkspaceBindingStore["Service"]["revoke"] = Effect.fn(
    "WorkspaceBindingStore.revoke",
  )(
    function* (bindingId) {
      const observedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE scient_workspace_bindings
        SET trust_state = 'revoked',
            authority_generation = authority_generation + 1,
            last_verified_at = ${observedAt}
        WHERE binding_id = ${bindingId} AND superseded_by IS NULL
      `;
      const binding = yield* getByIdInternal(bindingId);
      if (!binding || binding.supersededBy !== null) {
        return yield* new WorkspaceBindingStoreError({
          operation: "revoke",
          kind: "binding-not-found",
        });
      }
      return binding;
    },
    Effect.mapError((cause) => storeFailure("revoke", cause)),
  );

  const getById: WorkspaceBindingStore["Service"]["getById"] = (bindingId) =>
    getByIdInternal(bindingId).pipe(Effect.mapError((cause) => storeFailure("get-by-id", cause)));

  const getActiveByRoot: WorkspaceBindingStore["Service"]["getActiveByRoot"] = Effect.fn(
    "WorkspaceBindingStore.getActiveByRoot",
  )(
    function* (input) {
      const rows = yield* sql.unsafe<StoredWorkspaceBindingRow>(
        `SELECT ${selectColumns} FROM scient_workspace_bindings
       WHERE environment_id = ? AND canonical_root = ? AND superseded_by IS NULL`,
        [input.environmentId, input.canonicalRoot],
      );
      return rows[0] ? yield* decodeRow(rows[0]) : null;
    },
    Effect.mapError((cause) => storeFailure("get-active-by-root", cause)),
  );

  const listByScientProjectId: WorkspaceBindingStore["Service"]["listByScientProjectId"] =
    Effect.fn("WorkspaceBindingStore.listByScientProjectId")(
      function* (input) {
        return yield* listByScientProjectIdInternal({
          ...input,
          includeSuperseded: input.includeSuperseded ?? false,
        });
      },
      Effect.mapError((cause) => storeFailure("list-by-scient-project-id", cause)),
    );

  return WorkspaceBindingStore.of({
    verifyObserved,
    confirmReplacement,
    assertCurrent,
    revoke,
    getById,
    getActiveByRoot,
    listByScientProjectId,
  });
});

export const layer = Layer.effect(WorkspaceBindingStore, make);
