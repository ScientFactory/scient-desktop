import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_MODEL,
  ProjectId,
  ProviderInstanceId,
  CommandId,
  ThreadId,
  type Project,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ProviderAdapters from "./orchestration-v2/ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProjectService from "./project/ProjectService.ts";

import * as ServerConfig from "./config.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

it("uses the canonical Codex model for auto-bootstrap", () => {
  assert.deepEqual(ServerRuntimeStartup.getAutoBootstrapThreadModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("starts without scanning or rebuilding projection history", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (label: string) => Ref.update(calls, (current) => [...current, label]);

    const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      importLegacyShells: record("import"),
      recover: record("recover").pipe(Effect.as({ closedRequests: 2 })),
      recoverDelegatedTasks: record("delegated"),
      startEffectWorker: record("worker"),
      autoBootstrap: record("bootstrap").pipe(Effect.as({ projectId: "project-1" })),
    });

    // Delegated recovery reads the runs recovery terminalizes, and settles them
    // before the worker runs restart continuations that would otherwise race it.
    assert.deepEqual(yield* Ref.get(calls), [
      "import",
      "recover",
      "delegated",
      "worker",
      "bootstrap",
    ]);
    assert.deepEqual(result, {
      recovery: { closedRequests: 2 },
      bootstrap: { projectId: "project-1" },
    });
  }),
);

it.effect("interrupts the effect worker when awareness relay startup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerInterrupted = yield* Ref.make(false);
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

      const exit = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.ensuring(Ref.set(workerInterrupted, true))),
        startRelay: Effect.yieldNow.pipe(
          Effect.andThen(Effect.die("awareness relay startup failed")),
        ),
        workerFiberRef,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(yield* Ref.get(workerInterrupted));
      assert.isNull(yield* Ref.get(workerFiberRef));
    }),
  ),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("startup heartbeat records without querying project or thread counts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: string[] = [];

      yield* ServerRuntimeStartup.recordStartupHeartbeat.pipe(
        Effect.provideService(AnalyticsService.AnalyticsService, {
          record: (name) =>
            Effect.sync(() => {
              events.push(name);
            }),
          flush: Effect.void,
          status: Effect.succeed({ available: false, consent: "off" as const }),
          collectionEpoch: Effect.succeed(0),
          setConsent: () => Effect.succeed({ available: false, consent: "off" as const }),
          deleteData: Effect.succeed(false),
        }),
      );
      assert.deepStrictEqual(events, ["server.boot.heartbeat"]);
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

const bootstrapProjectId = ProjectId.make("project-startup-bootstrap");
const bootstrapThreadId = ThreadId.make("thread-startup-bootstrap");
const bootstrapModel = ServerRuntimeStartup.getAutoBootstrapThreadModelSelection();
const bootstrapProject: Project = {
  id: bootstrapProjectId,
  title: "Startup Project",
  workspaceRoot: "/tmp/startup-project",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};
const bootstrapConfigLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.map(ServerConfig.ServerConfig, (config) => ({
    ...config,
    autoBootstrapProjectFromCwd: true,
  })),
).pipe(
  Layer.provide(ServerConfig.layerTest("/tmp/startup-project", { prefix: "startup-bootstrap-" })),
  Layer.provideMerge(NodeServices.layer),
);
const bootstrapThreadsLayer = ThreadManagement.layer.pipe(
  Layer.provide(
    makeOrchestratorV2ReplayLayerWithRegistry(
      { name: "startup-bootstrap" },
      ProviderAdapters.layerFromAdapters([]),
      { runEffectWorker: false },
    ),
  ),
);

const createBootstrapThread = Effect.fn("createBootstrapThread")(function* (
  input: Pick<ThreadLaunch.ThreadLaunchInput, "modelSelection" | "runtimeMode">,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make("startup-bootstrap-thread-create"),
    threadId: bootstrapThreadId,
    projectId: bootstrapProjectId,
    title: "Startup thread",
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "system",
    creationSource: "server",
  });
  return yield* threads.getThreadProjection(bootstrapThreadId);
});

it.effect("resolveAutoBootstrapWelcomeTargets reuses an existing top-level thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* createBootstrapThread({ modelSelection: bootstrapModel, runtimeMode: "full-access" });
      const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProjectService.ProjectService)({
              bootstrap: () => Effect.succeed({ project: bootstrapProject, created: false }),
            }),
            Layer.mock(ThreadLaunch.ThreadLaunchService)({
              launch: () => Effect.die("An existing top-level thread must be reused"),
            }),
          ),
        ),
      );
      assert.deepStrictEqual(targets, {
        bootstrapProjectId,
        bootstrapThreadId,
        bootstrapProjectCreated: false,
        bootstrapThreadCreated: false,
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(bootstrapThreadsLayer, ServerSettings.layerTest()).pipe(
          Layer.provideMerge(bootstrapConfigLayer),
        ),
      ),
    ),
  ),
);

