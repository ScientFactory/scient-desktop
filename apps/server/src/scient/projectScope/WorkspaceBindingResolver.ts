import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import {
  type ObservedWorkspaceEvidence,
  type ResolvedThreadWorkspaceBinding,
  type ResolvedWorkspaceBinding,
  type WorkspaceAuthorityScopeRevision,
  type WorkspaceBindingId,
  type WorkspaceBindingRecordV1,
  type WorkspaceBindingSafeDiagnostic,
  WorkspaceBindingResolutionError,
  type WorkspaceBindingStoreError,
  toSafeWorkspaceBindingDiagnostic,
} from "./WorkspaceBinding.ts";
import * as WorkspaceAuthorityProjection from "./WorkspaceAuthorityProjection.ts";
import * as WorkspaceBindingEvidence from "./WorkspaceBindingEvidence.ts";
import * as WorkspaceBindingStore from "./WorkspaceBindingStore.ts";

export interface WorkspaceBindingDiagnosticResolution {
  readonly binding: WorkspaceBindingSafeDiagnostic;
  readonly relation: ResolvedWorkspaceBinding["relation"];
  readonly relatedBindingCount: number;
}

type ResolverError = WorkspaceBindingResolutionError | WorkspaceBindingStoreError;

export class WorkspaceBindingResolver extends Context.Service<
  WorkspaceBindingResolver,
  {
    /** UI/environment selector only. Agent adapters must use resolveThread. */
    readonly resolveWorkspaceRoot: (
      workspaceRoot: string,
    ) => Effect.Effect<ResolvedThreadWorkspaceBinding, ResolverError>;
    readonly assertCurrentWorkspaceScope: (input: {
      readonly workspaceRoot: string;
      readonly bindingId: WorkspaceBindingId;
      readonly authorityGeneration: WorkspaceBindingRecordV1["authorityGeneration"];
      readonly scopeRevision: WorkspaceAuthorityScopeRevision;
    }) => Effect.Effect<WorkspaceBindingRecordV1, ResolverError>;
    readonly resolveThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ResolvedThreadWorkspaceBinding, ResolverError>;
    /** Used only by the host path that created a child worktree. */
    readonly resolveTrustedChild: (input: {
      readonly parentThreadId: ThreadId;
      readonly childThreadId: ThreadId;
    }) => Effect.Effect<ResolvedThreadWorkspaceBinding, ResolverError>;
    readonly assertCurrentThreadScope: (input: {
      readonly threadId: ThreadId;
      readonly bindingId: WorkspaceBindingId;
      readonly authorityGeneration: WorkspaceBindingRecordV1["authorityGeneration"];
      readonly scopeRevision: WorkspaceAuthorityScopeRevision;
    }) => Effect.Effect<WorkspaceBindingRecordV1, ResolverError>;
    readonly diagnosticsForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<WorkspaceBindingDiagnosticResolution, ResolverError>;
  }
>()("t3/scient/projectScope/WorkspaceBindingResolver") {}

