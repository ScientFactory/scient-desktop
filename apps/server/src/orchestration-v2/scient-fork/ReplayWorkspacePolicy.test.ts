import { assert, describe, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as RuntimePolicy from "../RuntimePolicy.ts";
import * as ReplayWorkspacePolicy from "./ReplayWorkspacePolicy.testkit.ts";

const projectId = ProjectId.make("project:replay-workspace");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.5",
} satisfies ModelSelection;

const thread = (now: DateTime.Utc, worktreePath: string | null): OrchestrationV2AppThread => {
  const id = ThreadId.make("thread:replay-workspace");
  return {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId,
    title: "Replay workspace",
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "plan",
    branch: null,
    worktreePath,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};

const project = (workspaceRoot: string) => ({
  projectId,
  title: "Project",
  workspaceRoot,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
  deletedAt: null,
});

const replayProfile = ServerConfig.layerTest(process.cwd(), {
  prefix: "replay-workspace-policy-",
}).pipe(Layer.provide(NodeServices.layer));

const resolveWith = (get: ProjectStore.ProjectStoreV2["Service"]["get"], worktree: string | null) =>
  Effect.gen(function* () {
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    const resolved = yield* policy.resolve({
      thread: thread(yield* DateTime.now, worktree),
      modelSelection,
    });
    return { ...resolved, profile: (yield* ServerConfig.ServerConfig).baseDir };
  }).pipe(
    Effect.provide(
      ReplayWorkspacePolicy.layer.pipe(
        Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({ get })),
        Layer.provideMerge(replayProfile),
      ),
    ),
  );

describe("ReplayWorkspacePolicy", () => {
  it.effect("keeps a thread's worktree without reading its project", () =>
    Effect.gen(function* () {
      const policy = yield* resolveWith(() => Effect.die("project read"), "/worktree");
      assert.strictEqual(policy.cwd, "/worktree");
    }),
  );

  it.effect("resolves a local thread to its project root and keeps its modes", () =>
    Effect.gen(function* () {
      const policy = yield* resolveWith(() => Effect.succeedSome(project("/project-root")), null);
      assert.strictEqual(policy.cwd, "/project-root");
      assert.strictEqual(policy.runtimeMode, "approval-required");
      assert.strictEqual(policy.interactionMode, "plan");
    }),
  );

  it.effect("gives a thread without a project the disposable replay profile", () =>
    Effect.gen(function* () {
      const policy = yield* resolveWith(() => Effect.succeedNone, null);
      assert.strictEqual(policy.cwd, policy.profile);
    }),
  );

  it.effect("yields to a scenario's explicit cwd override", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const resolved = yield* policy.resolve({
        thread: thread(yield* DateTime.now, null),
        modelSelection,
      });
      assert.strictEqual(resolved.cwd, "/override");
    }).pipe(
      Effect.provide(
        RuntimePolicy.layerWithOverride({ cwd: "/override" }).pipe(
          Layer.provide(ReplayWorkspacePolicy.layer),
          Layer.provide(
            Layer.mock(ProjectStore.ProjectStoreV2)({
              get: () => Effect.succeedSome(project("/project-root")),
            }),
          ),
          Layer.provideMerge(replayProfile),
        ),
      ),
    ),
  );

  it.effect("reports a project store failure as a policy resolution error", () =>
    Effect.gen(function* () {
      const error = yield* resolveWith(
        () => Effect.fail(new ProjectStore.ProjectStoreV2Error({ operation: "get", cause: "x" })),
        null,
      ).pipe(Effect.flip);
      assert.instanceOf(error, RuntimePolicy.RuntimePolicyResolveError);
      assert.strictEqual(error.projectId, projectId);
    }),
  );
});
