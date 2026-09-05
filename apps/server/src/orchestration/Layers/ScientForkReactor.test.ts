import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type VcsCreateWorktreeInput,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
import {
  testLayer as ScientForkCheckpointBaselineTest,
  type ScientForkCheckpointBaselineShape,
} from "../scient-fork/ForkCheckpointBaseline.ts";
import {
  ScientForkAttachmentCopyError,
  testLayer as ScientForkAttachmentCopierTest,
  type ScientForkAttachmentCopierShape,
} from "../scient-fork/ForkAttachmentCopier.ts";

const PROJECT_ID = ProjectId.make("project-fork-1");
const ORIGIN = ThreadId.make("origin-thread-fork");
const NEW = ThreadId.make("new-thread-fork");
const WORKSPACE_ROOT = "/tmp/scient-fork-workspace";
const ORIGIN_WORKTREE = "/tmp/scient-fork-origin-worktree";
const NEW_WORKTREE_FIXTURE = "/tmp/scient-fork-new-worktree";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const FORK_AT_TURN = 1;
const SOURCE_USER_MESSAGE_ID = MessageId.make("origin-user-1");
const SOURCE_ASSISTANT_MESSAGE_ID = MessageId.make("origin-assistant-1");

interface LineageRow {
  readonly thread_id: string;
  readonly forked_from_thread_id: string;
  readonly fork_point_turn_count: number;
  readonly workspace_mode: string;
  readonly fidelity_mode: string;
  readonly status: string;
  readonly checkpoint_status: string;
  readonly workspace_status: string;
  readonly attempt_count: number;
  readonly last_error: string | null;
  readonly created_at: string;
}

// The Git operation itself is independently tested by the Scient-owned helper;
// the reactor fake records only the baseline contract it requests.
function makeCheckpointBaselineFake(
  forkBaselineCalls: Array<Parameters<ScientForkCheckpointBaselineShape["copy"]>[0]>,
  result = true,
  overrides?: Partial<ScientForkCheckpointBaselineShape>,
) {
  return ScientForkCheckpointBaselineTest({
    copy: (input) =>
      Effect.sync(() => {
        forkBaselineCalls.push(input);
      }).pipe(Effect.as(result)),
    ...overrides,
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
    listRefs: () =>
      Effect.succeed({
        refs: [],
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        totalCount: 0,
      }),
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
    remoteBranchExists: () => Effect.die("unused in ScientForkReactor test"),
    resolveRemoteTrackingCommit: () => Effect.die("unused in ScientForkReactor test"),
    removeWorktree: () => Effect.die("unused in ScientForkReactor test"),
    pruneWorktrees: () => Effect.die("unused in ScientForkReactor test"),
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
  forkBaselineCalls: Array<Parameters<ScientForkCheckpointBaselineShape["copy"]>[0]>,
  createWorktreeCalls: Array<VcsCreateWorktreeInput>,
  baselineResult = true,
  attachmentCopierOverrides?: Partial<ScientForkAttachmentCopierShape>,
  baselineOverrides?: Partial<ScientForkCheckpointBaselineShape>,
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
    Layer.provideMerge(
      makeCheckpointBaselineFake(forkBaselineCalls, baselineResult, baselineOverrides),
    ),
    Layer.provideMerge(ScientForkAttachmentCopierTest(attachmentCopierOverrides)),
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

// Seed a project + origin thread with one completed checkpointed turn.
const seedOrigin = (checkpointStatus: "ready" | "missing" = "ready") =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
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
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-fork-turn-start-1"),
      threadId: ORIGIN,
      message: {
        messageId: SOURCE_USER_MESSAGE_ID,
        role: "user",
        text: "Investigate the result",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: CREATED_AT,
    });
    yield* engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: CommandId.make("cmd-fork-assistant-complete-1"),
      threadId: ORIGIN,
      messageId: SOURCE_ASSISTANT_MESSAGE_ID,
      turnId: TurnId.make("origin-turn-1"),
      createdAt: CREATED_AT,
    });
    yield* engine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: CommandId.make("cmd-fork-diff-1"),
      threadId: ORIGIN,
      turnId: TurnId.make("origin-turn-1"),
      completedAt: CREATED_AT,
      checkpointRef: checkpointRefForThreadTurn(ORIGIN, FORK_AT_TURN),
      status: checkpointStatus,
      files: [],
      assistantMessageId: SOURCE_ASSISTANT_MESSAGE_ID,
      checkpointTurnCount: FORK_AT_TURN,
      createdAt: CREATED_AT,
    });
  });

