import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type VcsCreateWorktreeInput,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ScientForkReactorLive } from "./ScientForkReactor.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ScientForkReactor } from "../Services/ScientForkReactor.ts";

const PROJECT_ID = ProjectId.make("project-fork-1");
const ORIGIN = ThreadId.make("origin-thread-fork");
const NEW = ThreadId.make("new-thread-fork");
const WORKSPACE_ROOT = "/tmp/scient-fork-workspace";
const ORIGIN_WORKTREE = "/tmp/scient-fork-origin-worktree";
const NEW_WORKTREE_FIXTURE = "/tmp/scient-fork-new-worktree";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const FORK_AT_TURN = 1;

interface LineageRow {
  readonly thread_id: string;
  readonly forked_from_thread_id: string;
  readonly fork_point_turn_count: number;
  readonly workspace_mode: string;
  readonly fidelity_mode: string;
  readonly created_at: string;
}

// FAKE CheckpointStore: only `forkBaseline` is exercised by the reactor; it
// records the call and returns the supplied result. The rest die so an
// unexpected call surfaces loudly.
function makeCheckpointStoreFake(
  forkBaselineCalls: Array<CheckpointStore.ForkBaselineInput>,
  result = true,
) {
  return Layer.succeed(CheckpointStore.CheckpointStore, {
    isGitRepository: () => Effect.succeed(true),
    captureCheckpoint: () => Effect.void,
    hasCheckpointRef: () => Effect.succeed(true),
    restoreCheckpoint: () => Effect.succeed(true),
    diffCheckpoints: () => Effect.succeed(""),
    deleteCheckpointRefs: () => Effect.void,
    forkBaseline: (input) =>
      Effect.sync(() => {
        forkBaselineCalls.push(input);
      }).pipe(Effect.as(result)),
  });
}

// FAKE GitWorkflowService: only `createWorktree` is exercised; it records the
// call and returns a fixture worktree. The rest die.
function makeGitWorkflowFake(
  worktreePath: string,
  createWorktreeCalls: Array<VcsCreateWorktreeInput>,
) {
  return Layer.succeed(GitWorkflowService, {
    status: () => Effect.die("unused in ScientForkReactor test"),
    localStatus: () => Effect.die("unused in ScientForkReactor test"),
    remoteStatus: () => Effect.die("unused in ScientForkReactor test"),
    invalidateLocalStatus: () => Effect.void,
    invalidateRemoteStatus: () => Effect.void,
    invalidateStatus: () => Effect.void,
    pullCurrentBranch: () => Effect.die("unused in ScientForkReactor test"),
    runStackedAction: () => Effect.die("unused in ScientForkReactor test"),
    resolvePullRequest: () => Effect.die("unused in ScientForkReactor test"),
    preparePullRequestThread: () => Effect.die("unused in ScientForkReactor test"),
    listRefs: () => Effect.die("unused in ScientForkReactor test"),
    createWorktree: (input) =>
      Effect.sync(() => {
        createWorktreeCalls.push(input);
      }).pipe(
        Effect.as({
          worktree: { path: worktreePath, refName: input.newRefName ?? input.refName },
        }),
      ),
    fetchRemote: () => Effect.die("unused in ScientForkReactor test"),
    remoteExists: () => Effect.die("unused in ScientForkReactor test"),
    resolveRemoteTrackingCommit: () => Effect.die("unused in ScientForkReactor test"),
    removeWorktree: () => Effect.die("unused in ScientForkReactor test"),
    createRef: () => Effect.die("unused in ScientForkReactor test"),
    switchRef: () => Effect.die("unused in ScientForkReactor test"),
    renameBranch: () => Effect.die("unused in ScientForkReactor test"),
  });
}

