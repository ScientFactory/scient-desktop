import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, EventId, ProviderDriverKind, type ServerSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { threadCreated, THREAD_ID } from "../../integration/TransferBudgetV2Fixture.integration.ts";
import { ServerConfig } from "../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { GitManager } from "../git/GitManager.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import * as Settings from "../serverSettings.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";

import {
  ComputeProjectId,
  ComputeSessionId,
  ComputeLanguageId,
  ComputeTransportKind,
  createSimulatedComputeTransport,
  type ComputeLanguageAdapter,
  type ComputeRuntimeProfile,
} from "@scientfactory/compute";
import * as Fiber from "effect/Fiber";
import * as Context from "effect/Context";
import {
  ComputeSessionService,
  layerWithRuntimeBindings,
} from "../scient/compute/ComputeSessionService.ts";
import * as LocalComputeStore from "../scient/compute/LocalComputeStore.ts";

const PYTHON = ComputeLanguageId.make("python");
const TRANSPORT = ComputeTransportKind.make("jupyter-bridge");
const profile: ComputeRuntimeProfile = {
  languageId: PYTHON,
  source: "path",
  executable: "/usr/bin/python3",
  languageVersion: "3.12.0",
  architecture: "arm64",
  displayName: "Controlled Python",
};
const adapter: ComputeLanguageAdapter = {
  languageId: PYTHON,
  transportKind: TRANSPORT,
  discover: () => Effect.succeed([profile]),
  verify: (request) =>
    Effect.succeed({
      profile: request.profile,
      readiness: "ready",
      missingRequirements: [],
      message: null,
      packages: [],
    }),
  prepareLaunch: (request) =>
    Effect.succeed({
      executable: request.profile.executable,
      args: [],
      cwd: request.cwd,
      environment: request.environment,
    }),
  normalizeDiagnostic: () => [],
  fingerprintEnvironment: () =>
    Effect.succeed({ hash: "sha256:cleanup-fixture", contributors: [] }),
};
const makeComputeLayer = (
  entered: ReadonlyArray<Deferred.Deferred<void>>,
  finish: ReadonlyArray<Deferred.Deferred<void>>,
  closed: string[],
) => {
  const simulated = createSimulatedComputeTransport({
    runtime: {
      languageId: PYTHON,
      transportKind: TRANSPORT,
      protocolVersion: 1,
      languageVersion: "3.12.0",
      platform: "darwin-arm64",
      transportProcessId: 4242,
      runtimeProcessId: 4243,
    },
    capabilities: ["execute", "interrupt", "restart", "shutdown", "variables"],
    resolveExecution: () => ({ _tag: "completes", outputs: [], outcome: "succeeded" }),
  });
  return layerWithRuntimeBindings(
    Effect.succeed([
      {
        adapter,
        transport: {
          open: (request) =>
            Effect.gen(function* () {
              const index = Number(request.sessionId.split("-").at(-1));
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closed.push(request.sessionId);
                }),
              );
              const channel = yield* simulated.open(request);
              return {
                ...channel,
                shutdown: (input) =>
                  Deferred.succeed(entered[index]!, undefined).pipe(
                    Effect.andThen(Deferred.await(finish[index]!)),
                    Effect.andThen(channel.shutdown(input)),
                  ),
              };
            }),
        },
      },
    ]),
  );
};

// Real SQLite, cleanup subscriptions, Compute sessions and physical scope release.
// Runtime protocol, Git worktree deletion and terminal state use controlled seams;
// the Git seam removes the actual disposable directory. No Python CLI is launched.
const database = SqlitePersistenceMemory;
const testLayer = Layer.merge(
  database,
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "storage-cleanup-lifecycle" },
    ProviderAdapterRegistry.layerFromAdapters([]),
    { databaseLayer: database, runEffectWorker: false },
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

