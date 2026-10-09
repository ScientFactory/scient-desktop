import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, EventId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import { threadCreated, THREAD_ID } from "../integration/TransferBudgetV2Fixture.integration.ts";
import { ServerConfig } from "./config.ts";
import { layerMemory as SqlitePersistenceMemory } from "./persistence/Sqlite.ts";
import { GitManager } from "./git/GitManager.ts";
import * as EffectOutbox from "./orchestration-v2/EffectOutbox.ts";
import * as EventSink from "./orchestration-v2/EventSink.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./orchestration-v2/ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Settings from "./serverSettings.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import { TerminalManager } from "./terminal/Manager.ts";
import { GitVcsDriver } from "./vcs/GitVcsDriver.ts";

// Real projection, event receipts and outbox; only filesystem-external Git and
// terminal operations are controlled. The worker stays stopped so completion
// can be observed at the same durable seam used by the live worker.
const database = SqlitePersistenceMemory;
const testLayer = Layer.merge(
  database,
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "storage-cleanup-lifecycle" },
    ProviderAdapterRegistry.layerFromAdapters([]),
    { layerDatabase: database, runEffectWorker: false },
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

describe("V2 deleted-worktree cleanup lifecycle", () => {
  it.effect.each(
    (["none", "cancelled", "dirty", "ignored", "shared", "head-moved"] as const).map(
      (protection) => ({
        caseTitle: `rereads durable completion and respects ${protection} protection`,
        protection,
      }),
    ),
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
            payload: { ...created.payload, branch: "feature", worktreePath },
          },
        ],
      });
      if (protection === "shared") {
        const survivor = ThreadId.make("surviving-worktree-owner");
        yield* sink.write({
          events: [
            {
              ...created,
              id: EventId.make("survivor-created"),
              threadId: survivor,
              payload: {
                ...created.payload,
                id: survivor,
                branch: "feature",
                worktreePath,
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: survivor,
                },
              },
            },
          ],
        });
      }
      const deletionId = CommandId.make("cleanup-delete");
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: deletionId,
        threadId: THREAD_ID,
      });
      const effects = yield* outbox.listByCommandId(deletionId);
      assert.isAbove(effects.length, 0);
      assert.isTrue(effects.every((row) => row.status === "pending"));
      const initialRead = yield* Deferred.make<void>();
      const completionRead = yield* Deferred.make<void>();
      let completed = false;
      let headReads = 0;
      const removals: string[] = [];
      const settings = yield* Settings.ServerSettingsService.pipe(
        Effect.provide(
          Settings.layerTest({
            storageCleanup: {
              worktreeAfterDays: null,
              worktreeOnDelete: true,
              worktreeOnMerge: false,
              worktreeUnchanged: false,
              browserArtifactsAfterDays: null,
              logsAfterDays: null,
            },
          }),
        ),
      );
      const cleanup = yield* StorageCleanup.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Settings.ServerSettingsService, settings),
            Layer.succeed(ProjectionStore.ProjectionStoreV2, {
              ...projections,
              getShellSnapshot: (options) =>
                projections
                  .getShellSnapshot(options)
                  .pipe(
                    Effect.tap(() =>
                      Deferred.succeed(completed ? completionRead : initialRead, undefined),
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
                  hasWorkingTreeChanges: protection === "dirty",
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: false,
                  aheadCount: 0,
                  behindCount: 0,
                  aheadOfDefaultCount: 0,
                }),
              resolveCommit: () =>
                Effect.sync(() => ({
                  commitSha: (protection === "head-moved" && ++headReads % 2 === 0
                    ? "b"
                    : "a"
                  ).repeat(40),
                })),
              execute: () =>
                Effect.succeed({
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout: protection === "ignored" ? ".env\0" : "",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }),
              removeWorktree: (input) => {
                assert.strictEqual(input.force, false);
                removals.push(input.path);
                return fs.remove(input.path, { recursive: true }).pipe(Effect.orDie);
              },
            }),
          ),
        ),
      );
      yield* cleanup.start();
      yield* Deferred.await(initialRead);
      yield* cleanup.drain;
      assert.isTrue(yield* fs.exists(worktreePath));
      assert.deepStrictEqual(removals, []);
      completed = true;
      if (protection === "cancelled") {
        const cancelled = yield* outbox.cancelUnsettled({
          threadId: THREAD_ID,
          effectTypes: effects.map((row) => row.request.type),
          reason: "explicit cancellation",
        });
        yield* outbox.signalCancellations(cancelled);
        assert.isTrue(
          (yield* outbox.listByCommandId(deletionId)).every((row) => row.status === "cancelled"),
        );
      } else
        for (const row of effects) {
          const claimed = yield* outbox.claimNext({
            workerId: "cleanup-test",
            leaseDurationMs: 60_000,
          });
          assert.isTrue(Option.isSome(claimed));
          if (Option.isNone(claimed)) return;
          assert.isTrue(
            yield* outbox.succeed({ effectId: claimed.value.id, workerId: "cleanup-test" }),
          );
          assert.strictEqual(Option.getOrNull(yield* outbox.get(row.id))?.status, "succeeded");
        }
      yield* Deferred.await(completionRead);
      yield* cleanup.drain;
      assert.deepStrictEqual(
        removals,
        protection === "none" || protection === "cancelled" ? [worktreePath] : [],
      );
      assert.strictEqual(
        yield* fs.exists(worktreePath),
        protection !== "none" && protection !== "cancelled",
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