// Real OrchestrationEngine + in-memory persistence + real ProjectionSnapshotQuery
// (so the Scient lineage projector actually folds thread.forked). CheckpointStore
// and GitWorkflowService are faked so no real git repository is needed. SqlClient
// is exposed at the top so the test can read the lineage table (the shared
// memoized :memory: instance).
function makeHarnessLayer(
  forkBaselineCalls: Array<CheckpointStore.ForkBaselineInput>,
  createWorktreeCalls: Array<VcsCreateWorktreeInput>,
) {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );
  const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );

  return ScientForkReactorLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectionSnapshotLayer),
    Layer.provideMerge(makeCheckpointStoreFake(forkBaselineCalls)),
    Layer.provideMerge(makeGitWorkflowFake(NEW_WORKTREE_FIXTURE, createWorktreeCalls)),
    // Expose SqlClient (shared, memoized instance) so the test can read the
    // Scient lineage table directly.
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-scient-fork-reactor-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

// Poll a read effect until the predicate holds (or the attempt budget runs out,
// in which case the last value is returned so the assertion produces a precise
// failure). Uses the live clock via `it.live`.
const pollUntil = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean,
  attempts = 300,
): Effect.Effect<A, E, R> =>
  read.pipe(
    Effect.flatMap((value) =>
      predicate(value) || attempts <= 0
        ? Effect.succeed(value)
        : Effect.sleep("10 millis").pipe(Effect.andThen(pollUntil(read, predicate, attempts - 1))),
    ),
  );

// Seed a project + origin thread, capture ONE completed turn (checkpoint at turn
// 1), then dispatch the fork and wait for the reactor to finalize it.
const runForkScenario = (workspaceMode: "local" | "new-worktree", forkCommandId: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const reactor = yield* ScientForkReactor;
    const sql = yield* SqlClient.SqlClient;

    // The reactor consumes a HOT domain-event stream (new events only), so it
    // must be started before the fork command is dispatched.
    yield* reactor.start();

    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-fork-project"),
      projectId: PROJECT_ID,
      title: "Fork Project",
      workspaceRoot: WORKSPACE_ROOT,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt: CREATED_AT,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-fork-thread"),
      threadId: ORIGIN,
      projectId: PROJECT_ID,
      title: "Origin",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: ORIGIN_WORKTREE,
      createdAt: CREATED_AT,
    });
    yield* engine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: CommandId.make("cmd-fork-diff-1"),
      threadId: ORIGIN,
      turnId: TurnId.make("origin-turn-1"),
      completedAt: CREATED_AT,
      checkpointRef: checkpointRefForThreadTurn(ORIGIN, FORK_AT_TURN),
      status: "ready",
      files: [],
      checkpointTurnCount: FORK_AT_TURN,
      createdAt: CREATED_AT,
    });

    // Wait until the origin's checkpoint context is projected so the reactor
    // (which reads it) resolves a workspace + checkpoints rather than the
    // chat-only fallback.
    yield* pollUntil(
      snapshotQuery.getThreadCheckpointContext(ORIGIN),
      (ctx) =>
        Option.isSome(ctx) &&
        ctx.value.worktreePath === ORIGIN_WORKTREE &&
        ctx.value.checkpoints.length >= 1,
    );

    yield* engine.dispatch({
      type: "thread.fork",
      commandId: CommandId.make(forkCommandId),
      originThreadId: ORIGIN,
      newThreadId: NEW,
      forkAtTurnCount: FORK_AT_TURN,
      workspaceMode,
    });

    // The reactor's last action is thread.fork.complete → thread.fork-completed;
    // observing it in the event store means processing finished and the fakes
    // were called.
    yield* pollUntil(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
      (events) => events.some((event) => event.type === "thread.fork-completed"),
    );

    return { engine, snapshotQuery, sql };
  });

const readNewThreadWorktree = (snapshotQuery: ProjectionSnapshotQuery["Service"]) =>
  snapshotQuery
    .getSnapshot()
    .pipe(
      Effect.map((snapshot) => snapshot.threads.find((thread) => thread.id === NEW)?.worktreePath),
    );