const dispatchFork = (workspaceMode: "local" | "new-worktree", forkCommandId: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.fork",
      commandId: CommandId.make(forkCommandId),
      originThreadId: ORIGIN,
      newThreadId: NEW,
      sourceAssistantMessageId: SOURCE_ASSISTANT_MESSAGE_ID,
      workspaceMode,
    });
  });

const dispatchUserMessageFork = (forkCommandId: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.fork",
      commandId: CommandId.make(forkCommandId),
      originThreadId: ORIGIN,
      newThreadId: NEW,
      sourceUserMessageId: SOURCE_USER_MESSAGE_ID,
      workspaceMode: "local",
    });
  });

// Start the worker, dispatch the fork, and await its typed completion receipt.
const runForkScenario = (
  workspaceMode: "local" | "new-worktree",
  forkCommandId: string,
  archiveOrigin = false,
) =>
  Effect.gen(function* () {
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const reactor = yield* ScientForkReactor;
    const sql = yield* SqlClient.SqlClient;

    // The reactor consumes a HOT domain-event stream (new events only), so it
    // must be started before the fork command is dispatched.
    yield* reactor.start();
    yield* seedOrigin();
    if (archiveOrigin) {
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`${forkCommandId}-archive-origin`),
        threadId: ORIGIN,
      });
    }

    const completionFiber = yield* Effect.forkChild(reactor.awaitCompletion(NEW));

    yield* dispatchFork(workspaceMode, forkCommandId);

    yield* Fiber.join(completionFiber);
    yield* reactor.drain;

    return { snapshotQuery, sql };
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
  it.live(
    "can restore a removed origin worktree from the project checkpoint without substituting a local workspace",
    () => {
      const baselineCalls: Array<Parameters<ScientForkCheckpointBaselineShape["copy"]>[0]> = [];
      const worktreeCalls: Array<VcsCreateWorktreeInput> = [];
      return Effect.gen(function* () {
        const reactor = yield* ScientForkReactor;
        yield* seedOrigin();
        const options = yield* reactor.getOptions({ originThreadId: ORIGIN });
        expect(options.localAvailable).toBe(false);
        expect(options.newWorktree).toBe(true);
        expect(options.reason).toContain("original worktree");
        yield* dispatchFork("new-worktree", "restore-worktree");
        yield* reactor.awaitCompletion(NEW);
        yield* reactor.drain;
        expect(baselineCalls[0]?.cwd).toBe(WORKSPACE_ROOT);
        expect(worktreeCalls[0]?.cwd).toBe(WORKSPACE_ROOT);
      }).pipe(
        Effect.provide(
          makeHarnessLayer(baselineCalls, worktreeCalls, true, undefined, {
            workspaceExists: (cwd) => Effect.succeed(cwd === WORKSPACE_ROOT),
          }),
        ),
      );
    },
  );

  it.live(
    "rejects a send before provisioning without adding the user's message to a disposable fork",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const query = yield* ProjectionSnapshotQuery;
        yield* seedOrigin();
        yield* dispatchFork("local", "pending-send-gate");
        const result = yield* Effect.result(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("early-send"),
            threadId: NEW,
            message: {
              messageId: MessageId.make("early-message"),
              role: "user",
              text: "Keep my unsent draft",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: CREATED_AT,
          }),
        );
        expect(result._tag).toBe("Failure");
        const detail = yield* query.getThreadDetailById(NEW);
        expect(
          Option.isSome(detail) &&
            detail.value.messages.some((message) => message.id === "early-message"),
        ).toBe(false);
      }).pipe(Effect.provide(makeHarnessLayer([], []))),
  );

  it.live(
    "preserves lineage and inherited history through renaming, changing providers, and reforking",
    () =>
      Effect.gen(function* () {
        const { snapshotQuery } = yield* runForkScenario("local", "rename-provider-fork");
        const engine = yield* OrchestrationEngineService;
        const reactor = yield* ScientForkReactor;
        const fork = Option.getOrThrow(yield* snapshotQuery.getThreadDetailById(NEW));
        expect(fork.session).toBeNull();
        const modelSelection = {
          instanceId: ProviderInstanceId.make("my-other-provider"),
          model: "chosen-model",
        };
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("rename-original"),
          threadId: ORIGIN,
          title: "Renamed original",
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("rename-fork"),
          threadId: NEW,
          title: "Independent name",
          modelSelection,
        });
        const renamed = Option.getOrThrow(yield* snapshotQuery.getThreadDetailById(NEW));
        expect(renamed.forkLineage?.originThreadId).toBe(ORIGIN);
        expect(renamed.modelSelection).toEqual(modelSelection);
        expect(renamed.messages).toEqual(fork.messages);
        expect(renamed.session).toBeNull();
        const childId = ThreadId.make("fork-of-renamed-fork");
        yield* engine.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("refork-renamed"),
          originThreadId: NEW,
          newThreadId: childId,
          sourceAssistantMessageId: renamed.forkLineage!.baselineAssistantMessageId!,
          workspaceMode: "local",
        });
        yield* reactor.awaitCompletion(childId);
        const child = Option.getOrThrow(yield* snapshotQuery.getThreadDetailById(childId));
        expect(child.messages.map((message) => message.text)).toEqual(
          fork.messages.map((message) => message.text),
        );
        expect(child.modelSelection).toEqual(modelSelection);
        expect(child.session).toBeNull();
        expect(child.forkLineage?.originThreadId).toBe(NEW);
        expect(Option.getOrThrow(yield* snapshotQuery.getThreadDetailById(ORIGIN)).title).toBe(
          "Renamed original",
        );
      }).pipe(Effect.provide(makeHarnessLayer([], []))),
  );

  it.live(
    "checks fork eligibility against durable turn state and resolves user forks separately",
    () =>
      Effect.gen(function* () {
        const reactor = yield* ScientForkReactor;
        const sql = yield* SqlClient.SqlClient;
        yield* seedOrigin();
        const completed = yield* reactor.getOptions({ originThreadId: ORIGIN });
        expect(completed.available).toBe(true);
        expect(completed.sourceAssistantMessageId).toBe(SOURCE_ASSISTANT_MESSAGE_ID);
        yield* sql`UPDATE projection_turns SET state = 'interrupted' WHERE thread_id = ${ORIGIN}`;
        const interrupted = yield* reactor.getOptions({
          originThreadId: ORIGIN,
          sourceAssistantMessageId: SOURCE_ASSISTANT_MESSAGE_ID,
        });
        expect(interrupted.available).toBe(false);
        expect(interrupted.reason).toContain("did not finish");
        const request = yield* reactor.getOptions({
          originThreadId: ORIGIN,
          sourceUserMessageId: SOURCE_USER_MESSAGE_ID,
        });
        expect(request.available).toBe(true);
        expect(request.newWorktree).toBe(false);
      }).pipe(Effect.provide(makeHarnessLayer([], []))),
  );

  it.live("retries a transient provisioning failure in place without a server restart", () => {
    let attempts = 0;
    return Effect.gen(function* () {
      const reactor = yield* ScientForkReactor;
      const sql = yield* SqlClient.SqlClient;
      yield* seedOrigin();
      yield* dispatchFork("local", "retry-same-fork");
      const first = yield* Effect.result(reactor.awaitCompletion(NEW));
      expect(first._tag).toBe("Failure");
      yield* reactor.drain;
      expect(yield* reactor.getDisposition(NEW)).toBe("failed");
      yield* dispatchFork("local", "retry-same-fork");
      yield* reactor.awaitCompletion(NEW);
      yield* reactor.drain;
      expect(yield* reactor.getDisposition(NEW)).toBe("ready");
      expect((yield* readLineageRow(sql))?.attempt_count).toBe(2);
      expect(attempts).toBe(2);
    }).pipe(
      Effect.provide(
        makeHarnessLayer([], [], true, {
          copyAll: ({ threadId }) =>
            Effect.suspend(() => {
              attempts++;
              return attempts === 1
                ? Effect.fail(
                    new ScientForkAttachmentCopyError({
                      threadId,
                      reason: "target-write-failed",
                      detail: "Disk temporarily unavailable",
                    }),
                  )
                : Effect.void;
            }),
        }),
      ),
    );
  });

  it.live("reports missing history dependencies before creating a destination", () =>
    Effect.gen(function* () {
      const reactor = yield* ScientForkReactor;
      const sql = yield* SqlClient.SqlClient;
      yield* seedOrigin();
      const options = yield* reactor.getOptions({ originThreadId: ORIGIN });
      expect(options.available).toBe(false);
      expect(options.reason).toContain("Unavailable evidence.png");
      expect(yield* readLineageRow(sql)).toBeUndefined();
    }).pipe(
      Effect.provide(
        makeHarnessLayer([], [], true, {
          checkSources: ({ threadId }) =>
            Effect.fail(
              new ScientForkAttachmentCopyError({
                threadId,
                reason: "source-unavailable",
                detail: "Unavailable evidence.png",
              }),
            ),
        }),
      ),
    ),
  );

  it.live("provisions a shared-worktree baseline for a local fork", () => {
    const forkBaselineCalls: Array<Parameters<ScientForkCheckpointBaselineShape["copy"]>[0]> = [];
    const createWorktreeCalls: Array<VcsCreateWorktreeInput> = [];

    return Effect.gen(function* () {
      const { snapshotQuery, sql } = yield* runForkScenario("local", "cmd-fork-local");

      // The checkpoint baseline copies origin turn-1 ref → new-thread turn-0 ref against
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
      const worktreePath = yield* readNewThreadWorktree(snapshotQuery);
      expect(worktreePath).toBe(ORIGIN_WORKTREE);

      const lineage = yield* readLineageRow(sql);
      expect(lineage?.fidelity_mode).toBe("transcript-bootstrap");
      expect(lineage?.forked_from_thread_id).toBe(ORIGIN);
      expect(lineage?.workspace_mode).toBe("local");

      const detail = yield* snapshotQuery.getThreadDetailById(NEW);
      expect(Option.isSome(detail)).toBe(true);
      if (Option.isSome(detail)) {
        expect(detail.value.forkLineage).toMatchObject({
          originThreadId: ORIGIN,
        });
        expect(detail.value.forkLineage?.baselineAssistantMessageId).not.toBeNull();
      }
    }).pipe(Effect.provide(makeHarnessLayer(forkBaselineCalls, createWorktreeCalls)));
  });

  it.live("provisions a dedicated worktree for a new-worktree fork", () => {
    const forkBaselineCalls: Array<Parameters<ScientForkCheckpointBaselineShape["copy"]>[0]> = [];
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
      const worktreePath = yield* readNewThreadWorktree(snapshotQuery);
      expect(worktreePath).toBe(NEW_WORKTREE_FIXTURE);

      const lineage = yield* readLineageRow(sql);
      expect(lineage?.fidelity_mode).toBe("transcript-bootstrap");
      expect(lineage?.workspace_mode).toBe("new-worktree");
    }).pipe(Effect.provide(makeHarnessLayer(forkBaselineCalls, createWorktreeCalls)));
  });

  it.live("leaves a user-message fork empty for an unsent client composer draft", () => {
    const forkBaselineCalls: Array<Parameters<ScientForkCheckpointBaselineShape["copy"]>[0]> = [];
    const createWorktreeCalls: Array<VcsCreateWorktreeInput> = [];

    return Effect.gen(function* () {
      const reactor = yield* ScientForkReactor;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* reactor.start();
      yield* seedOrigin();

      const completionFiber = yield* Effect.forkChild(reactor.awaitCompletion(NEW));
      yield* dispatchUserMessageFork("cmd-fork-from-user-message");
      yield* Fiber.join(completionFiber);
      yield* reactor.drain;

      const detail = yield* snapshotQuery.getThreadDetailById(NEW);
      expect(Option.isSome(detail)).toBe(true);
      if (Option.isSome(detail)) {
        expect(detail.value.messages).toHaveLength(0);
        expect(
          detail.value.messages.some((message) => message.id === SOURCE_ASSISTANT_MESSAGE_ID),
        ).toBe(false);
        expect(detail.value.forkLineage).toMatchObject({
          originThreadId: ORIGIN,
        });
      }

      const [lineage] = yield* sql<{
        readonly baseline_assistant_message_id: string | null;
        readonly fork_point_kind: string;
        readonly source_user_message_id: string | null;
        readonly copied_boundaries_json: string;
      }>`
        SELECT
          baseline_assistant_message_id,
          fork_point_kind,
          source_user_message_id,
          copied_boundaries_json
        FROM scient_thread_lineage
        WHERE thread_id = ${NEW}
      `;
      expect(lineage).toEqual({
        baseline_assistant_message_id: null,
        fork_point_kind: "user-message",
        source_user_message_id: SOURCE_USER_MESSAGE_ID,
        copied_boundaries_json: "[]",
      });
      expect(forkBaselineCalls).toHaveLength(0);
      expect(createWorktreeCalls).toHaveLength(0);
    }).pipe(Effect.provide(makeHarnessLayer(forkBaselineCalls, createWorktreeCalls)));
  });

  it.live("hydrates and forks an archived origin by its authoritative id", () => {
    const forkBaselineCalls: Array<Parameters<ScientForkCheckpointBaselineShape["copy"]>[0]> = [];
    const createWorktreeCalls: Array<VcsCreateWorktreeInput> = [];

    return Effect.gen(function* () {
      const { snapshotQuery } = yield* runForkScenario("local", "cmd-fork-archived-origin", true);
      const origin = yield* snapshotQuery.getThreadDetailById(ORIGIN);
      const fork = yield* snapshotQuery.getThreadDetailById(NEW);
      expect(Option.isSome(origin) && origin.value.archivedAt !== null).toBe(true);
      expect(Option.isSome(fork)).toBe(true);
    }).pipe(Effect.provide(makeHarnessLayer(forkBaselineCalls, createWorktreeCalls)));
  });

  it.live("recovers a durable pending fork when the event was missed before startup", () => {
    const forkBaselineCalls: Array<Parameters<ScientForkCheckpointBaselineShape["copy"]>[0]> = [];
    const createWorktreeCalls: Array<VcsCreateWorktreeInput> = [];

    return Effect.gen(function* () {
      const reactor = yield* ScientForkReactor;
      const sql = yield* SqlClient.SqlClient;
      yield* seedOrigin();
      yield* dispatchFork("local", "cmd-fork-before-reactor-start");

      const pending = yield* readLineageRow(sql);
      expect(pending?.status).toBe("pending");

      yield* reactor.start();
      yield* reactor.awaitCompletion(NEW);
      yield* reactor.drain;

      const completed = yield* readLineageRow(sql);
      expect(completed?.status).toBe("ready");
      expect(completed?.attempt_count).toBe(1);
      expect(forkBaselineCalls).toHaveLength(1);
    }).pipe(Effect.provide(makeHarnessLayer(forkBaselineCalls, createWorktreeCalls)));
  });

  it.live("self-enqueues the durable fork while awaiting its completion receipt", () => {
    const forkBaselineCalls: Array<Parameters<ScientForkCheckpointBaselineShape["copy"]>[0]> = [];
    const createWorktreeCalls: Array<VcsCreateWorktreeInput> = [];

    return Effect.gen(function* () {
      const reactor = yield* ScientForkReactor;
      const sql = yield* SqlClient.SqlClient;
      yield* seedOrigin();
      yield* dispatchFork("local", "cmd-fork-durable-receipt");

      // No reactor.start(): this exercises the durable receipt path without
      // relying on the live event subscription or startup recovery scan.
      yield* reactor.awaitCompletion(NEW);
      yield* reactor.drain;

      expect((yield* readLineageRow(sql))?.status).toBe("ready");
      expect(forkBaselineCalls).toHaveLength(1);
    }).pipe(Effect.provide(makeHarnessLayer(forkBaselineCalls, createWorktreeCalls)));
  });

  it.live("removes an unusable fork when a dedicated worktree has no checkpoint", () => {
    const forkBaselineCalls: Array<Parameters<ScientForkCheckpointBaselineShape["copy"]>[0]> = [];
    const createWorktreeCalls: Array<VcsCreateWorktreeInput> = [];

    return Effect.gen(function* () {
      const reactor = yield* ScientForkReactor;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* reactor.start();
      yield* seedOrigin();
      yield* dispatchFork("new-worktree", "cmd-fork-missing-checkpoint");
      yield* reactor.drain;

      const failure = yield* Effect.result(reactor.awaitCompletion(NEW));
      expect(failure._tag).toBe("Failure");
      const lineage = yield* readLineageRow(sql);
      expect(lineage?.status).toBe("abandoned");
      expect(lineage?.attempt_count).toBe(1);
      expect(lineage?.last_error).toContain("cannot be created");
      expect(createWorktreeCalls).toHaveLength(0);
      expect(Option.isNone(yield* snapshotQuery.getThreadDetailById(NEW))).toBe(true);
    }).pipe(Effect.provide(makeHarnessLayer(forkBaselineCalls, createWorktreeCalls, false)));
  });

  it.live("forks a completed non-Git conversation in the same workspace", () => {
    const forkBaselineCalls: Array<Parameters<ScientForkCheckpointBaselineShape["copy"]>[0]> = [];
    const createWorktreeCalls: Array<VcsCreateWorktreeInput> = [];

    return Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const reactor = yield* ScientForkReactor;
      yield* reactor.start();
      yield* seedOrigin("missing");

      const completionFiber = yield* Effect.forkChild(reactor.awaitCompletion(NEW));
      yield* dispatchFork("local", "cmd-fork-non-git");
      yield* Fiber.join(completionFiber);
      yield* reactor.drain;

      expect(forkBaselineCalls).toHaveLength(0);
      expect(createWorktreeCalls).toHaveLength(0);
      const detail = yield* snapshotQuery.getThreadDetailById(NEW);
      expect(Option.isSome(detail)).toBe(true);
      if (Option.isSome(detail)) {
        expect(detail.value.forkLineage).toMatchObject({
          originThreadId: ORIGIN,
        });
        expect(detail.value.forkLineage?.baselineAssistantMessageId).not.toBeNull();
      }
    }).pipe(Effect.provide(makeHarnessLayer(forkBaselineCalls, createWorktreeCalls)));
  });

  it.live("removes a fork whose retained origin attachment disappeared", () => {
    const forkBaselineCalls: Array<Parameters<ScientForkCheckpointBaselineShape["copy"]>[0]> = [];
    const createWorktreeCalls: Array<VcsCreateWorktreeInput> = [];

    return Effect.gen(function* () {
      const reactor = yield* ScientForkReactor;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* reactor.start();
      yield* seedOrigin();
      yield* dispatchFork("local", "cmd-fork-missing-origin-attachment");
      yield* reactor.drain;

      const result = yield* Effect.result(reactor.awaitCompletion(NEW));
      expect(result._tag).toBe("Failure");
      expect((yield* readLineageRow(sql))?.status).toBe("abandoned");
      expect(Option.isNone(yield* snapshotQuery.getThreadDetailById(NEW))).toBe(true);
    }).pipe(
      Effect.provide(
        makeHarnessLayer(forkBaselineCalls, createWorktreeCalls, true, {
          copyAll: ({ threadId }) =>
            Effect.fail(
              new ScientForkAttachmentCopyError({
                threadId,
                reason: "source-unavailable",
                detail: "The retained origin attachment disappeared.",
              }),
            ),
        }),
      ),
    );
  });
});
