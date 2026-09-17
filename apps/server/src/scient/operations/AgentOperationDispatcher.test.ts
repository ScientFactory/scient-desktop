import { expect, it } from "@effect/vitest";
import type { OperationCapability } from "@scientfactory/operations";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AgentInvocationContext, type AgentInvocationScope } from "./AgentInvocationContext.ts";
import {
  dispatchScientOperation,
  listAvailableScientOperations,
} from "./AgentOperationDispatcher.ts";
import { consumeAgentWorkspace, resolveAgentWorkspace } from "./AgentWorkspaceScope.ts";
import {
  WorkspaceAuthorityScopeRevision,
  WorkspaceBindingRecordV1,
  WorkspaceBindingResolutionError,
  type ResolvedThreadWorkspaceBinding,
} from "../projectScope/WorkspaceBinding.ts";
import { WorkspaceBindingResolver } from "../projectScope/WorkspaceBindingResolver.ts";

const environmentId = EnvironmentId.make("operation-test-environment");
const invocation = (
  thread: string,
  capabilities: ReadonlyArray<OperationCapability>,
): AgentInvocationScope => ({
  environmentId,
  threadId: ThreadId.make(thread),
  providerSessionId: `session:${thread}`,
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
const decodeBinding = Schema.decodeUnknownSync(WorkspaceBindingRecordV1);
const workspace = (thread: string): ResolvedThreadWorkspaceBinding => ({
  binding: decodeBinding({
    schemaVersion: 1,
    bindingId: `binding:${thread}`,
    environmentId,
    hostProjectId: "project",
    canonicalRoot: `/fixture/${thread}`,
    rootFileSystemIdentity: null,
    scientProjectId: "shared-portable-project",
    repositoryIdentity: null,
    worktreeIdentity: null,
    lineageBindingId: null,
    trustState: "verified",
    authorityGeneration: 1,
    createdAt: "2026-08-31T00:00:00.000Z",
    lastVerifiedAt: "2026-08-31T00:00:00.000Z",
    supersededBy: null,
  }),
  scopeRevision: WorkspaceAuthorityScopeRevision.make(1),
  relation: "only-binding",
  relatedBindingCount: 0,
});
const resolver = (
  resolveThread: WorkspaceBindingResolver["Service"]["resolveThread"],
  assertCurrentThreadScope: WorkspaceBindingResolver["Service"]["assertCurrentThreadScope"] = () =>
    Effect.die("Unexpected revalidation"),
): WorkspaceBindingResolver["Service"] => ({
  resolveThread,
  assertCurrentThreadScope,
  resolveWorkspaceRoot: () => Effect.die("An agent cannot select a root"),
  assertCurrentWorkspaceScope: () => Effect.die("Unexpected UI admission"),
  resolveTrustedChild: () => Effect.die("Unexpected child creation"),
  diagnosticsForThread: () => Effect.die("Unexpected diagnostics"),
});

it.effect(
  "denies unknown and ungranted operations before resolving a workspace or invoking a handler",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      for (const id of ["unknown", "sources.remove", "documents.html.build", "browser.click"]) {
        const failure = yield* dispatchScientOperation(
          id,
          Effect.sync(() => calls++),
        ).pipe(Effect.flip);
        expect(failure._tag).toBe("AgentOperationUnavailable");
      }
      expect(calls).toBe(0);
    }).pipe(
      Effect.provideService(AgentInvocationContext, invocation("a", ["sources:read"])),
      Effect.provideService(
        WorkspaceBindingResolver,
        resolver(() => Effect.die("Unexpected resolution")),
      ),
    ),
);

it.effect("does not require a project for Browser or turn-scoped skill reads", () =>
  Effect.gen(function* () {
    const names = (yield* listAvailableScientOperations()).map((operation) => operation.id);
    expect(names).toContain("browser.snapshot");
    expect(names).toContain("skills.load");
    expect(names).not.toContain("sources.list");
    expect(yield* dispatchScientOperation("skills.list", Effect.succeed("skills"))).toBe("skills");
    expect(yield* dispatchScientOperation("browser.status", Effect.succeed("browser"))).toBe(
      "browser",
    );
  }).pipe(
    Effect.provideService(AgentInvocationContext, {
      ...invocation("projectless", ["preview", "skills:read", "sources:read"]),
      skillScope: { releases: new Map(), skills: [] },
    }),
    Effect.provideService(
      WorkspaceBindingResolver,
      resolver(() =>
        Effect.fail(
          new WorkspaceBindingResolutionError({
            operation: "resolve-thread",
            kind: "project-required",
          }),
        ),
      ),
    ),
  ),
);

it.effect("withholds skill operations when a grant has no authorized release scope", () =>
  Effect.gen(function* () {
    expect(yield* listAvailableScientOperations()).toEqual([]);
    expect(
      (yield* dispatchScientOperation("skills.load", Effect.succeed("never")).pipe(Effect.flip))
        ._tag,
    ).toBe("AgentOperationUnavailable");
  }).pipe(
    Effect.provideService(AgentInvocationContext, invocation("a", ["skills:read"])),
    Effect.provideService(
      WorkspaceBindingResolver,
      resolver(() => Effect.die("Unexpected resolution")),
    ),
  ),
);

it.effect("captures one workspace and refuses to replace it with a newer thread root", () => {
  let resolutions = 0;
  let assertions = 0;
  let changed = false;
  const a = workspace("a");
  const host = resolver(
    () =>
      Effect.sync(() => {
        resolutions++;
        return changed ? workspace("b") : a;
      }),
    (scope) =>
      Effect.gen(function* () {
        assertions++;
        expect(scope.bindingId).toBe(a.binding.bindingId);
        if (changed)
          return yield* new WorkspaceBindingResolutionError({
            operation: "assert-thread-scope",
            kind: "stale-authority",
          });
        return a.binding;
      }),
  );
  return dispatchScientOperation(
    "documents.html.build",
    Effect.gen(function* () {
      const captured = yield* consumeAgentWorkspace();
      expect(captured).toBe(a);
      expect(yield* consumeAgentWorkspace()).toBe(a);
      changed = true;
      const failure = yield* resolveAgentWorkspace().pipe(Effect.flip);
      expect(failure.code).toBe("project-changed");
      expect((yield* AgentInvocationContext).workspace).toBe(a);
    }),
  ).pipe(
    Effect.provideService(AgentInvocationContext, invocation("a", ["documents:build"])),
    Effect.provideService(WorkspaceBindingResolver, host),
    Effect.tap(() => {
      expect(resolutions).toBe(1);
      expect(assertions).toBe(1);
      return Effect.void;
    }),
  );
});

it.effect("keeps concurrent dispatch contexts separate for copied logical projects", () =>
  Effect.forEach(
    Array.from({ length: 40 }, (_, index) => `workspace-${index}`),
    (thread) =>
      dispatchScientOperation(
        "sources.list",
        Effect.gen(function* () {
          yield* Effect.yieldNow;
          const captured = yield* AgentInvocationContext;
          expect(captured.threadId).toBe(thread);
          expect(captured.workspace?.binding.canonicalRoot).toBe(`/fixture/${thread}`);
          expect(captured.workspace?.binding.scientProjectId).toBe("shared-portable-project");
        }),
      ).pipe(Effect.provideService(AgentInvocationContext, invocation(thread, ["sources:read"]))),
    { concurrency: 8 },
  ).pipe(
    Effect.provideService(
      WorkspaceBindingResolver,
      resolver((thread) => Effect.succeed(workspace(thread))),
    ),
  ),
);
