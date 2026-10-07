import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  threadCreated,
  THREAD_ID,
} from "../../../integration/TransferBudgetV2Fixture.integration.ts";
import { ServerConfig } from "../../config.ts";
import { GitManager } from "../../git/GitManager.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as Settings from "../../serverSettings.ts";
import * as StorageCleanup from "../../storageCleanup.ts";
import { presentQueuedRunsAsBusy } from "./QueuedRunWorktreeRetention.ts";
import { TerminalManager } from "../../terminal/Manager.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";

// Real projection and shell reads; only Git and terminals are controlled.
const database = SqlitePersistenceMemory;
const testLayer = Layer.merge(
  database,
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "queued-run-worktree-retention" },
    ProviderAdapterRegistry.makeLayer([]),
    { databaseLayer: database, runEffectWorker: false },
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");

function runCreated(input: {
  readonly ordinal: number;
  readonly status: "failed" | "queued";
  readonly queueHeld?: boolean;
}): OrchestrationV2DomainEvent {
  const at = DateTime.makeUnsafe(`2026-06-01T00:0${input.ordinal}:00Z`);
  const runId = RunId.make(`retention-run-${input.ordinal}`);
  const nodeId = NodeId.make(`retention-node-${input.ordinal}`);
  return {
    id: EventId.make(`retention-run-created-${input.ordinal}`),
    type: "run.created",
    threadId: THREAD_ID,
    runId,
    nodeId,
    driver,
    providerInstanceId,
    occurredAt: at,
    payload: {
      id: runId,
      threadId: THREAD_ID,
      ordinal: input.ordinal,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      providerThreadId: null,
      userMessageId: MessageId.make(`retention-user-${input.ordinal}`),
      rootNodeId: nodeId,
      activeAttemptId: null,
      status: input.status,
      ...(input.queueHeld === undefined ? {} : { queueHeld: input.queueHeld }),
      requestedAt: at,
      startedAt: input.status === "failed" ? at : null,
      completedAt: input.status === "failed" ? at : null,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

const scenarios = {
  // Control: an old, failed, clean worktree is removed under the age rule.
  "a failed run with nothing queued": { runs: [{ ordinal: 1, status: "failed" }], kept: false },
  // A held queue after a failure: the shell reads "failed".
  "a held queue after a failed run": {
    runs: [
      { ordinal: 1, status: "failed" },
      { ordinal: 2, status: "queued", queueHeld: true },
    ],
    kept: true,
  },
  // Only held runs: the shell reads "idle".
  "only held queued runs": {
    runs: [{ ordinal: 1, status: "queued", queueHeld: true }],
    kept: true,
  },
} satisfies Record<
  string,
  { readonly runs: ReadonlyArray<Parameters<typeof runCreated>[0]>; readonly kept: boolean }
>;

describe("storage cleanup keeps worktrees of threads with queued runs", () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    it.effect(`${scenario.kept ? "keeps" : "removes"} the worktree for ${name}`, () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-07-01T00:00:00Z"));
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const worktreePath = path.join(yield* fs.realPath(config.worktreesDir), "feature");
        yield* fs.makeDirectory(worktreePath, { recursive: true });
        yield* fs.writeFileString(path.join(worktreePath, ".git"), "gitdir: /fixture/admin");
        const created = threadCreated(driver);
        yield* sink.commitProjectCommand({
          commandId: CommandId.make("retention-project"),
          projectId: created.payload.projectId!,
          commandType: "project.create",
          acceptedAt: now,
          event: {
            eventId: EventId.make("retention-project-created"),
            aggregateKind: "project",
            aggregateId: created.payload.projectId!,
            occurredAt: DateTime.formatIso(now),
            commandId: CommandId.make("retention-project"),
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId: created.payload.projectId!,
              title: "Retention project",
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
            { ...created, payload: { ...created.payload, branch: "feature", worktreePath } },
            ...scenario.runs.map(runCreated),
          ],
        });
        const swept = yield* Deferred.make<void>();
        const removals: string[] = [];
        const settings = yield* Settings.ServerSettingsService.pipe(
          Effect.provide(
            Settings.layerTest({
              storageCleanup: {
                worktreeAfterDays: 7,
                worktreeOnDelete: false,
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
                    .pipe(Effect.tap(() => Deferred.succeed(swept, undefined))),
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
                resolveCommit: () => Effect.succeed({ commitSha: "a".repeat(40) }),
                execute: () =>
                  Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout: "",
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  }),
                removeWorktree: (input) => {
                  removals.push(input.path);
                  return fs.remove(input.path, { recursive: true }).pipe(Effect.orDie);
                },
              }),
            ),
          ),
        );
        yield* cleanup.start();
        yield* Deferred.await(swept);
        yield* cleanup.drain;
        assert.deepStrictEqual(removals, scenario.kept ? [] : [worktreePath]);
        assert.strictEqual(yield* fs.exists(worktreePath), scenario.kept);
      }).pipe(Effect.provide(testLayer), Effect.scoped),
    );
  }

  it.effect("finds queued runs through the recovery index instead of scanning run history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const queries: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string") queries.push(query);
          };
          return span;
        },
      });
      yield* presentQueuedRunsAsBusy(sql, [{ id: THREAD_ID, status: "failed" }]).pipe(
        Effect.withTracer(tracer),
      );
      assert.lengthOf(queries, 1);
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${queries[0]}`,
      );
      const details = plan.map((row) => row.detail).join("\n");
      assert.match(details, /SEARCH .*orchestration_v2_projection_runs_recovery_idx/);
      assert.notMatch(details, /SCAN/);
    }).pipe(Effect.provide(testLayer)),
  );
});
