import {
  WorkspaceAuthorityGeneration,
  WorkspaceAuthorityScopeRevision,
  WorkspaceBindingId,
  type WorkspaceScope,
} from "@scientfactory/operations";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  WorkspaceBindingResolutionError,
  type WorkspaceBindingRecordV1,
} from "./WorkspaceBinding.ts";
import { WorkspaceBindingResolver } from "./WorkspaceBindingResolver.ts";

/** Explicit fake authority for domain unit tests, never provided by production layers. */
export const workspaceScopeForTest = (
  bindingId: string,
  workspaceRoot: string,
): WorkspaceScope => ({
  bindingId: WorkspaceBindingId.make(bindingId),
  authorityGeneration: WorkspaceAuthorityGeneration.make(1),
  scopeRevision: WorkspaceAuthorityScopeRevision.make(1),
  workspaceRoot,
});

export const workspaceResolverForTest = (
  entries: ReadonlyMap<
    string,
    { readonly projectId: string | null; readonly scope: WorkspaceScope }
  >,
): WorkspaceBindingResolver["Service"] => {
  const resolveWorkspaceRoot: WorkspaceBindingResolver["Service"]["resolveWorkspaceRoot"] = (
    root,
  ) =>
    Effect.gen(function* () {
      const entry = entries.get(root);
      if (entry === undefined)
        return yield* new WorkspaceBindingResolutionError({
          operation: "test-resolve",
          kind: "project-not-found",
        });
      const binding: WorkspaceBindingRecordV1 = {
        schemaVersion: 1,
        bindingId: entry.scope.bindingId,
        environmentId: EnvironmentId.make("test-environment"),
        hostProjectId: ProjectId.make(`host-${entry.scope.bindingId}`),
        canonicalRoot: entry.scope.workspaceRoot,
        rootFileSystemIdentity: null,
        scientProjectId: entry.projectId,
        repositoryIdentity: null,
        worktreeIdentity: null,
        lineageBindingId: null,
        trustState: "verified",
        authorityGeneration: entry.scope.authorityGeneration,
        createdAt: "2026-08-31T00:00:00.000Z",
        lastVerifiedAt: "2026-08-31T00:00:00.000Z",
        supersededBy: null,
      };
      return {
        binding,
        relation: "only-binding" as const,
        relatedBindingCount: 0,
        scopeRevision: entry.scope.scopeRevision,
      };
    });
  return WorkspaceBindingResolver.of({
    resolveWorkspaceRoot,
    assertCurrentWorkspaceScope: (scope) =>
      resolveWorkspaceRoot(scope.workspaceRoot).pipe(
        Effect.flatMap((current) =>
          current.binding.bindingId === scope.bindingId &&
          current.binding.authorityGeneration === scope.authorityGeneration &&
          current.scopeRevision === scope.scopeRevision
            ? Effect.succeed(current.binding)
            : Effect.fail(
                new WorkspaceBindingResolutionError({
                  operation: "test-assert",
                  kind: "stale-authority",
                }),
              ),
        ),
      ),
    resolveThread: () => Effect.die("Thread authority is not part of this unit-test fixture."),
    resolveTrustedChild: () => Effect.die("unused"),
    assertCurrentThreadScope: () => Effect.die("unused"),
    diagnosticsForThread: () => Effect.die("unused"),
  });
};
