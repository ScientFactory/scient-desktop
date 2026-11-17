import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { WORKTREE_SETUP_HOLD_ERROR } from "../scient/orchestration/WorktreeSetupHoldReport.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:unborn-repo");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const worktreeStrategy = { type: "worktree", baseRef: "main", startFromOrigin: true } as const;

/** A launch stack whose Git calls run against a real repository at `cwd`. */
function makeHarness(
  cwd: string,
  git: GitVcsDriver.GitVcsDriver["Service"],
  overrides: Partial<GitWorkflow.GitWorkflowService["Service"]> = {},
) {
  const run = (args: string[]) => git.execute({ operation: "unborn-repo-test", cwd, args });
  const succeeds = (args: string[]) =>
    run(args).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  const project = {
    id: projectId,
    title: "Empty repository",
    workspaceRoot: cwd,
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: modelSelection,
    defaultThreadEnvMode: null,
    scripts: [],
    pinnedAt: null,
    archivedAt: null,
    createdAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z",
    deletedAt: null,
  } as const;
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const layerServerSettings = ServerSettings.layerTest().pipe(Layer.orDie);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "unborn-repo-launch" },
    layerRegistry,
    { databaseLayer: layerDatabase, layerServerSettings, runEffectWorker: false },
  );
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerCheckpointStore = Layer.mock(CheckpointStore.CheckpointStore)({
    isGitRepository: () => succeeds(["rev-parse", "--is-inside-work-tree"]),
  });
  const layerExternalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    layerCheckpointStore,
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      getByWorkspaceRoot: () => Effect.succeedSome(project),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      repositoryRoot: () => Effect.succeed(cwd),
      hasCommit: ({ refName }) => succeeds(["rev-parse", "--verify", `${refName}^{commit}`]),
      hasRefNamed: () => Effect.succeed(false),
      currentBranch: () =>
        run(["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(
          Effect.map((result) => result.stdout.trim() || null),
          Effect.orElseSucceed(() => null),
        ),
      listLocalBranchNames: () => git.listLocalBranchNames(cwd),
      resolvePrimaryRemoteName: () => git.resolvePrimaryRemoteName(cwd),
      resolveDefaultBranchName: (_cwd, remoteName) => git.resolveDefaultBranchName(cwd, remoteName),
      resolveWorktreeBaseRemote: (input) => git.resolveWorktreeBaseRemote({ ...input, cwd }),
      fetchWorktreeBaseCommit: (input) => git.fetchWorktreeBaseCommit({ ...input, cwd }),
      createWorktree: (input, progress) =>
        git.createWorktree({ ...input, cwd, path: `${cwd}-worktree` }, progress),
      renameBranch: (input) => Effect.succeed({ branch: input.newBranch }),
      removeWorktree: () => Effect.void,
      deleteLocalBranch: () => Effect.void,
      ...overrides,
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: () => Effect.succeed({ status: "no-script" as const }),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle: () => Effect.succeed({ title: "Generated title" }),
      generateBranchName: () => Effect.succeed({ branch: "generated-branch" }),
    }),
    layerServerSettings,
    ProviderRegistryMock.layer(),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
      folderForThread: () => Effect.succeedNone,
    }),
  );
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerExternalServices,
        layerThreadManagement,
        layerReceipts,
        layerOrchestrator,
        IdAllocator.layer,
      ),
    ),
  );
  const layerBase = Layer.mergeAll(
    layerLaunch,
    layerOrchestrator,
    layerThreadManagement,
    layerDatabase,
    layerExternalServices,
  );
  const layerScheduledTasks = ScheduledTasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerBase,
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(SecretRequests.SecretRequests)({}),
        ManagedPolicy.layerTest(),
      ),
    ),
  );
  return Layer.mergeAll(layerBase, layerScheduledTasks);
}

/** Runs `body` against a fresh `git init` with no commit, branch or remote. */
const withEmptyRepository = <A, E, R>(
  body: (repo: {
    readonly cwd: string;
    readonly git: GitVcsDriver.GitVcsDriver["Service"];
    readonly commit: Effect.Effect<void, GitCommandError>;
    readonly run: (args: string[]) => ReturnType<GitVcsDriver.GitVcsDriver["Service"]["execute"]>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "launch-unborn-repo-" });
    const cwd = `${directory}/repo`;
    yield* fs.makeDirectory(cwd);
    const run = (args: string[]) => git.execute({ operation: "unborn-repo-test", cwd, args });
    yield* run(["init", "-b", "main"]);
    yield* run(["config", "user.name", "Test"]);
    yield* run(["config", "user.email", "test@example.test"]);
    const commit = run(["commit", "--allow-empty", "-m", "initial"]).pipe(Effect.asVoid);
    return yield* body({ cwd, git, commit, run });
  }).pipe(
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "launch-unborn-git-" })),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  );

function taskInput(id: string) {
  return {
    id: ScheduledTaskId.make(id),
    title: "Daily CI care",
    prompt: "Check CI.",
    enabled: false,
    schedule: { type: "interval" as const, everyMs: 60_000 },
    projectId,
    threadId: null,
    threadMode: "continue" as const,
    workspaceStrategy: worktreeStrategy,
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
  };
}

