import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  type ObservedWorkspaceEvidence,
  WorkspaceAuthorityScopeRevision,
  WorkspaceBindingResolutionError,
} from "./WorkspaceBinding.ts";
import * as WorkspaceAuthorityProjection from "./WorkspaceAuthorityProjection.ts";
import * as WorkspaceBindingEvidence from "./WorkspaceBindingEvidence.ts";
import {
  WorkspaceBindingResolver,
  layer as workspaceBindingResolverLayer,
} from "./WorkspaceBindingResolver.ts";
import * as WorkspaceBindingStore from "./WorkspaceBindingStore.ts";

const ENVIRONMENT_ID = EnvironmentId.make("workspace-resolver-environment");
const PROJECT_ID = ProjectId.make("workspace-resolver-project");
const PARENT_THREAD_ID = ThreadId.make("workspace-resolver-parent");
const CHILD_THREAD_ID = ThreadId.make("workspace-resolver-child");
const SCIENT_PROJECT_ID = "41989ba8-b913-4d8a-adde-71d2d7791983";

interface ResolverState {
  readonly projects: Map<string, OrchestrationProjectShell>;
  readonly threads: Map<string, OrchestrationThreadShell>;
  readonly evidence: Map<string, ObservedWorkspaceEvidence>;
  readonly inspectedRoots: Array<string>;
  readonly scopeRevisions: Map<string, number>;
}

const project = (workspaceRoot: string): OrchestrationProjectShell =>
  ({ id: PROJECT_ID, workspaceRoot }) as OrchestrationProjectShell;

const thread = (input: {
  readonly id: typeof PARENT_THREAD_ID;
  readonly projectId: typeof PROJECT_ID | null;
  readonly worktreePath: string | null;
}): OrchestrationThreadShell =>
  ({
    id: input.id,
    projectId: input.projectId,
    worktreePath: input.worktreePath,
  }) as OrchestrationThreadShell;

const observed = (
  canonicalRoot: string,
  input: Partial<ObservedWorkspaceEvidence> = {},
): ObservedWorkspaceEvidence => ({
  canonicalRoot,
  rootFileSystemIdentity: { device: "1", inode: canonicalRoot },
  scientProjectId: SCIENT_PROJECT_ID,
  scientProjectIdentityState: "initialized",
  repositoryIdentity: {
    canonicalKey: "github.com/scientfactory/example",
    source: "git-remote",
    remoteName: "origin",
  },
  worktreeIdentity: {
    kind: "git",
    rootPath: canonicalRoot,
    metadataPath: "/repositories/example/.git",
  },
  trustState: "verified",
  observedAt: "2026-08-29T12:00:00.000Z",
  ...input,
});

const makeResolverLayer = (state: ResolverState) => {
  const environmentLayer = Layer.succeed(
    ServerEnvironment.ServerEnvironment,
    ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
      getDescriptor: Effect.die("unused"),
    }),
  );
  const authorityProjectionLayer = Layer.succeed(
    WorkspaceAuthorityProjection.WorkspaceAuthorityProjection,
    WorkspaceAuthorityProjection.WorkspaceAuthorityProjection.of({
      listRegisteredRoots: () =>
        Effect.sync(() => [
          ...[...state.projects.values()].map((entry) => ({
            projectId: entry.id,
            threadId: null,
            workspaceRoot: entry.workspaceRoot,
          })),
          ...[...state.threads.values()].flatMap((entry) =>
            entry.projectId !== null &&
            entry.worktreePath !== null &&
            state.projects.has(entry.projectId)
              ? [
                  {
                    projectId: entry.projectId,
                    threadId: entry.id,
                    workspaceRoot: entry.worktreePath,
                  },
                ]
              : [],
          ),
        ]),
      getProjectContext: (projectId) =>
        Effect.sync(() => {
          const current = state.projects.get(projectId);
          return current === undefined
            ? Option.none()
            : Option.some({
                projectId,
                workspaceRoot: current.workspaceRoot,
                scopeRevision: WorkspaceAuthorityScopeRevision.make(
                  state.scopeRevisions.get(projectId) ?? 1,
                ),
              });
        }),
      getThreadContext: (threadId) => {
        const currentThread = state.threads.get(threadId);
        if (currentThread === undefined) return Effect.succeed(Option.none());
        const currentProject =
          currentThread.projectId === null
            ? undefined
            : state.projects.get(currentThread.projectId);
        return Effect.succeed(
          Option.some({
            threadId,
            projectId: currentThread.projectId,
            worktreePath: currentThread.worktreePath,
            projectWorkspaceRoot: currentProject?.workspaceRoot ?? null,
            scopeRevision: WorkspaceAuthorityScopeRevision.make(
              state.scopeRevisions.get(threadId) ?? 1,
            ),
          }),
        );
      },
    }),
  );
  const evidenceLayer = Layer.succeed(
    WorkspaceBindingEvidence.WorkspaceBindingEvidence,
    WorkspaceBindingEvidence.WorkspaceBindingEvidence.of({
      inspect: (root) => {
        state.inspectedRoots.push(root);
        const evidence = state.evidence.get(root);
        return evidence
          ? Effect.succeed(evidence)
          : Effect.fail(
              new WorkspaceBindingResolutionError({
                operation: "test-inspect",
                kind: "workspace-unavailable",
              }),
            );
      },
    }),
  );
  const storeLayer = WorkspaceBindingStore.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  );

  return workspaceBindingResolverLayer.pipe(
    Layer.provide(
      Layer.mergeAll(environmentLayer, authorityProjectionLayer, evidenceLayer, storeLayer),
    ),
    Layer.provide(NodeServices.layer),
  );
};

