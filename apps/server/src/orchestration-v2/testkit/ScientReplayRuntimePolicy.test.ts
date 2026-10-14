import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ServerConfig } from "../../config.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as RuntimePolicy from "../RuntimePolicy.ts";
import { makeReplayServerConfig } from "./ProviderReplayHarness.ts";
import * as ReplayPolicy from "./ScientReplayRuntimePolicy.testkit.ts";

const projectId = ProjectId.make("project:replay-workspace");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" } satisfies ModelSelection;
const now = DateTime.makeUnsafe("2026-10-14T00:00:00.000Z");
const threadId = ThreadId.make("thread:replay-workspace");
const thread = {
  id: threadId,
  projectId,
  title: "Replay workspace",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: instanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
} satisfies OrchestrationV2AppThread;

const project = {
  projectId,
  title: "Replay",
  workspaceRoot: "/fixture/project",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  deletedAt: null,
} satisfies ProjectStore.ProjectRow;

const resolve = (
  worktreePath: string | null,
  row: Option.Option<ProjectStore.ProjectRow>,
  override?: RuntimePolicy.RuntimePolicyV2Override,
) =>
  Effect.gen(function* () {
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    return yield* policy.resolve({ thread: { ...thread, worktreePath }, modelSelection });
  }).pipe(
    Effect.provide(
      (override === undefined
        ? ReplayPolicy.layer
        : RuntimePolicy.layerWithOverride(override).pipe(Layer.provide(ReplayPolicy.layer))
      ).pipe(
        Layer.provide(
          Layer.merge(
            Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(row) }),
            ServerConfig.layerTest("/fixture/fallback", { prefix: "replay-policy-" }),
          ),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );

it.effect("uses the owning fixture project for local-checkout threads", () =>
  Effect.gen(function* () {
    const policy = yield* resolve(null, Option.some(project));
    assert.equal(policy.cwd, project.workspaceRoot);
    assert.equal(policy.runtimeMode, thread.runtimeMode);
    assert.equal(policy.interactionMode, thread.interactionMode);
  }),
);

it.effect("prefers a thread worktree", () =>
  Effect.gen(function* () {
    assert.equal(
      (yield* resolve("/fixture/worktree", Option.some(project))).cwd,
      "/fixture/worktree",
    );
  }),
);

it.effect("preserves explicit replay policy overrides", () =>
  Effect.gen(function* () {
    const policy = yield* resolve(null, Option.some(project), {
      cwd: "/fixture/override",
      reasoningEffort: "high",
    });
    assert.equal(policy.cwd, "/fixture/override");
    assert.equal(policy.reasoningEffort, "high");
  }),
);

it.effect("uses the fixture config cwd when a scenario has no stored project", () =>
  Effect.gen(function* () {
    assert.equal((yield* resolve(null, Option.none())).cwd, "/fixture/fallback");
  }),
);

it.effect("replay profiles use their disposable directory rather than process cwd", () =>
  Effect.gen(function* () {
    const config = yield* Effect.acquireRelease(
      makeReplayServerConfig("isolated-policy"),
      (config) =>
        FileSystem.FileSystem.use((fs) =>
          fs.remove(config.baseDir, { recursive: true }).pipe(Effect.orDie),
        ),
    );
    assert.equal(config.cwd, config.baseDir);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