describe("V2 Compute worktree cleanup lifecycle", () => {
  it.live.each(
    (["compute", "compute-nested", "deleted-compute"] as const).map((protection) => ({
      caseTitle: `retains ${protection} worktrees until all three physical runtime owners release`,
      protection,
    })),
  )("$caseTitle", ({ protection }) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sink = yield* EventSink.EventSinkV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const now = yield* DateTime.now;
      const worktreePath = path.join(yield* fs.realPath(config.worktreesDir), "feature");
      yield* fs.makeDirectory(worktreePath, { recursive: true });
      yield* fs.writeFileString(path.join(worktreePath, ".git"), "gitdir: /fixture/admin");
      const created = threadCreated(ProviderDriverKind.make("codex"));
      yield* sink.commitProjectCommand({
        commandId: CommandId.make("cleanup-project"),
        projectId: created.payload.projectId!,
        commandType: "project.create",
        acceptedAt: now,
        event: {
          eventId: EventId.make("cleanup-project-created"),
          aggregateKind: "project",
          aggregateId: created.payload.projectId!,
          occurredAt: DateTime.formatIso(now),
          commandId: CommandId.make("cleanup-project"),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId: created.payload.projectId!,
            title: "Cleanup project",
            workspaceRoot: config.baseDir,
            defaultModelSelection: null,
            scripts: [],
            createdAt: DateTime.formatIso(now),
            updatedAt: DateTime.formatIso(now),
          },
        },
      });
      yield* sink.write({
        events: [
          {
            ...created,
            payload: {
              ...created.payload,
              createdAt: DateTime.subtract(now, { days: 2 }),
              updatedAt: DateTime.subtract(now, { days: 2 }),
              branch: "feature",
              worktreePath,
            },
          },
        ],
      });
      const computeProject = ComputeProjectId.make("cleanup-compute");
      const shutdownEntered = yield* Effect.forEach([0, 1, 2], () => Deferred.make<void>());
      const shutdownFinish = yield* Effect.forEach([0, 1, 2], () => Deferred.make<void>());
      const closed: string[] = [];
      const runtimeLayer = makeComputeLayer(shutdownEntered, shutdownFinish, closed).pipe(
        Layer.provideMerge(LocalComputeStore.layer),
        Layer.provide(Layer.succeed(ServerConfig, config)),
        Layer.provide(NodeServices.layer),
      );
      const compute = Context.get(yield* Layer.build(runtimeLayer), ComputeSessionService);
      yield* Effect.addFinalizer(() =>
        Effect.forEach(shutdownFinish, (finish) => Deferred.succeed(finish, undefined), {
          discard: true,
        }),
      );
      const sessions = yield* Effect.forEach([0, 1, 2], (index) =>
        Effect.gen(function* () {
          const root =
            protection === "compute-nested"
              ? path.join(worktreePath, `nested-${index}`)
              : worktreePath;
          yield* fs.makeDirectory(root, { recursive: true });
          return yield* compute.startSession({
            projectId: computeProject,
            sessionId: ComputeSessionId.make(`owner-${index}`),
            languageId: PYTHON,
            label: `Owner ${index}`,
            workingDirectory: root,
            configuredExecutable: null,
          });
        }),
      );
      const deletionId = CommandId.make("cleanup-delete");
      const deleted = protection === "deleted-compute";
      if (deleted)
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: deletionId,
          threadId: THREAD_ID,
        });
      const effects = yield* outbox.listByCommandId(deletionId);
      assert.equal(effects.length > 0, deleted);
      assert.isTrue(effects.every((row) => row.status === "pending"));
      const initialRead = yield* Deferred.make<void>();
      let sweepRead = yield* Deferred.make<void>();
      let completed = false;

      const removals: string[] = [];
      const moves: string[][] = [];
      const settings = yield* Settings.ServerSettingsService.pipe(
        Effect.provide(
          Settings.layerTest({
            storageCleanup: {
              worktreeAfterDays: 1,
              worktreeOnDelete: true,
              worktreeOnMerge: false,
              worktreeUnchanged: false,
              browserArtifactsAfterDays: null,
              logsAfterDays: null,
            },
          }),
        ),
      );
      const changes = yield* PubSub.unbounded<ServerSettings>();
      const cleanupLayer = StorageCleanup.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Settings.ServerSettingsService, {
              ...settings,
              subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
            }),
            Layer.succeed(ProjectionStore.ProjectionStoreV2, {
              ...projections,
              getShellSnapshot: (options) =>
                projections
                  .getShellSnapshot(options)
                  .pipe(
                    Effect.tap(() =>
                      Deferred.succeed(completed ? sweepRead : initialRead, undefined),
                    ),
                  ),
            }),
            Layer.mock(GitManager)({ invalidateStatus: () => Effect.void }),
            Layer.mock(TerminalManager)({
              subscribeMetadata: (listener) =>
                listener({ type: "snapshot", terminals: [] }).pipe(Effect.as(() => {})),
            }),
            Layer.mock(GitVcsDriver)({
              statusDetailsLocal: () =>
                Effect.succeed({
                  isRepo: true,
                  hasOriginRemote: false,
                  isDefaultBranch: false,
                  branch: "feature",
                  upstreamRef: null,
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: false,
                  aheadCount: 0,
                  behindCount: 0,
                  aheadOfDefaultCount: 0,
                }),
              resolveCommit: () =>
                Effect.sync(() => ({
                  commitSha: "a".repeat(40),
                })),
              execute: (input) =>
                Effect.gen(function* () {
                  if (input.operation === "StorageCleanup.cleanupGit") {
                    const args = [...input.args];
                    assert.isFalse(args.includes("--force"));
                    if (args[1] === "move") {
                      assert.equal(args[0], "worktree");
                      assert.lengthOf(args, 4);
                      const source = args[2]!;
                      const destination = args[3]!;
                      assert.isFalse(yield* fs.exists(destination).pipe(Effect.orDie));
                      assert.isTrue(yield* fs.exists(path.join(source, ".git")).pipe(Effect.orDie));
                      yield* fs.rename(source, destination).pipe(Effect.orDie);
                      moves.push(args);
                    } else {
                      const isolatedPath = moves[0]![3]!;
                      assert.deepEqual(args, [
                        "-c",
                        "status.showUntrackedFiles=all",
                        "worktree",
                        "remove",
                        isolatedPath,
                      ]);
                      assert.isFalse(yield* fs.exists(worktreePath).pipe(Effect.orDie));
                      assert.isTrue(
                        yield* fs.exists(path.join(isolatedPath, ".git")).pipe(Effect.orDie),
                      );
                      removals.push(isolatedPath);
                      yield* fs.remove(isolatedPath, { recursive: true }).pipe(Effect.orDie);
                    }
                  }
                  return {
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout: "",
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  };
                }),
            }),
          ),
        ),
      );
      const cleanup = Context.get(yield* Layer.build(cleanupLayer), StorageCleanup.StorageCleanup);
      let sweepOrdinal = 0;
      const sweep = Effect.fnUntraced(function* () {
        sweepRead = yield* Deferred.make<void>();
        const current = yield* settings.getSettings;
        const updated = yield* settings.updateSettings({
          storageCleanup: { ...current.storageCleanup, logsAfterDays: ++sweepOrdinal },
        });
        yield* PubSub.publish(changes, updated);
        yield* Deferred.await(sweepRead);
        yield* cleanup.drain;
      });
      yield* Deferred.await(initialRead);
      yield* cleanup.drain;
      assert.isTrue(yield* fs.exists(worktreePath));
      assert.deepStrictEqual(removals, []);
      assert.deepStrictEqual(moves, []);
      completed = true;
      for (let claimedCount = 0; claimedCount < effects.length; claimedCount += 1) {
        const claimed = yield* outbox.claimNext({
          workerId: "cleanup-test",
          leaseDurationMs: 60_000,
        });
        assert.isTrue(Option.isSome(claimed));
        if (Option.isNone(claimed)) return;
        assert.isTrue(
          yield* outbox.succeed({ effectId: claimed.value.id, workerId: "cleanup-test" }),
        );
        assert.strictEqual(
          Option.getOrNull(yield* outbox.get(claimed.value.id))?.status,
          "succeeded",
        );
      }
      // A runtime's logical stop is insufficient: park the real channel shutdown
      // and keep the reservation until its physical scope finalizer runs.
      for (const [index, session] of sessions.entries()) {
        const stopping = yield* compute
          .stopSession({
            projectId: computeProject,
            sessionId: session.sessionId,
            expectedGeneration: session.generation,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(shutdownEntered[index]!);
        yield* sweep();
        assert.isTrue(yield* fs.exists(worktreePath));
        assert.deepEqual(removals, []);
        assert.deepEqual(moves, []);
        assert.lengthOf(closed, index);
        yield* Deferred.succeed(shutdownFinish[index]!, undefined);
        yield* Fiber.join(stopping);
        assert.lengthOf(closed, index + 1);
        yield* sweep();
        assert.equal(yield* fs.exists(worktreePath), index < 2);
        if (index < 2) {
          assert.deepEqual(moves, []);
          assert.deepEqual(removals, []);
        } else {
          assert.lengthOf(moves, 1);
          const isolatedPath = moves[0]![3]!;
          assert.deepEqual(moves, [["worktree", "move", worktreePath, isolatedPath]]);
          assert.equal(path.dirname(path.dirname(isolatedPath)), path.dirname(worktreePath));
          assert.match(path.basename(path.dirname(isolatedPath)), /^\.scient-cleanup-/);
          assert.equal(path.basename(isolatedPath), "checkout");
          assert.deepEqual(removals, [isolatedPath]);
          assert.isFalse(yield* fs.exists(isolatedPath));
          assert.isFalse(yield* fs.exists(path.dirname(isolatedPath)));
        }
      }
    }).pipe(Effect.provide(testLayer), Effect.scoped, Effect.timeout("30 seconds")),
  );
});