it.effect.each([
  {
    existing: false,
    machineModel: null,
    projectModel: null,
    machineMode: "full-access",
    projectMode: null,
  },
  {
    existing: false,
    machineModel: "claude-sonnet-4-6",
    projectModel: null,
    machineMode: "approval-required",
    projectMode: null,
  },
  {
    existing: true,
    machineModel: "claude-sonnet-4-6",
    projectModel: null,
    machineMode: "auto",
    projectMode: null,
  },
  {
    existing: true,
    machineModel: "claude-sonnet-4-6",
    projectModel: "gpt-5.4",
    machineMode: "full-access",
    projectMode: "auto-accept-edits",
  },
] as const)("auto-bootstrap model and permissions precedence: %j", (options) =>
  Effect.scoped(
    Effect.gen(function* () {
      const machineSelection = options.machineModel
        ? { instanceId: ProviderInstanceId.make("claude-code"), model: options.machineModel }
        : null;
      const projectSelection = options.projectModel
        ? { instanceId: ProviderInstanceId.make("codex"), model: options.projectModel }
        : null;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({
              defaultModelSelection: machineSelection,
              defaultRuntimeMode: options.machineMode,
              projectSettingsOverrides: projectSelection
                ? {
                    [bootstrapProjectId]: {
                      defaultModelSelection: projectSelection,
                      ...(options.projectMode ? { defaultRuntimeMode: options.projectMode } : {}),
                    },
                  }
                : {},
            }),
            Layer.mock(ProjectService.ProjectService)({
              bootstrap: (input) => {
                assert.equal("defaultModelSelection" in input, false);
                return Effect.succeed({ project: bootstrapProject, created: !options.existing });
              },
            }),
            Layer.succeed(ThreadLaunch.ThreadLaunchService, {
              retryPreparation: () =>
                Effect.die("Bootstrap fixture does not retry workspace preparation."),
              launch: (input) =>
                createBootstrapThread(input).pipe(
                  Effect.provideService(ThreadManagement.ThreadManagementService, threads),
                  Effect.orDie,
                  Effect.map((projection) => ({
                    threadId: bootstrapThreadId,
                    projection,
                    resumed: false,
                  })),
                ),
            }),
          ),
        ),
      );
      assert.deepStrictEqual(targets, {
        bootstrapProjectId,
        bootstrapThreadId,
        bootstrapProjectCreated: !options.existing,
        bootstrapThreadCreated: true,
      });
      const projection = yield* threads.getThreadProjection(bootstrapThreadId);
      assert.equal(projection.thread.runtimeMode, options.projectMode ?? options.machineMode);
      assert.deepStrictEqual(
        projection.thread.modelSelection,
        projectSelection ?? machineSelection ?? bootstrapModel,
      );
    }).pipe(Effect.provide(bootstrapThreadsLayer.pipe(Layer.provideMerge(bootstrapConfigLayer)))),
  ),
);

it.effect(
  "resolveAutoBootstrapWelcomeTargets preserves a project created before thread failure",
  () =>
    Effect.scoped(
      ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProjectService.ProjectService)({
              bootstrap: () => Effect.succeed({ project: bootstrapProject, created: true }),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getShellSnapshot: () => Effect.die("thread lookup failed"),
            }),
            Layer.mock(ThreadLaunch.ThreadLaunchService)({
              launch: () => Effect.die("A failed thread lookup must not launch a thread"),
            }),
            ServerSettings.layerTest(),
          ).pipe(Layer.provideMerge(bootstrapConfigLayer)),
        ),
        Effect.tap((targets) =>
          Effect.sync(() => {
            assert.deepStrictEqual(targets, {
              bootstrapProjectId,
              bootstrapProjectCreated: true,
            });
          }),
        ),
      ),
    ),
);

it.effect("resolveAutoBootstrapWelcomeTargets preserves typed UUID generation failures", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const uuidError = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "randomUUIDv4",
      description: "UUID generation unavailable",
    });
    const error = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({
            bootstrap: () => Effect.die("UUID failure must prevent project creation"),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
          Layer.succeed(Crypto.Crypto, { ...crypto, randomUUIDv4: Effect.fail(uuidError) }),
          ServerSettings.layerTest(),
        ).pipe(Layer.provideMerge(bootstrapConfigLayer)),
      ),
      Effect.flip,
    );
    assert.strictEqual(error, uuidError);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("completeAutoBootstrapWelcome settles failures without bootstrap targets", () =>
  Effect.gen(function* () {
    const completion = yield* ServerRuntimeStartup.completeAutoBootstrapWelcome(
      Effect.fail("bootstrap failed"),
    );

    assert.deepStrictEqual(completion, { bootstrapStatus: "complete" });
  }),
);

it.effect("completeAutoBootstrapWelcome settles unexpected defects", () =>
  Effect.gen(function* () {
    const completion = yield* ServerRuntimeStartup.completeAutoBootstrapWelcome(
      Effect.die("bootstrap defect"),
    );

    assert.deepStrictEqual(completion, { bootstrapStatus: "complete" });
  }),
);

it.effect("completeAutoBootstrapWelcome settles an empty bootstrap result", () =>
  Effect.gen(function* () {
    const completion = yield* ServerRuntimeStartup.completeAutoBootstrapWelcome(Effect.succeed({}));

    assert.deepStrictEqual(completion, { bootstrapStatus: "complete" });
  }),
);