const readLineageRow = (sql: SqlClient.SqlClient) =>
  sql<LineageRow>`SELECT * FROM scient_thread_lineage WHERE thread_id = ${NEW}`.pipe(
    Effect.map((rows) => rows[0]),
  );

describe("ScientForkReactor", () => {
  it.live("provisions a shared-worktree baseline for a local fork", () => {
    const forkBaselineCalls: Array<CheckpointStore.ForkBaselineInput> = [];
    const createWorktreeCalls: Array<VcsCreateWorktreeInput> = [];

    return Effect.gen(function* () {
      const { snapshotQuery, sql } = yield* runForkScenario("local", "cmd-fork-local");

      // forkBaseline copies origin turn-1 ref → new-thread turn-0 ref against
      // the origin's worktree cwd.
      expect(forkBaselineCalls).toHaveLength(1);
      expect(forkBaselineCalls[0]).toEqual({
        cwd: ORIGIN_WORKTREE,
        fromCheckpointRef: checkpointRefForThreadTurn(ORIGIN, FORK_AT_TURN),
        toCheckpointRef: checkpointRefForThreadTurn(NEW, 0),
      });
      // "local" mode never provisions a new worktree.
      expect(createWorktreeCalls).toHaveLength(0);

      // The new thread adopts the origin thread's worktree.
      const worktreePath = yield* pollUntil(
        readNewThreadWorktree(snapshotQuery),
        (value) => value === ORIGIN_WORKTREE,
      );
      expect(worktreePath).toBe(ORIGIN_WORKTREE);

      const lineage = yield* pollUntil(readLineageRow(sql), (row) => row !== undefined);
      expect(lineage?.fidelity_mode).toBe("chat-only");
      expect(lineage?.forked_from_thread_id).toBe(ORIGIN);
      expect(lineage?.workspace_mode).toBe("local");
    }).pipe(Effect.provide(makeHarnessLayer(forkBaselineCalls, createWorktreeCalls)));
  });

  it.live("provisions a dedicated worktree for a new-worktree fork", () => {
    const forkBaselineCalls: Array<CheckpointStore.ForkBaselineInput> = [];
    const createWorktreeCalls: Array<VcsCreateWorktreeInput> = [];

    return Effect.gen(function* () {
      const { snapshotQuery, sql } = yield* runForkScenario("new-worktree", "cmd-fork-worktree");

      expect(forkBaselineCalls).toHaveLength(1);
      expect(forkBaselineCalls[0]).toEqual({
        cwd: ORIGIN_WORKTREE,
        fromCheckpointRef: checkpointRefForThreadTurn(ORIGIN, FORK_AT_TURN),
        toCheckpointRef: checkpointRefForThreadTurn(NEW, 0),
      });

      // A fresh worktree is created off the fork-point ref, on a Scient fork branch.
      expect(createWorktreeCalls).toHaveLength(1);
      expect(createWorktreeCalls[0]).toEqual({
        cwd: ORIGIN_WORKTREE,
        refName: checkpointRefForThreadTurn(ORIGIN, FORK_AT_TURN),
        newRefName: `scient/fork/${NEW}`,
        path: null,
      });

      // The new thread records the freshly-created worktree path, not the origin's.
      const worktreePath = yield* pollUntil(
        readNewThreadWorktree(snapshotQuery),
        (value) => value === NEW_WORKTREE_FIXTURE,
      );
      expect(worktreePath).toBe(NEW_WORKTREE_FIXTURE);

      const lineage = yield* pollUntil(readLineageRow(sql), (row) => row !== undefined);
      expect(lineage?.fidelity_mode).toBe("chat-only");
      expect(lineage?.workspace_mode).toBe("new-worktree");
    }).pipe(Effect.provide(makeHarnessLayer(forkBaselineCalls, createWorktreeCalls)));
  });
});
