// @effect-diagnostics nodeBuiltinImport:off -- synthetic filesystem authority for test fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import { readScientProjectIdentity } from "@scientfactory/project-init";
import { WorkspaceBindingResolutionError } from "../projectScope/WorkspaceBinding.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../projectScope/WorkspaceBindingTestUtils.ts";
import type { WorkspaceBindingResolver } from "../projectScope/WorkspaceBindingResolver.ts";

/** Fixture roots are explicitly selected by tests; production uses host registration. */
export const computeWorkspaceResolverForTest: WorkspaceBindingResolver["Service"] = {
  ...workspaceResolverForTest(new Map()),
  resolveWorkspaceRoot: (root) =>
    Effect.gen(function* () {
      const observed = yield* Effect.tryPromise({
        try: async () => {
          const canonical = await NodeFSP.realpath(root);
          const stat = await NodeFSP.stat(canonical);
          const identity = await readScientProjectIdentity(canonical).catch(() => null);
          const binding = NodeCrypto.createHash("sha256")
            .update(`${canonical}:${stat.dev}:${stat.ino}`)
            .digest("hex");
          return { canonical, binding, projectId: identity?.projectId ?? null };
        },
        catch: (cause) =>
          new WorkspaceBindingResolutionError({
            operation: "test-resolve",
            kind: "workspace-unavailable",
            cause,
          }),
      });
      return yield* workspaceResolverForTest(
        new Map([
          [
            root,
            {
              projectId: observed.projectId,
              scope: workspaceScopeForTest(observed.binding, observed.canonical),
            },
          ],
        ]),
      ).resolveWorkspaceRoot(root);
    }),
  assertCurrentWorkspaceScope: (scope) =>
    Effect.gen(function* () {
      const current = yield* computeWorkspaceResolverForTest.resolveWorkspaceRoot(
        scope.workspaceRoot,
      );
      if (
        scope.bindingId !== current.binding.bindingId ||
        scope.authorityGeneration !== current.binding.authorityGeneration ||
        scope.scopeRevision !== current.scopeRevision
      )
        return yield* new WorkspaceBindingResolutionError({
          operation: "test-assert",
          kind: "stale-authority",
        });
      return current.binding;
    }),
};