const stateFor = (
  input: {
    readonly projectRoot?: string;
    readonly parentRoot?: string | null;
    readonly parentProjectId?: typeof PROJECT_ID | null;
  } = {},
): ResolverState => {
  const projectRoot = input.projectRoot ?? "/projects/example";
  const parentRoot = input.parentRoot === undefined ? "/worktrees/current" : input.parentRoot;
  const effectiveRoot = parentRoot ?? projectRoot;
  return {
    projects: new Map([[PROJECT_ID, project(projectRoot)]]),
    threads: new Map([
      [
        PARENT_THREAD_ID,
        thread({
          id: PARENT_THREAD_ID,
          projectId: input.parentProjectId === undefined ? PROJECT_ID : input.parentProjectId,
          worktreePath: parentRoot,
        }),
      ],
    ]),
    evidence: new Map([
      [projectRoot, observed(projectRoot)],
      [effectiveRoot, observed(effectiveRoot)],
    ]),
    inspectedRoots: [],
    scopeRevisions: new Map([[PARENT_THREAD_ID, 1]]),
  };
};

const resolveParentThreadWith = (state: ResolverState) =>
  Effect.flatMap(WorkspaceBindingResolver, (resolver) =>
    resolver.resolveThread(PARENT_THREAD_ID),
  ).pipe(Effect.provide(makeResolverLayer(state)));

