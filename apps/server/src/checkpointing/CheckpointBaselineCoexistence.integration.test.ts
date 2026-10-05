import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as Checkpoints from "../orchestration-v2/CheckpointService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { CheckpointRefUnavailableError } from "./Errors.ts";

// Retained historical metadata is the fixture; native completion is exercised
// separately by the unchanged ordinary A/B/A worker/capture integration.
it.live.each(["historical", "workspace-bound"] as const)(
  "queries an implicit legacy baseline beside later ready metadata through SQL and Git: %s",
  (laterKind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `cbc01-${laterKind}`;
        const cwd = yield* checkpointWorkspace(name);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* Effect.acquireRelease(makeReplayServerConfig(name), (config) =>
          fs.remove(path.dirname(config.stateDir), { recursive: true }).pipe(Effect.orDie),
        );
        const databaseLayer = makeSqlitePersistenceLive(
          path.join(config.stateDir, "cbc.sqlite"),
        ).pipe(Layer.provide(NodeServices.layer));
        const stores = Layer.mergeAll(ProjectionStore.layer, EventStore.layer).pipe(
          Layer.provideMerge(databaseLayer),
        );
        const checkpointStoreLayer = CheckpointStore.layer.pipe(
          Layer.provide(
            VcsDriverRegistry.layer.pipe(
              Layer.provide(Layer.mergeAll(VcsProcess.layer, Layer.succeed(ServerConfig, config))),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        const services = Layer.mergeAll(
          EventSink.layer.pipe(Layer.provideMerge(stores)),
          ProjectionMaintenance.layer.pipe(Layer.provideMerge(stores)),
          Checkpoints.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(checkpointStoreLayer, IdAllocator.layer)),
          ),
        );
        const threadId = ThreadId.make(`thread:${name}`);
        const runId1 = RunId.make(`run:${name}:1`);
        const runId2 = RunId.make(`run:${name}:2`);
        const nodeId1 = NodeId.make(`node:${name}:1`);
        const nodeId2 = NodeId.make(`node:${name}:2`);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const git = (args: ReadonlyArray<string>) =>
          spawner.string(ChildProcess.make("git", args, { cwd }));
        const snapshot = Effect.gen(function* () {
          return {
            refs: yield* git(["for-each-ref"]),
            objects: yield* git(["count-objects", "-v"]),
            index: Array.from(yield* fs.readFile(`${cwd}/.git/index`)),
            beforeOne: yield* fs.readFileString(`${cwd}/before-one.txt`),
            afterTwo: yield* fs.readFileString(`${cwd}/after-two.txt`),
          };
        });
        const expected = yield* Effect.scoped(
          Effect.gen(function* () {
            const checkpoints = yield* Checkpoints.CheckpointServiceV2;
            const sink = yield* EventSink.EventSinkV2;
            const projections = yield* ProjectionStore.ProjectionStoreV2;
            const store = yield* CheckpointStore.CheckpointStore;
            const now = yield* DateTime.now;
            const instanceId = ProviderInstanceId.make("cbc-fixture");
            const modelSelection = { instanceId, model: "fixture" };
            const modernScope = yield* checkpoints.prepareRootRunScope({
              threadId,
              runId: runId2,
              rootNodeId: nodeId2,
              providerThreadId: ProviderThreadId.make(`native:${name}`),
              cwd,
              createdAt: now,
            });
            const legacyScope = {
              ...modernScope,
              id: CheckpointScopeId.make(`scope:${name}:legacy-first`),
              runId: runId1,
              nodeId: nodeId1,
              providerThreadId: null,
            };
            const laterScope =
              laterKind === "workspace-bound"
                ? modernScope
                : { ...modernScope, id: CheckpointScopeId.make(`scope:${name}:legacy-later`) };
            const legacyRef = Checkpoints.checkpointRefForScopeOrdinal({
              scopeId: legacyScope.id,
              ordinalWithinScope: 0,
            });
            yield* checkpoints.captureBaseline({ scope: legacyScope, ordinalWithinScope: 0 });
            assert.isTrue(yield* store.hasCheckpointRef({ cwd, checkpointRef: legacyRef }));
            yield* fs.writeFileString(`${cwd}/before-one.txt`, "Before ordinal one\n");
            yield* checkpoints.captureBaseline({ scope: laterScope, ordinalWithinScope: 1 });
            const laterBaseline = yield* checkpoints.materializeBaselineCheckpoint({
              scope: laterScope,
              ordinalWithinScope: 1,
            });
            assert.equal(laterBaseline.status, "ready");
            yield* fs.writeFileString(`${cwd}/after-two.txt`, "Endpoint two\n");
            const endpoint = yield* checkpoints.capture({
              scope: laterScope,
              runId: runId2,
              nodeId: nodeId2,
              ordinalWithinScope: 2,
              appRunOrdinal: 2,
              capturedAt: now,
            });
            assert.equal(endpoint.status, "ready");
            const narrowed = yield* store.diffCheckpoints({
              cwd,
              fromCheckpointRef: laterBaseline.ref,
              toCheckpointRef: endpoint.ref,
              fallbackFromToHead: false,
              ignoreWhitespace: false,
            });
            assert.notInclude(narrowed, "before-one.txt");
            assert.include(narrowed, "+Endpoint two");
            const thread: OrchestrationV2AppThread = {
              id: threadId,
              projectId: ProjectId.make(`project:${name}`),
              title: name,
              providerInstanceId: instanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdBy: "user",
              creationSource: "web",
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              deletedAt: null,
              settledAt: null,
              settledOverride: null,
              lastVisitedAt: null,
            };
            const run = (id: RunId, ordinal: number, rootNodeId: NodeId): OrchestrationV2Run => ({
              id,
              threadId,
              ordinal,
              providerInstanceId: instanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make(`message:${id}`),
              rootNodeId,
              activeAttemptId: null,
              status: "completed",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: ordinal === 2 ? endpoint.id : null,
              contextHandoffId: null,
            });
            // Deliberately retain the historical first root without a baseline row.
            // Do not manufacture its metadata or rewrite its scope to the new namespace.
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`${name}:thread`),
                  type: "thread.created",
                  threadId,
                  occurredAt: now,
                  payload: thread,
                },
                {
                  id: EventId.make(`${name}:run1`),
                  type: "run.created",
                  threadId,
                  occurredAt: now,
                  payload: run(runId1, 1, nodeId1),
                },
                {
                  id: EventId.make(`${name}:run2`),
                  type: "run.created",
                  threadId,
                  occurredAt: now,
                  payload: run(runId2, 2, nodeId2),
                },
                {
                  id: EventId.make(`${name}:old-scope`),
                  type: "checkpoint-scope.created",
                  threadId,
                  occurredAt: now,
                  payload: legacyScope,
                },
                {
                  id: EventId.make(`${name}:later-scope`),
                  type: "checkpoint-scope.created",
                  threadId,
                  occurredAt: now,
                  payload: laterScope,
                },
                {
                  id: EventId.make(`${name}:later-baseline`),
                  type: "checkpoint.captured",
                  threadId,
                  occurredAt: now,
                  payload: laterBaseline,
                },
                {
                  id: EventId.make(`${name}:endpoint`),
                  type: "checkpoint.captured",
                  threadId,
                  runId: runId2,
                  occurredAt: now,
                  payload: endpoint,
                },
              ],
            });
            const context = yield* projections.getCheckpointContext(threadId);
            assert.lengthOf(
              context.checkpoints.filter((row) => row.scopeId === legacyScope.id),
              0,
            );
            assert.deepEqual(
              context.checkpoints.find((row) => row.ref === laterBaseline.ref),
              {
                scopeId: laterScope.id,
                runId: null,
                appRunOrdinal: null,
                ordinalWithinScope: 1,
                status: "ready",
                ref: laterBaseline.ref,
              },
            );
            yield* fs.writeFileString(
              `${cwd}/before-one.txt`,
              "Uncaptured first-file distraction\n",
            );
            yield* fs.writeFileString(`${cwd}/after-two.txt`, "Uncaptured endpoint distraction\n");
            return {
              legacyRef,
              legacyScopeId: legacyScope.id,
              endpointRef: endpoint.ref,
              context,
              originalOid: (yield* git(["rev-parse", legacyRef])).trim(),
            };
          }).pipe(Effect.provide(services)),
        );

        const verify = Effect.fnUntraced(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const store = yield* CheckpointStore.CheckpointStore;
          const before = yield* snapshot;
          assert.deepEqual(yield* projections.getCheckpointContext(threadId), expected.context);
          for (const reversed of [false, true]) {
            const calls: Array<CheckpointStore.DiffCheckpointsInput> = [];
            const query = yield* CheckpointDiffQuery.make.pipe(
              Effect.provide(
                Layer.mergeAll(
                  Layer.mock(ThreadManagement.ThreadManagementService)({
                    getCheckpointContext: () =>
                      projections.getCheckpointContext(threadId).pipe(
                        Effect.map((context) => ({
                          ...context,
                          checkpointScopes: reversed
                            ? context.checkpointScopes.toReversed()
                            : context.checkpointScopes,
                        })),
                        Effect.mapError(
                          (cause) => new OrchestratorProjectionError({ threadId, cause }),
                        ),
                      ),
                  }),
                  Layer.succeed(CheckpointStore.CheckpointStore, {
                    ...store,
                    diffCheckpoints: (input) => {
                      calls.push(input);
                      assert.deepEqual(input, {
                        cwd,
                        fromCheckpointRef: expected.legacyRef,
                        toCheckpointRef: expected.endpointRef,
                        fallbackFromToHead: false,
                        ignoreWhitespace: false,
                      });
                      return store.diffCheckpoints(input);
                    },
                  }),
                ),
              ),
            );
            const full = yield* query.getFullThreadDiff({
              threadId,
              toTurnCount: 2,
              ignoreWhitespace: false,
            });
            assert.include(full.diff, "diff --git a/before-one.txt b/before-one.txt");
            assert.include(full.diff, "+Before ordinal one");
            assert.include(full.diff, "+Endpoint two");
            assert.notInclude(full.diff, "Uncaptured");
            assert.lengthOf(calls, 1);
            yield* git(["update-ref", "-d", expected.legacyRef]);
            const unavailable = yield* query
              .getFullThreadDiff({ threadId, toTurnCount: 2, ignoreWhitespace: false })
              .pipe(Effect.flip);
            assert.instanceOf(unavailable, CheckpointRefUnavailableError);
            assert.equal(unavailable.checkpoint, "from");
            assert.equal(unavailable.turnCount, 0);
            assert.lengthOf(calls, 1);
            yield* git(["update-ref", expected.legacyRef, expected.originalOid]);
          }
          assert.deepEqual(yield* snapshot, before);
        });
        // Reopen the actual database, query the stored historical layout, then
        // rebuild it from the original events without filling the missing old row.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* verify();
            assert.isTrue(
              (yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild).valid,
            );
            yield* verify();
            const projections = yield* ProjectionStore.ProjectionStoreV2;
            assert.lengthOf(
              (yield* projections.getCheckpointContext(threadId)).checkpoints.filter(
                (row) => row.scopeId === expected.legacyScopeId,
              ),
              0,
            );
          }).pipe(Effect.provide(services)),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