const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const authorityProjection = yield* WorkspaceAuthorityProjection.WorkspaceAuthorityProjection;
  const evidence = yield* WorkspaceBindingEvidence.WorkspaceBindingEvidence;
  const bindings = yield* WorkspaceBindingStore.WorkspaceBindingStore;
  const fs = yield* FileSystem.FileSystem;

  const verifyObserved = Effect.fn("WorkspaceBindingResolver.verifyObserved")(function* (
    input: WorkspaceBindingStore.VerifyObservedWorkspaceInput,
  ) {
    return yield* bindings.verifyObserved(input).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (error.kind !== "root-conflict") return yield* error;
          const previous = yield* bindings.getActiveByRoot({
            environmentId: input.environmentId,
            canonicalRoot: input.evidence.canonicalRoot,
          });
          if (!previous || previous.hostProjectId === input.hostProjectId) return yield* error;
          const registration = yield* authorityProjection.getProjectContext(previous.hostProjectId);
          if (Option.isSome(registration)) return yield* error;
          return yield* bindings.verifyObserved({
            ...input,
            reassociateBindingId: previous.bindingId,
          });
        }),
      ),
    );
  });

  const belongsToProjectWorktreeLineage = (
    project: ObservedWorkspaceEvidence,
    selected: ObservedWorkspaceEvidence,
  ): boolean => {
    if (project.trustState !== "verified" || selected.trustState !== "verified") return false;
    const projectWorktree = project.worktreeIdentity;
    const selectedWorktree = selected.worktreeIdentity;
    if (projectWorktree === null || selectedWorktree === null) return false;
    // A saved subdirectory project must never become a grant over the entire
    // alternate checkout. Supporting that shape requires an explicit,
    // relative-scope mapping rather than silently widening the authority root.
    if (projectWorktree.rootPath !== project.canonicalRoot) return false;
    if (selectedWorktree.rootPath !== selected.canonicalRoot) return false;
    if (projectWorktree.kind !== selectedWorktree.kind) return false;
    if (
      projectWorktree.metadataPath === null ||
      selectedWorktree.metadataPath === null ||
      projectWorktree.metadataPath !== selectedWorktree.metadataPath
    ) {
      return false;
    }
    if (
      project.repositoryIdentity !== null &&
      selected.repositoryIdentity !== null &&
      project.repositoryIdentity.canonicalKey !== selected.repositoryIdentity.canonicalKey
    ) {
      return false;
    }
    if (
      project.scientProjectId !== null &&
      selected.scientProjectId !== null &&
      project.scientProjectId !== selected.scientProjectId
    ) {
      return false;
    }
    return true;
  };

  const resolve = Effect.fn("WorkspaceBindingResolver.resolve")(function* (input: {
    readonly threadId: ThreadId;
    readonly lineageBindingId: WorkspaceBindingId | null;
  }): Effect.fn.Return<ResolvedThreadWorkspaceBinding, ResolverError> {
    const environmentId = yield* environment.getEnvironmentId;
    const context = yield* authorityProjection.getThreadContext(input.threadId);
    if (Option.isNone(context)) {
      return yield* new WorkspaceBindingResolutionError({
        operation: "resolve-thread",
        kind: "thread-not-found",
      });
    }
    if (context.value.projectId === null) {
      return yield* new WorkspaceBindingResolutionError({
        operation: "resolve-thread",
        kind: "project-required",
      });
    }
    if (context.value.projectWorkspaceRoot === null) {
      return yield* new WorkspaceBindingResolutionError({
        operation: "resolve-project",
        kind: "project-not-found",
      });
    }

    const projectObserved = yield* evidence.inspect(context.value.projectWorkspaceRoot);
    const observed =
      context.value.worktreePath === null
        ? projectObserved
        : yield* evidence.inspect(context.value.worktreePath);
    if (
      observed.canonicalRoot !== projectObserved.canonicalRoot &&
      !belongsToProjectWorktreeLineage(projectObserved, observed)
    ) {
      return yield* new WorkspaceBindingResolutionError({
        operation: "verify-worktree-lineage",
        kind: "lineage-conflict",
      });
    }

    const resolved = yield* verifyObserved({
      environmentId,
      hostProjectId: context.value.projectId,
      evidence: observed,
      lineageBindingId: input.lineageBindingId,
    });
    return { ...resolved, scopeRevision: context.value.scopeRevision };
  });

  const resolveThread: WorkspaceBindingResolver["Service"]["resolveThread"] = (threadId) =>
    resolve({ threadId, lineageBindingId: null });

  const resolveWorkspaceRoot = Effect.fn("WorkspaceBindingResolver.resolveWorkspaceRoot")(
    function* (
      workspaceRoot: string,
    ): Effect.fn.Return<ResolvedThreadWorkspaceBinding, ResolverError> {
      const selected = yield* evidence.inspect(workspaceRoot);
      const roots = yield* authorityProjection.listRegisteredRoots();
      // Match only host-registered roots, including canonical aliases. A cwd
      // chooses a workspace; it never registers or grants one.
      const matches = (yield* Effect.forEach(
        roots,
        (root) =>
          Effect.gen(function* () {
            if (
              root.workspaceRoot === selected.canonicalRoot ||
              root.workspaceRoot === workspaceRoot
            )
              return root;
            const canonical = yield* fs.realPath(root.workspaceRoot).pipe(Effect.option);
            return Option.isSome(canonical) && canonical.value === selected.canonicalRoot
              ? root
              : null;
          }),
        { concurrency: 8 },
      )).filter((root) => root !== null);
      if (matches.length === 0) {
        return yield* new WorkspaceBindingResolutionError({
          operation: "resolve-workspace-root",
          kind: "project-not-found",
        });
      }
      if (new Set(matches.map((root) => root.projectId)).size !== 1) {
        return yield* new WorkspaceBindingResolutionError({
          operation: "resolve-workspace-root",
          kind: "lineage-conflict",
        });
      }
      const root = matches.find((candidate) => candidate.threadId === null) ?? matches[0]!;
      let resolved: ResolvedThreadWorkspaceBinding;
      if (root.threadId !== null) {
        resolved = yield* resolveThread(root.threadId);
      } else {
        const project = yield* authorityProjection.getProjectContext(root.projectId);
        if (Option.isNone(project)) {
          return yield* new WorkspaceBindingResolutionError({
            operation: "resolve-workspace-root",
            kind: "project-not-found",
          });
        }
        // Reuse this call's observation when it already names the registered
        // project root. This is not a cross-call cache or a publication fence.
        const observed =
          project.value.workspaceRoot === workspaceRoot ||
          project.value.workspaceRoot === selected.canonicalRoot
            ? selected
            : yield* evidence.inspect(project.value.workspaceRoot);
        const environmentId = yield* environment.getEnvironmentId;
        const binding = yield* verifyObserved({
          environmentId,
          hostProjectId: root.projectId,
          evidence: observed,
        });
        resolved = { ...binding, scopeRevision: project.value.scopeRevision };
      }
      if (
        resolved.binding.canonicalRoot !== selected.canonicalRoot ||
        resolved.binding.trustState !== "verified"
      ) {
        return yield* new WorkspaceBindingResolutionError({
          operation: "resolve-workspace-root",
          kind: "stale-authority",
        });
      }
      return resolved;
    },
  );

  const assertCurrentWorkspaceScope: WorkspaceBindingResolver["Service"]["assertCurrentWorkspaceScope"] =
    Effect.fn("WorkspaceBindingResolver.assertCurrentWorkspaceScope")(function* (input) {
      const current = yield* resolveWorkspaceRoot(input.workspaceRoot);
      if (
        current.binding.bindingId !== input.bindingId ||
        current.binding.authorityGeneration !== input.authorityGeneration ||
        current.scopeRevision !== input.scopeRevision ||
        current.binding.supersededBy !== null
      ) {
        return yield* new WorkspaceBindingResolutionError({
          operation: "assert-current-workspace-scope",
          kind: "stale-authority",
        });
      }
      return current.binding;
    });

  const resolveTrustedChild: WorkspaceBindingResolver["Service"]["resolveTrustedChild"] = Effect.fn(
    "WorkspaceBindingResolver.resolveTrustedChild",
  )(function* (input) {
    const parent = yield* resolveThread(input.parentThreadId);
    if (parent.binding.trustState !== "verified" || parent.binding.supersededBy !== null) {
      return yield* new WorkspaceBindingResolutionError({
        operation: "resolve-trusted-child",
        kind: "stale-authority",
      });
    }
    return yield* resolve({
      threadId: input.childThreadId,
      lineageBindingId: parent.binding.bindingId,
    });
  });

  const assertCurrentThreadScope: WorkspaceBindingResolver["Service"]["assertCurrentThreadScope"] =
    Effect.fn("WorkspaceBindingResolver.assertCurrentThreadScope")(function* (input) {
      const current = yield* resolveThread(input.threadId);
      if (
        current.binding.bindingId !== input.bindingId ||
        current.binding.authorityGeneration !== input.authorityGeneration ||
        current.scopeRevision !== input.scopeRevision ||
        current.binding.trustState !== "verified" ||
        current.binding.supersededBy !== null
      ) {
        return yield* new WorkspaceBindingResolutionError({
          operation: "assert-current-thread-scope",
          kind: "stale-authority",
        });
      }
      return current.binding;
    });

  const diagnosticsForThread: WorkspaceBindingResolver["Service"]["diagnosticsForThread"] =
    Effect.fn("WorkspaceBindingResolver.diagnosticsForThread")(function* (threadId) {
      const current = yield* resolveThread(threadId);
      return {
        binding: toSafeWorkspaceBindingDiagnostic(current.binding),
        relation: current.relation,
        relatedBindingCount: current.relatedBindingCount,
      };
    });

  return WorkspaceBindingResolver.of({
    resolveWorkspaceRoot,
    assertCurrentWorkspaceScope,
    resolveThread,
    resolveTrustedChild,
    assertCurrentThreadScope,
    diagnosticsForThread,
  });
});

export const layer = Layer.effect(WorkspaceBindingResolver, make);