/** Settles once preparation releases the run, or fails it. */
const preparationSettled = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.streamStoredEventsFrom({ threadId }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          (stored.commandId?.endsWith(":release") === true ||
            stored.event.payload.status === "failed"),
      ),
      Stream.runHead,
    );
    return yield* threads.getThreadProjection(threadId);
  });

it.effect("saves a worktree task as a root task until the repository has a commit", () =>
  withEmptyRepository(({ cwd, git, commit }) =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const empty = yield* tasks.upsert(taskInput("scheduled-task:unborn-upsert"));
      assert.deepEqual(empty.task.workspaceStrategy, { type: "root" });
      yield* commit;
      const committed = yield* tasks.upsert(taskInput("scheduled-task:committed-upsert"));
      assert.deepEqual(committed.task.workspaceStrategy, worktreeStrategy);
    }).pipe(Effect.provide(makeHarness(cwd, git))),
  ),
);

it.effect("runs a task saved with a worktree in the root of a repository with no commit", () =>
  withEmptyRepository(({ cwd, git }) =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      const { task } = yield* tasks.upsert(taskInput("scheduled-task:unborn-stored"));
      // Tasks saved before this repository was recognized still hold a worktree strategy.
      yield* sql`
        UPDATE scheduled_tasks
        SET workspace_strategy_json = ${JSON.stringify(worktreeStrategy)}
        WHERE task_id = ${task.id}
      `;
      const ran = yield* tasks.runNow({ id: task.id });
      assert.equal(ran.task.lastRunStatus, "succeeded");
      const projection = yield* preparationSettled(ran.threadId!);
      assert.equal(projection.runs[0]?.status, "starting");
      assert.notEqual(projection.runs[0]?.workspacePreparation?.type, "worktree");
      assert.isNull(projection.thread.worktreePath);
      assert.isFalse(projection.turnItems.some((item) => item.type === "error"));
    }).pipe(Effect.provide(makeHarness(cwd, git))),
  ),
);

it.effect("keeps a requested base that resolves when HEAD has no commit", () =>
  withEmptyRepository(({ cwd, git, commit, run }) =>
    Effect.gen(function* () {
      yield* commit;
      yield* run(["tag", "v1"]);
      // An orphan checkout with no branch left: only the tag can start a worktree.
      yield* run(["checkout", "--orphan", "empty"]);
      yield* run(["branch", "-D", "main"]);
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const launched = yield* launches.launch({
        commandId: CommandId.make("command:launch:tag-base"),
        threadId: ThreadId.make("thread:launch:tag-base"),
        projectId,
        title: "From the tag",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "worktree", baseRef: "v1", branch: "feature" },
        initialMessage: {
          messageId: MessageId.make("message:launch:tag-base"),
          text: "Build the feature",
          attachments: [],
        },
        createdBy: "user",
        creationSource: "web",
      });
      const projection = yield* preparationSettled(launched.threadId);
      assert.equal(projection.runs[0]?.status, "starting");
      assert.equal(projection.runs[0]?.workspacePreparation?.type, "worktree");
      assert.equal(projection.thread.worktreePath, `${cwd}-worktree`);
    }).pipe(Effect.provide(makeHarness(cwd, git))),
  ),
);

it.effect.each(["after", "before"] as const)(
  "fails a task run sent %s its thread's worktree setup failed",
  (order) =>
    withEmptyRepository(({ cwd, git, commit }) =>
      Effect.gen(function* () {
        const releaseSetup = yield* Deferred.make<void>();
        if (order === "after") yield* Deferred.succeed(releaseSetup, undefined);
        const harness = makeHarness(cwd, git, {
          createWorktree: (input) =>
            Deferred.await(releaseSetup).pipe(
              Effect.andThen(
                Effect.fail(
                  new GitCommandError({
                    operation: "GitWorkflowService.createWorktree",
                    command: "git worktree add",
                    cwd: input.cwd,
                    detail: "fatal: could not lock config file",
                  }),
                ),
              ),
            ),
        });
        yield* commit;
        yield* Effect.gen(function* () {
          const tasks = yield* ScheduledTasks.ScheduledTaskService;
          const { task } = yield* tasks.upsert(taskInput(`scheduled-task:failed-setup-${order}`));
          const recordedRun = (runCount: number) =>
            tasks.subscribeList().pipe(
              Stream.map(({ tasks: listed }) =>
                listed.find((candidate) => candidate.id === task.id),
              ),
              Stream.filter(
                (current) => current?.runCount === runCount && current.lastRunStatus === "failed",
              ),
              Stream.runHead,
              Effect.map(Option.getOrUndefined),
            );
          const first = yield* tasks.runNow({ id: task.id });
          if (order === "after") {
            assert.equal((yield* preparationSettled(first.threadId!)).runs[0]?.status, "failed");
            yield* recordedRun(1);
          }
          // Each run is told apart by its start time.
          yield* TestClock.adjust("1 minute");

          const held = yield* recordedRun(2).pipe(Effect.forkChild);
          const second = yield* tasks.runNow({ id: task.id });
          assert.equal(second.threadId, first.threadId);
          yield* Deferred.succeed(releaseSetup, undefined);
          assert.equal((yield* Fiber.join(held))?.lastRunError, WORKTREE_SETUP_HOLD_ERROR);
        }).pipe(Effect.provide(harness));
      }),
    ),
);