describe("WorkspaceBindingResolver", () => {
  it.effect(
    "reassociates a re-added folder only after its old host registration is inactive",
    () => {
      const state = stateFor({ parentRoot: null });
      return Effect.gen(function* () {
        const resolver = yield* WorkspaceBindingResolver;
        const first = yield* resolver.resolveThread(PARENT_THREAD_ID);
        const replacementId = ProjectId.make("re-added-project");
        state.projects.set(replacementId, { ...project("/projects/example"), id: replacementId });
        state.threads.set(
          PARENT_THREAD_ID,
          thread({
            id: PARENT_THREAD_ID,
            projectId: replacementId,
            worktreePath: null,
          }),
        );
        expect(yield* resolver.resolveThread(PARENT_THREAD_ID).pipe(Effect.flip)).toMatchObject({
          kind: "root-conflict",
        });
        state.projects.delete(PROJECT_ID);
        const readded = yield* resolver.resolveThread(PARENT_THREAD_ID);
        expect(readded.binding.bindingId).toBe(first.binding.bindingId);
        expect(readded.binding.hostProjectId).toBe(replacementId);
        expect(readded.binding.authorityGeneration).toBe(first.binding.authorityGeneration + 1);
        expect(
          yield* resolver
            .assertCurrentThreadScope({
              threadId: PARENT_THREAD_ID,
              bindingId: first.binding.bindingId,
              authorityGeneration: first.binding.authorityGeneration,
              scopeRevision: first.scopeRevision,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ kind: "stale-authority" });
      }).pipe(Effect.provide(makeResolverLayer(state)));
    },
  );

  it.effect("reassociates a root after its former project moves elsewhere", () => {
    const state = stateFor({ parentRoot: null });
    state.evidence.set("/projects/moved", observed("/projects/moved"));
    return Effect.gen(function* () {
      const resolver = yield* WorkspaceBindingResolver;
      const first = yield* resolver.resolveThread(PARENT_THREAD_ID);
      state.projects.set(PROJECT_ID, project("/projects/moved"));
      const replacementId = ProjectId.make("replacement-project");
      state.projects.set(replacementId, { ...project("/projects/example"), id: replacementId });
      state.threads.set(
        PARENT_THREAD_ID,
        thread({
          id: PARENT_THREAD_ID,
          projectId: replacementId,
          worktreePath: null,
        }),
      );
      state.scopeRevisions.set(PARENT_THREAD_ID, 2);

      const reassociated = yield* resolver.resolveThread(PARENT_THREAD_ID);
      expect(reassociated.binding.bindingId).toBe(first.binding.bindingId);
      expect(reassociated.binding.hostProjectId).toBe(replacementId);
      expect(reassociated.binding.authorityGeneration).toBe(first.binding.authorityGeneration + 1);
    }).pipe(Effect.provide(makeResolverLayer(state)));
  });

  it.effect("rejects reassociation while another registered project still claims the root", () => {
    const state = stateFor({ parentRoot: null });
    state.evidence.set("/projects/moved", observed("/projects/moved"));
    return Effect.gen(function* () {
      const resolver = yield* WorkspaceBindingResolver;
      yield* resolver.resolveThread(PARENT_THREAD_ID);
      state.projects.set(PROJECT_ID, project("/projects/moved"));
      const competingId = ProjectId.make("competing-project");
      state.projects.set(competingId, { ...project("/projects/example"), id: competingId });
      const replacementId = ProjectId.make("replacement-project");
      state.projects.set(replacementId, { ...project("/projects/example"), id: replacementId });
      state.threads.set(
        PARENT_THREAD_ID,
        thread({
          id: PARENT_THREAD_ID,
          projectId: replacementId,
          worktreePath: null,
        }),
      );

      expect(yield* resolver.resolveThread(PARENT_THREAD_ID).pipe(Effect.flip)).toMatchObject({
        kind: "root-conflict",
      });
    }).pipe(Effect.provide(makeResolverLayer(state)));
  });

  it.effect("resolves registered UI roots and aliases without making cwd an authority", () => {
    const state = stateFor({ parentRoot: null });
    state.evidence.set("/alias", observed("/projects/example"));
    state.evidence.set("/unregistered", observed("/unregistered"));
    return Effect.gen(function* () {
      const resolver = yield* WorkspaceBindingResolver;
      const direct = yield* resolver.resolveWorkspaceRoot("/projects/example");
      expect(state.inspectedRoots).toEqual(["/projects/example"]);
      const alias = yield* resolver.resolveWorkspaceRoot("/alias");
      const threadBinding = yield* resolver.resolveThread(PARENT_THREAD_ID);
      expect(alias.binding.bindingId).toBe(direct.binding.bindingId);
      expect(threadBinding.binding.bindingId).toBe(direct.binding.bindingId);
      expect(yield* resolver.resolveWorkspaceRoot("/unregistered").pipe(Effect.flip)).toMatchObject(
        { kind: "project-not-found" },
      );
    }).pipe(Effect.provide(makeResolverLayer(state)));
  });

  it.effect(
    "reuses verified thread worktrees but rejects unrelated registered worktree claims",
    () => {
      const state = stateFor();
      return Effect.gen(function* () {
        const resolver = yield* WorkspaceBindingResolver;
        const root = yield* resolver.resolveWorkspaceRoot("/worktrees/current");
        const threadBinding = yield* resolver.resolveThread(PARENT_THREAD_ID);
        expect(root.binding.bindingId).toBe(threadBinding.binding.bindingId);
        state.evidence.set(
          "/worktrees/current",
          observed("/worktrees/current", {
            worktreeIdentity: {
              kind: "git",
              rootPath: "/worktrees/current",
              metadataPath: "/other/.git",
            },
          }),
        );
        expect(
          yield* resolver.resolveWorkspaceRoot("/worktrees/current").pipe(Effect.flip),
        ).toMatchObject({ kind: "lineage-conflict" });
      }).pipe(Effect.provide(makeResolverLayer(state)));
    },
  );

  it.effect(
    "fences UI receipts after root replacement, removal, and A-to-B-to-A project changes",
    () => {
      const state = stateFor({ parentRoot: null });
      return Effect.gen(function* () {
        const resolver = yield* WorkspaceBindingResolver;
        const current = yield* resolver.resolveWorkspaceRoot("/projects/example");
        const receipt = {
          workspaceRoot: current.binding.canonicalRoot,
          bindingId: current.binding.bindingId,
          authorityGeneration: current.binding.authorityGeneration,
          scopeRevision: current.scopeRevision,
        };
        yield* resolver.assertCurrentWorkspaceScope(receipt);
        state.scopeRevisions.set(PROJECT_ID, 3);
        expect(
          yield* resolver.assertCurrentWorkspaceScope(receipt).pipe(Effect.flip),
        ).toMatchObject({ kind: "stale-authority" });
        state.scopeRevisions.set(PROJECT_ID, 1);
        state.evidence.set(
          "/projects/example",
          observed("/projects/example", {
            rootFileSystemIdentity: { device: "1", inode: "replacement" },
          }),
        );
        expect(
          yield* resolver.assertCurrentWorkspaceScope(receipt).pipe(Effect.flip),
        ).toMatchObject({ kind: "stale-authority" });
        state.projects.clear();
        expect(
          yield* resolver.assertCurrentWorkspaceScope(receipt).pipe(Effect.flip),
        ).toMatchObject({ kind: "project-not-found" });
      }).pipe(Effect.provide(makeResolverLayer(state)));
    },
  );

  it.effect(
    "keeps copied project IDs in separate roots isolated under concurrent resolution",
    () => {
      const state = stateFor({ parentRoot: null });
      const otherId = ProjectId.make("other-host-project");
      state.projects.set(otherId, { ...project("/projects/other"), id: otherId });
      state.evidence.set("/projects/other", observed("/projects/other"));
      return Effect.gen(function* () {
        const resolver = yield* WorkspaceBindingResolver;
        const resolved = yield* Effect.forEach(
          Array.from({ length: 100 }, (_, index) => index),
          (index) =>
            resolver.resolveWorkspaceRoot(
              index % 2 === 0 ? "/projects/example" : "/projects/other",
            ),
          { concurrency: 8 },
        );
        expect(new Set(resolved.map((entry) => entry.binding.bindingId)).size).toBe(2);
        expect(
          new Set(
            resolved.filter((_, index) => index % 2 === 0).map((entry) => entry.binding.bindingId),
          ).size,
        ).toBe(1);
        expect(new Set(resolved.map((entry) => entry.binding.scientProjectId)).size).toBe(1);
        state.projects.set(otherId, { ...project("/projects/example"), id: otherId });
        expect(
          yield* resolver.resolveWorkspaceRoot("/projects/example").pipe(Effect.flip),
        ).toMatchObject({ kind: "lineage-conflict" });
      }).pipe(Effect.provide(makeResolverLayer(state)));
    },
  );

  it.effect("derives authority from a verified worktree in the project repository", () => {
    const state = stateFor();
    return Effect.gen(function* () {
      const resolved = yield* (yield* WorkspaceBindingResolver).resolveThread(PARENT_THREAD_ID);

      expect(resolved.binding.canonicalRoot).toBe("/worktrees/current");
      expect(state.inspectedRoots).toEqual(["/projects/example", "/worktrees/current"]);
    }).pipe(Effect.provide(makeResolverLayer(state)));
  });

  it.effect("falls back to the host project root for a non-worktree thread", () => {
    const state = stateFor({ parentRoot: null });
    state.evidence.set(
      "/projects/example",
      observed("/projects/example", {
        scientProjectId: null,
        scientProjectIdentityState: "ordinary",
        repositoryIdentity: null,
        worktreeIdentity: null,
      }),
    );
    return Effect.gen(function* () {
      const resolved = yield* (yield* WorkspaceBindingResolver).resolveThread(PARENT_THREAD_ID);

      expect(resolved.binding.canonicalRoot).toBe("/projects/example");
      expect(resolved.binding.scientProjectId).toBeNull();
      expect(state.inspectedRoots).toEqual(["/projects/example"]);
    }).pipe(Effect.provide(makeResolverLayer(state)));
  });

  it.effect("fails closed for a removed thread, projectless thread, or missing project", () => {
    const removed = stateFor();
    removed.threads.clear();
    const projectless = stateFor({ parentProjectId: null });
    const missingProject = stateFor();
    missingProject.projects.clear();

    return Effect.gen(function* () {
      const removedError = yield* resolveParentThreadWith(removed).pipe(Effect.flip);
      const projectlessError = yield* resolveParentThreadWith(projectless).pipe(Effect.flip);
      const missingProjectError = yield* resolveParentThreadWith(missingProject).pipe(Effect.flip);

      expect(removedError).toMatchObject({ kind: "thread-not-found" });
      expect(projectlessError).toMatchObject({ kind: "project-required" });
      expect(missingProjectError).toMatchObject({ kind: "project-not-found" });
      expect(removed.inspectedRoots).toEqual([]);
      expect(projectless.inspectedRoots).toEqual([]);
      expect(missingProject.inspectedRoots).toEqual([]);
    });
  });

  it.effect("fences an authority receipt after the thread changes worktrees", () => {
    const state = stateFor();
    state.evidence.set("/worktrees/replacement", observed("/worktrees/replacement"));
    return Effect.gen(function* () {
      const resolver = yield* WorkspaceBindingResolver;
      const original = yield* resolver.resolveThread(PARENT_THREAD_ID);
      state.threads.set(
        PARENT_THREAD_ID,
        thread({
          id: PARENT_THREAD_ID,
          projectId: PROJECT_ID,
          worktreePath: "/worktrees/replacement",
        }),
      );
      state.scopeRevisions.set(PARENT_THREAD_ID, 2);

      const error = yield* resolver
        .assertCurrentThreadScope({
          threadId: PARENT_THREAD_ID,
          bindingId: original.binding.bindingId,
          authorityGeneration: original.binding.authorityGeneration,
          scopeRevision: original.scopeRevision,
        })
        .pipe(Effect.flip);
      expect(error.kind).toBe("stale-authority");
    }).pipe(Effect.provide(makeResolverLayer(state)));
  });

  it.effect("never revives an old receipt after an A-to-B-to-A transition", () => {
    const state = stateFor({ parentRoot: "/worktrees/a" });
    state.evidence.set("/worktrees/b", observed("/worktrees/b"));
    return Effect.gen(function* () {
      const resolver = yield* WorkspaceBindingResolver;
      const original = yield* resolver.resolveThread(PARENT_THREAD_ID);
      state.threads.set(
        PARENT_THREAD_ID,
        thread({ id: PARENT_THREAD_ID, projectId: PROJECT_ID, worktreePath: "/worktrees/b" }),
      );
      state.scopeRevisions.set(PARENT_THREAD_ID, 2);
      yield* resolver.resolveThread(PARENT_THREAD_ID);
      state.threads.set(
        PARENT_THREAD_ID,
        thread({ id: PARENT_THREAD_ID, projectId: PROJECT_ID, worktreePath: "/worktrees/a" }),
      );
      state.scopeRevisions.set(PARENT_THREAD_ID, 3);

      const error = yield* resolver
        .assertCurrentThreadScope({
          threadId: PARENT_THREAD_ID,
          bindingId: original.binding.bindingId,
          authorityGeneration: original.binding.authorityGeneration,
          scopeRevision: original.scopeRevision,
        })
        .pipe(Effect.flip);
      expect(error.kind).toBe("stale-authority");
    }).pipe(Effect.provide(makeResolverLayer(state)));
  });

  it.effect("rejects an alternate folder that is not a worktree of the selected project", () => {
    const state = stateFor();
    state.evidence.set(
      "/worktrees/current",
      observed("/worktrees/current", {
        repositoryIdentity: null,
        worktreeIdentity: null,
      }),
    );
    return Effect.gen(function* () {
      const error = yield* (yield* WorkspaceBindingResolver)
        .resolveThread(PARENT_THREAD_ID)
        .pipe(Effect.flip);
      expect(error.kind).toBe("lineage-conflict");
    }).pipe(Effect.provide(makeResolverLayer(state)));
  });

  it.effect("does not widen a saved subdirectory project to an entire worktree", () => {
    const state = stateFor({ projectRoot: "/repositories/example/packages/scient" });
    state.evidence.set(
      "/repositories/example/packages/scient",
      observed("/repositories/example/packages/scient", {
        worktreeIdentity: {
          kind: "git",
          rootPath: "/repositories/example",
          metadataPath: "/repositories/example/.git",
        },
      }),
    );
    return Effect.gen(function* () {
      const error = yield* (yield* WorkspaceBindingResolver)
        .resolveThread(PARENT_THREAD_ID)
        .pipe(Effect.flip);
      expect(error.kind).toBe("lineage-conflict");
    }).pipe(Effect.provide(makeResolverLayer(state)));
  });

  it.effect("rejects a worktree from a different repository", () => {
    const state = stateFor();
    state.evidence.set(
      "/worktrees/current",
      observed("/worktrees/current", {
        repositoryIdentity: {
          canonicalKey: "github.com/scientfactory/other",
          source: "git-remote",
          remoteName: "origin",
        },
        worktreeIdentity: {
          kind: "git",
          rootPath: "/worktrees/current",
          metadataPath: "/repositories/other/.git",
        },
      }),
    );
    return Effect.gen(function* () {
      const error = yield* (yield* WorkspaceBindingResolver)
        .resolveThread(PARENT_THREAD_ID)
        .pipe(Effect.flip);
      expect(error.kind).toBe("lineage-conflict");
    }).pipe(Effect.provide(makeResolverLayer(state)));
  });

  it.effect("derives trusted lineage from a currently verified parent thread", () => {
    const state = stateFor({ parentRoot: "/repository/main" });
    state.threads.set(
      CHILD_THREAD_ID,
      thread({ id: CHILD_THREAD_ID, projectId: PROJECT_ID, worktreePath: "/repository/child" }),
    );
    state.evidence.set("/repository/child", observed("/repository/child"));

    return Effect.gen(function* () {
      const child = yield* (yield* WorkspaceBindingResolver).resolveTrustedChild({
        parentThreadId: PARENT_THREAD_ID,
        childThreadId: CHILD_THREAD_ID,
      });

      expect(child.binding.lineageBindingId).not.toBeNull();
      expect(child.relation).toBe("trusted-lineage");
    }).pipe(Effect.provide(makeResolverLayer(state)));
  });

  it.effect("rejects a copied UUID when the child is not a shared VCS worktree", () => {
    const state = stateFor({ parentRoot: "/repository/main" });
    state.threads.set(
      CHILD_THREAD_ID,
      thread({ id: CHILD_THREAD_ID, projectId: PROJECT_ID, worktreePath: "/independent/clone" }),
    );
    state.evidence.set(
      "/independent/clone",
      observed("/independent/clone", {
        worktreeIdentity: {
          kind: "git",
          rootPath: "/independent/clone",
          metadataPath: "/independent/clone/.git",
        },
      }),
    );

    return Effect.gen(function* () {
      const error = yield* (yield* WorkspaceBindingResolver)
        .resolveTrustedChild({
          parentThreadId: PARENT_THREAD_ID,
          childThreadId: CHILD_THREAD_ID,
        })
        .pipe(Effect.flip);

      expect(error.kind).toBe("lineage-conflict");
    }).pipe(Effect.provide(makeResolverLayer(state)));
  });

  it.effect("returns useful diagnostics without exposing roots or remote URLs", () => {
    const state = stateFor();
    return Effect.gen(function* () {
      const diagnostics = yield* (yield* WorkspaceBindingResolver).diagnosticsForThread(
        PARENT_THREAD_ID,
      );
      expect(diagnostics.binding.authorityGeneration).toBe(1);
      expect(diagnostics.binding.hasRepositoryEvidence).toBe(true);
      expect(diagnostics.binding.hasRootFileSystemIdentity).toBe(true);
      expect(diagnostics.binding).not.toHaveProperty("canonicalRoot");
      expect(diagnostics.binding).not.toHaveProperty("rootFileSystemIdentity");
      expect(diagnostics.binding).not.toHaveProperty("repositoryKey");
      expect(diagnostics.binding).not.toHaveProperty("repositoryIdentity");
      expect(diagnostics.binding).not.toHaveProperty("worktreeIdentity");
    }).pipe(Effect.provide(makeResolverLayer(state)));
  });
});
