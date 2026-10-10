// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EventId,
  GitCommandError,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ThreadForkCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as GitManager from "../../git/GitManager.ts";
import {
  layerFromPath as makeSqlitePersistenceLive,
  layerMemory as SqlitePersistenceMemory,
} from "../../persistence/Sqlite.ts";
import { ConversationImporter } from "../../scient/conversationImport/ConversationImporter.ts";
import {
  createNativeProjects,
  nativeImportRuntimeTestLayer,
} from "../../scient/conversationImport/conversationImport.native-test-harness.ts";
import {
  importFixture,
  testLease,
  destination,
  principal,
  PROVIDER_ID,
} from "../../scient/conversationImport/conversationImport.test-fixtures.ts";
import * as GitVcs from "../../vcs/GitVcsDriver.ts";
import * as VcsRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import { layerFromAdapters as makeLayer } from "../ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { CommandReceiptStoreV2 } from "../CommandReceiptStore.ts";
import { EffectOutboxV2 } from "../EffectOutbox.ts";
import { OrchestrationEffectWorkerV2 } from "../EffectWorker.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { ConversationForkService } from "./ConversationForkService.ts";

// Forks share history and files by reference, so only a dedicated worktree
// still needs durable setup: a new-worktree fork is accepted `pending` with a
// `scient-fork.provision` job; a local fork is `ready` at acceptance.

// --- New-worktree forks: a real Git workspace with saved checkpoints. ---

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "fixture" };
const sourceId = ThreadId.make("lifecycle-source");
const projectId = ProjectId.make("lifecycle-project");
const vcsLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const gitLayer = GitWorkflow.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      GitVcs.layer,
      VcsRegistry.layer,
      Layer.unwrap(
        Effect.map(GitVcs.GitVcsDriver, (git) =>
          Layer.mock(GitManager.GitManager)({
            // Execute real checkouts; this fixture has no settings overrides or submodules.
            createWorktree: git.createWorktree,
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
          }),
        ),
      ).pipe(Layer.provide(GitVcs.layer)),
    ),
  ),
  Layer.provide(vcsLayer),
  Layer.provide(NodeServices.layer),
);
/** Runs `before` ahead of every real worktree checkout; its failure stands in for Git's. */
function beforeCheckout(before: (cwd: string) => Effect.Effect<void, GitCommandError>) {
  return Layer.effect(
    GitWorkflow.GitWorkflowService,
    Effect.gen(function* () {
      const real = yield* GitWorkflow.GitWorkflowService;
      return {
        ...real,
        createWorktree: (
          input: Parameters<typeof real.createWorktree>[0],
          options?: Parameters<typeof real.createWorktree>[1],
        ) => before(input.cwd).pipe(Effect.andThen(real.createWorktree(input, options))),
      };
    }),
  ).pipe(Layer.provide(gitLayer));
}
const checkoutFault = (cwd: string) =>
  Effect.fail(
    new GitCommandError({
      operation: "GitWorkflowService.createWorktree",
      command: "git worktree add",
      cwd,
      detail: "Controlled worktree checkout failure",
    }),
  );
const makeRuntime = (
  workflow = gitLayer,
  options: NonNullable<Parameters<typeof makeOrchestratorV2ReplayLayerWithRegistry>[2]> = {},
) =>
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "native-fork-lifecycle" },
    makeLayer([
      {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: () => Effect.die("Fork provisioning cannot execute a provider"),
      },
    ]),
    {
      runEffectWorker: false,
      configureMcp: false,
      forkGitWorkflowLayer: workflow,
      layerDatabase: SqlitePersistenceMemory,
      ...options,
    },
  ).pipe(
    Layer.provideMerge(options.layerDatabase ?? SqlitePersistenceMemory),
    Layer.provideMerge(vcsLayer),
    Layer.provideMerge(NodeServices.layer),
  );
const git = Effect.fn("Lifecycle.git")(function* (cwd: string, args: string[]) {
  const result = yield* (yield* VcsProcess.VcsProcess).run({
    operation: "NativeForkLifecycle.test",
    command: "git",
    cwd,
    args,
  });
  assert.equal(result.exitCode, 0);
  return result.stdout.trim();
});
/** Commits turn `n` to Git, saves its checkpoint, and records the completed turn. */
const commitTurn = Effect.fn("Lifecycle.commitTurn")(function* (cwd: string, n: number) {
  const fs = yield* FileSystem.FileSystem;
  const now = yield* DateTime.now;
  yield* fs.writeFileString(NodePath.join(cwd, "evidence.txt"), `version ${n}`);
  yield* git(cwd, ["add", "evidence.txt"]);
  yield* git(cwd, ["commit", "-m", `Synthetic version ${n}`]);
  const oid = yield* git(cwd, ["rev-parse", "HEAD"]);
  const ref = CheckpointRef.make(`refs/scient/source/${n}`);
  yield* git(cwd, ["update-ref", ref, oid]);
  const runId = RunId.make(`lifecycle-run-${n}`);
  const nodeId = NodeId.make(`lifecycle-root-${n}`);
  const scopeId = CheckpointScopeId.make(`lifecycle-scope-${n}`);
  const checkpointId = CheckpointId.make(`lifecycle-checkpoint-${n}`);
  const run: OrchestrationV2Run = {
    id: runId,
    threadId: sourceId,
    ordinal: n,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`lifecycle-q${n}`),
    rootNodeId: nodeId,
    activeAttemptId: null,
    status: "completed",
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId,
    contextHandoffId: null,
  };
  const events: OrchestrationV2DomainEvent[] = [
    {
      id: EventId.make(`lifecycle-run-${n}`),
      threadId: sourceId,
      occurredAt: now,
      type: "run.created",
      payload: run,
    },
    {
      id: EventId.make(`lifecycle-scope-${n}`),
      threadId: sourceId,
      occurredAt: now,
      type: "checkpoint-scope.created",
      payload: {
        id: scopeId,
        threadId: sourceId,
        runId,
        nodeId,
        parentScopeId: null,
        providerThreadId: null,
        kind: "root_run",
        ordinalWithinParent: n,
        advancesAppRunCount: true,
        cwd,
        createdAt: now,
      },
    },
    {
      id: EventId.make(`lifecycle-checkpoint-${n}`),
      threadId: sourceId,
      occurredAt: now,
      type: "checkpoint.captured",
      payload: {
        id: checkpointId,
        threadId: sourceId,
        scopeId,
        runId,
        nodeId,
        parentCheckpointId: null,
        ordinalWithinScope: 1,
        appRunOrdinal: n,
        ref,
        status: "ready",
        files: [],
        capturedAt: now,
      },
    },
  ];
  const common = {
    threadId: sourceId,
    runId,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  const items: OrchestrationV2TurnItem[] = [
    {
      ...common,
      id: TurnItemId.make(`lifecycle-q${n}`),
      ordinal: n * 2 - 2,
      type: "user_message",
      status: "completed",
      createdBy: "user",
      creationSource: "web",
      inputIntent: "turn_start",
      messageId: MessageId.make(`lifecycle-q${n}`),
      text: `Question ${n}`,
      attachments: [],
    },
    {
      ...common,
      id: TurnItemId.make(`lifecycle-a${n}`),
      ordinal: n * 2 - 1,
      type: "assistant_message",
      status: "completed",
      streaming: false,
      messageId: MessageId.make(`lifecycle-a${n}`),
      text: `Answer ${n}`,
    },
  ];
  for (const item of items) {
    events.push({
      id: EventId.make(`lifecycle-item-${item.id}`),
      threadId: sourceId,
      occurredAt: now,
      type: "turn-item.updated",
      payload: item,
    });
    if (item.type === "user_message" || item.type === "assistant_message")
      events.push({
        id: EventId.make(`lifecycle-message-${item.id}`),
        threadId: sourceId,
        occurredAt: now,
        type: "message.updated",
        payload: {
          id: item.messageId,
          threadId: sourceId,
          runId,
          nodeId,
          role: item.type === "user_message" ? "user" : "assistant",
          createdBy: item.type === "user_message" ? "user" : "agent",
          creationSource: "web",
          text: item.text,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
  }
  yield* (yield* EventSinkV2).write({ events });
  return oid;
});
const seedWorkspace = Effect.fn("Lifecycle.seedWorkspace")(function* (suppliedCwd?: string) {
  const fs = yield* FileSystem.FileSystem;
  const cwd =
    suppliedCwd ?? (yield* fs.makeTempDirectoryScoped({ prefix: "native-fork-lifecycle-" }));
  yield* git(cwd, ["init", "-b", "main"]);
  yield* git(cwd, ["config", "user.name", "Synthetic Scient"]);
  yield* git(cwd, ["config", "user.email", "fixture@example.invalid"]);
  const now = yield* DateTime.now;
  yield* (yield* EventSinkV2).commitProjectCommand({
    commandId: CommandId.make("lifecycle-project"),
    projectId,
    commandType: "project.create",
    acceptedAt: now,
    event: {
      eventId: EventId.make("lifecycle-project"),
      type: "project.created",
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(now),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        projectId,
        title: "Fork lifecycle",
        workspaceRoot: cwd,
        scripts: [],
        createdAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
        defaultModelSelection: modelSelection,
      },
    },
  });
  yield* (yield* OrchestratorV2).dispatch({
    type: "thread.create",
    commandId: CommandId.make("lifecycle-source"),
    threadId: sourceId,
    projectId,
    title: "Source",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const commits: string[] = [];
  for (const n of [1, 2]) commits.push(yield* commitTurn(cwd, n));
  const command: ThreadForkCommand = {
    type: "thread.fork",
    commandId: CommandId.make("lifecycle-fork"),
    originThreadId: sourceId,
    newThreadId: ThreadId.make("lifecycle-target"),
    // The older turn: the fork's checkout must come from its checkpoint, not HEAD.
    sourceAssistantMessageId: MessageId.make("lifecycle-a1"),
    workspaceMode: "new-worktree",
  };
  return { cwd, commits, command };
});
const forkBranch = (threadId: ThreadId) =>
  `scient/fork/${threadId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
const branchExists = (cwd: string, threadId: ThreadId) =>
  git(cwd, ["branch", "--list", forkBranch(threadId)]).pipe(Effect.map((out) => out !== ""));
const acceptPending = Effect.fn("Lifecycle.acceptPending")(function* (command: ThreadForkCommand) {
  const sink = yield* EventSinkV2;
  const pull = yield* Stream.toPull(
    sink.stream({ threadId: command.newThreadId, eventType: "thread.created", afterSequence: 0 }),
  );
  const waiting = yield* (yield* ConversationForkService)
    .dispatch(command)
    .pipe(Effect.exit, Effect.forkChild);
  yield* pull;
  const pending = yield* (yield* ProjectionStoreV2).getThreadProjection(command.newThreadId);
  assert.equal(pending.thread.conversationFork?.status, "pending");
  return { waiting, pending };
});
const settledJobs = Effect.fn("Lifecycle.settledJobs")(function* (commandId: CommandId) {
  const outbox = yield* EffectOutboxV2;
  const pull = yield* Stream.toPull(
    Stream.merge(yield* outbox.subscribeCompletions, Stream.tick("10 millis")),
  );
  while (true) {
    const rows = yield* outbox.listByCommandId(commandId);
    if (
      rows.every(
        (row) =>
          row.status === "succeeded" || row.status === "failed" || row.status === "cancelled",
      )
    )
      return rows;
    yield* pull;
  }
});
/** Every fork status the destination's durable log published, in order. */
const publishedStatuses = Effect.fn("Lifecycle.publishedStatuses")(function* (threadId: ThreadId) {
  const sink = yield* EventSinkV2;
  const latest = yield* sink.latestSequence({ threadId });
  const events = yield* sink.stream({ threadId, afterSequence: 0 }).pipe(
    Stream.takeUntil((stored) => stored.sequence >= latest),
    Stream.runCollect,
    Effect.timeout("5 seconds"),
  );
  return events.flatMap(({ event }) =>
    (event.type === "thread.created" || event.type === "thread.metadata-updated") &&
    event.payload.conversationFork != null
      ? [event.payload.conversationFork.status]
      : [],
  );
});
const inheritedRows = (projection: { visibleTurnItems: ReadonlyArray<VisibleRow> }) =>
  projection.visibleTurnItems
    .filter((row) => row.visibility === "inherited")
    .map((row) => [row.sourceThreadId, row.sourceItemId, row.item.type]);
type VisibleRow = {
  readonly visibility: string;
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: TurnItemId;
  readonly item: OrchestrationV2TurnItem;
};

it.live(
  "a pending new-worktree fork owns immutable facts but refuses sends and child forks until its durable job completes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, commits, command } = yield* seedWorkspace();
        const store = yield* ProjectionStoreV2;
        const source = yield* store.getThreadProjection(sourceId);
        const { waiting, pending } = yield* acceptPending(command);
        const forks = yield* ConversationForkService;
        const sink = yield* EventSinkV2;
        const receipts = yield* CommandReceiptStoreV2;
        const outbox = yield* EffectOutboxV2;
        const frozen = pending.thread.conversationFork!;
        assert.equal(frozen.workspaceMode, "new-worktree");
        assert.equal(frozen.checkpointOid, commits[0]);
        assert.ok(frozen.checkpointRef);
        assert.equal(yield* git(cwd, ["rev-parse", frozen.checkpointRef]), commits[0]);
        assert.isNull(pending.thread.worktreePath);
        assert.isFalse(yield* branchExists(cwd, command.newThreadId));
        assert.deepEqual(inheritedRows(pending), [
          [sourceId, TurnItemId.make("lifecycle-q1"), "user_message"],
          [sourceId, TurnItemId.make("lifecycle-a1"), "assistant_message"],
        ]);
        const rows = yield* outbox.listByCommandId(command.commandId);
        assert.lengthOf(rows, 1);
        assert.equal(rows[0]?.request.type, "scient-fork.provision");
        assert.equal(rows[0]?.status, "pending");
        assert.equal(rows[0]?.attemptCount, 0);
        const replay = yield* forks.dispatch(command).pipe(Effect.exit, Effect.forkChild);
        const seq = yield* sink.latestSequence({});
        const send = yield* Effect.result(
          (yield* OrchestratorV2).dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("pending-send"),
            threadId: command.newThreadId,
            messageId: MessageId.make("disposable-message"),
            text: "Do not add this",
            dispatchMode: { type: "start_immediately" },
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          }),
        );
        assert.equal(send._tag, "Failure");
        if (send._tag === "Failure")
          assert.include(String(send.failure.cause), "Finish this fork's workspace setup");
        const inherited = pending.visibleTurnItems.find(
          (row) => row.item.type === "assistant_message",
        )?.item;
        assert.ok(inherited?.type === "assistant_message");
        const child = yield* Effect.result(
          forks.dispatch({
            ...command,
            commandId: CommandId.make("pending-child"),
            originThreadId: command.newThreadId,
            newThreadId: ThreadId.make("pending-child"),
            sourceAssistantMessageId: inherited.messageId,
            workspaceMode: "local",
          }),
        );
        assert.equal(child._tag, "Failure");
        if (child._tag === "Failure") {
          assert.include(child.failure.message, "Finish the original fork's workspace setup");
          assert.equal(child.failure.forkDisposition, "rejected");
        }
        assert.equal(yield* sink.latestSequence({}), seq);
        assert.deepEqual(yield* store.getThreadProjection(command.newThreadId), pending);
        assert.lengthOf(yield* outbox.listByCommandId(command.commandId), 1);
        // The refused send is recorded only as rejected; it committed nothing.
        const sendReceipt = yield* receipts.getByCommandId(CommandId.make("pending-send"));
        assert.ok(Option.isNone(sendReceipt) || sendReceipt.value.status === "rejected");
        assert.ok(Option.isNone(yield* receipts.getByCommandId(CommandId.make("pending-child"))));

        yield* (yield* OrchestrationEffectWorkerV2).drain();
        const completed = yield* Fiber.join(waiting);
        assert.equal(completed._tag, "Success");
        assert.deepEqual(yield* Fiber.join(replay), completed);
        const ready = yield* store.getThreadProjection(command.newThreadId);
        assert.deepEqual(ready.thread.conversationFork, { ...frozen, status: "ready" });
        assert.ok(ready.thread.worktreePath);
        assert.equal(ready.thread.branch, forkBranch(command.newThreadId));
        assert.equal(yield* git(ready.thread.worktreePath, ["rev-parse", "HEAD"]), commits[0]);
        assert.deepEqual(ready.messages, pending.messages);
        assert.deepEqual(ready.turnItems, pending.turnItems);
        assert.deepEqual(ready.visibleTurnItems, pending.visibleTurnItems);
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(
          yield* sql`SELECT thread_id FROM scient_thread_lineage WHERE thread_id = ${command.newThreadId}`,
          [],
        );
        const receipt = yield* forks.dispatch(command);
        assert.equal(
          receipt.sequence,
          completed._tag === "Success" ? completed.value.sequence : -1,
        );
        assert.deepEqual(
          receipt.forkAttachmentIdMap,
          Object.fromEntries(
            ready.thread.conversationFork!.attachmentCopies.map((copy) => [
              copy.source.id,
              copy.target.id,
            ]),
          ),
        );
        const after = yield* store.getThreadProjection(sourceId);
        assert.deepEqual(after.thread, source.thread);
        assert.deepEqual(after.messages, source.messages);
        assert.deepEqual(after.turnItems, source.turnItems);
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), commits[1]);
      }).pipe(Effect.provide(makeRuntime()), Effect.timeout("20 seconds")),
    ),
);

it.live(
  "new-worktree provisioning retries a transient checkout failure in place and publishes ready once",
  () => {
    let attempts = 0;
    return Effect.scoped(
      Effect.gen(function* () {
        const { cwd, commits, command } = yield* seedWorkspace();
        const store = yield* ProjectionStoreV2;
        const source = yield* store.getThreadProjection(sourceId);
        const forks = yield* ConversationForkService;
        const receipt = yield* forks.dispatch(command);
        const target = yield* store.getThreadProjection(command.newThreadId);
        assert.equal(attempts, 2);
        assert.equal(target.thread.conversationFork?.status, "ready");
        assert.isNull(target.thread.conversationFork?.error);
        assert.ok(target.thread.worktreePath);
        assert.equal(yield* git(target.thread.worktreePath, ["rev-parse", "HEAD"]), commits[0]);
        const rows = yield* settledJobs(command.commandId);
        assert.lengthOf(rows, 1);
        assert.equal(rows[0]?.attemptCount, 2);
        assert.equal(rows[0]?.status, "succeeded");
        assert.isNull(rows[0]?.lastError);
        // The failed attempt published nothing: no failed state was ever visible.
        assert.deepEqual(yield* publishedStatuses(command.newThreadId), ["pending", "ready"]);
        assert.equal((yield* forks.dispatch(command)).sequence, receipt.sequence);
        assert.equal(attempts, 2);
        const after = yield* store.getThreadProjection(sourceId);
        assert.deepEqual(after.thread, source.thread);
        assert.deepEqual(after.turnItems, source.turnItems);
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), commits[1]);
      }).pipe(
        Effect.provide(
          makeRuntime(
            beforeCheckout((cwd) => (++attempts === 1 ? checkoutFault(cwd) : Effect.void)),
            { runEffectWorker: true },
          ),
        ),
        Effect.timeout("20 seconds"),
      ),
    );
  },
);

it.live(
  "new-worktree provisioning exhausts bounded retries and explicit replay recovers the same destination without regressing ready",
  () => {
    let reject = true;
    let attempts = 0;
    return Effect.scoped(
      Effect.gen(function* () {
        const { cwd, commits, command } = yield* seedWorkspace();
        const forks = yield* ConversationForkService;
        const store = yield* ProjectionStoreV2;
        const result = yield* Effect.result(forks.dispatch(command));
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.forkDisposition, "failed");
        const failed = yield* store.getThreadProjection(command.newThreadId);
        assert.equal(attempts, 5);
        assert.equal(failed.thread.conversationFork?.status, "failed");
        const failedError = failed.thread.conversationFork?.error ?? "";
        // Clients get a plain error; the Git output and paths stay in the server log.
        assert.equal(failedError, "Unable to set up this fork's worktree. Retry the fork.");
        assert.isNull(failed.thread.deletedAt);
        assert.isNull(failed.thread.worktreePath);
        const rows = yield* settledJobs(command.commandId);
        assert.lengthOf(rows, 1);
        assert.equal(rows[0]?.attemptCount, 5);
        assert.equal(rows[0]?.status, "failed");
        reject = false;
        yield* forks.dispatch(command);
        const ready = yield* store.getThreadProjection(command.newThreadId);
        assert.deepEqual(ready.thread.conversationFork, {
          ...failed.thread.conversationFork!,
          status: "ready",
          error: null,
        });
        assert.ok(ready.thread.worktreePath);
        assert.equal(yield* git(ready.thread.worktreePath, ["rev-parse", "HEAD"]), commits[0]);
        assert.deepEqual(ready.messages, failed.messages);
        assert.deepEqual(ready.turnItems, failed.turnItems);
        assert.deepEqual(ready.visibleTurnItems, failed.visibleTurnItems);
        const recovered = yield* settledJobs(command.commandId);
        assert.lengthOf(recovered, 2);
        assert.equal(recovered.filter((row) => row.status === "succeeded").length, 1);
        reject = true;
        const before = attempts;
        yield* forks.provision(command.newThreadId, false);
        yield* forks.provision(command.newThreadId, true);
        yield* forks.dispatch(command);
        assert.equal(attempts, before);
        assert.deepEqual(yield* store.getThreadProjection(command.newThreadId), ready);
        assert.notInclude(failedError, cwd);
      }).pipe(
        Effect.provide(
          makeRuntime(
            beforeCheckout((cwd) => {
              attempts++;
              return reject ? checkoutFault(cwd) : Effect.void;
            }),
            { runEffectWorker: true },
          ),
        ),
        Effect.timeout("20 seconds"),
      ),
    );
  },
);

it.live(
  "deleting an accepted pending new-worktree fork settles its waiter and its job cannot publish it ready",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, command } = yield* seedWorkspace();
        const { waiting } = yield* acceptPending(command);
        yield* (yield* OrchestratorV2).dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-pending-fork"),
          threadId: command.newThreadId,
        });
        const waited = yield* Fiber.join(waiting);
        assert.equal(waited._tag, "Failure");
        const store = yield* ProjectionStoreV2;
        const deleted = yield* store.getThreadProjection(command.newThreadId);
        assert.isNotNull(deleted.thread.deletedAt);
        yield* (yield* OrchestrationEffectWorkerV2).drain();
        yield* (yield* ConversationForkService).provision(command.newThreadId, false);
        assert.deepEqual(yield* store.getThreadProjection(command.newThreadId), deleted);
        assert.notEqual(deleted.thread.conversationFork?.status, "ready");
        assert.isFalse(yield* branchExists(cwd, command.newThreadId));
      }).pipe(Effect.provide(makeRuntime()), Effect.timeout("20 seconds")),
    ),
);

it.live(
  "replaying an accepted fork after its pending destination was deleted settles without another event",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, command } = yield* seedWorkspace();
        const { waiting } = yield* acceptPending(command);
        yield* (yield* OrchestratorV2).dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-pending-fork-before-replay"),
          threadId: command.newThreadId,
        });
        const store = yield* ProjectionStoreV2;
        const sink = yield* EventSinkV2;
        const deleted = yield* store.getThreadProjection(command.newThreadId);
        assert.isNotNull(deleted.thread.deletedAt);
        assert.equal(deleted.thread.conversationFork?.status, "pending");

        // The replay reaches awaitReady after the terminal deletion is durable,
        // so its cursor cannot recover that event from a future-only stream.
        const forks = yield* ConversationForkService;
        const seq = yield* sink.latestSequence({});
        const replayError = yield* forks.dispatch(command).pipe(Effect.flip);
        assert.equal(replayError.forkDisposition, "abandoned");
        assert.equal(yield* sink.latestSequence({}), seq);
        assert.equal((yield* Fiber.join(waiting))._tag, "Failure");
        yield* (yield* OrchestrationEffectWorkerV2).drain();
        yield* forks.provision(command.newThreadId, false);
        assert.deepEqual(yield* store.getThreadProjection(command.newThreadId), deleted);
        assert.isFalse(yield* branchExists(cwd, command.newThreadId));
      }).pipe(Effect.provide(makeRuntime()), Effect.timeout("20 seconds")),
    ),
);

it.live.each(
  [false, true].map((claimedBeforeRestart) => ({
    caseTitle: `new-worktree startup recovers a frozen fork without its missed wakeup: interrupted-claim=${claimedBeforeRestart}`,
    claimedBeforeRestart,
  })),
)("$caseTitle", ({ claimedBeforeRestart }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const configLayer = Layer.succeed(ServerConfig, config);
      const database = makeSqlitePersistenceLive(config.dbPath).pipe(
        Layer.provide(NodeServices.layer),
      );
      const cwd = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "native-fork-lifecycle-restart-",
      });
      const saved = yield* Effect.scoped(
        Effect.gen(function* () {
          const { commits, command } = yield* seedWorkspace(cwd);
          const { pending } = yield* acceptPending(command);
          const outbox = yield* EffectOutboxV2;
          if (claimedBeforeRestart) {
            const claim = yield* outbox.claimNext({
              workerId: "interrupted-process",
              leaseDurationMs: 30000,
            });
            assert.ok(Option.isSome(claim));
            assert.equal(claim.value.request.type, "scient-fork.provision");
            assert.equal(claim.value.attemptCount, 1);
          }
          // The accepted membership is frozen even when the source moves on before setup.
          const head = yield* commitTurn(cwd, 3);
          return { command, pending, commits, head };
        }).pipe(
          Effect.provide(
            makeRuntime(gitLayer, { layerServerConfig: configLayer, layerDatabase: database }),
          ),
        ),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const forks = yield* ConversationForkService;
          const receipt = yield* forks.dispatch(saved.command);
          const store = yield* ProjectionStoreV2;
          const ready = yield* store.getThreadProjection(saved.command.newThreadId);
          assert.deepEqual(ready.thread.conversationFork, {
            ...saved.pending.thread.conversationFork!,
            status: "ready",
          });
          assert.deepEqual(ready.messages, saved.pending.messages);
          assert.deepEqual(ready.turnItems, saved.pending.turnItems);
          assert.deepEqual(ready.visibleTurnItems, saved.pending.visibleTurnItems);
          assert.notInclude(
            ready.visibleTurnItems.map((row) => row.item.id),
            TurnItemId.make("lifecycle-q3"),
          );
          assert.ok(ready.thread.worktreePath);
          assert.equal(
            yield* git(ready.thread.worktreePath, ["rev-parse", "HEAD"]),
            saved.commits[0],
          );
          assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), saved.head);
          const rows = yield* settledJobs(saved.command.commandId);
          assert.lengthOf(rows, 1);
          assert.equal(rows[0]?.status, "succeeded");
          assert.equal(rows[0]?.attemptCount, claimedBeforeRestart ? 2 : 1);
          assert.equal((yield* forks.dispatch(saved.command)).sequence, receipt.sequence);
        }).pipe(
          Effect.provide(
            makeRuntime(gitLayer, {
              layerServerConfig: configLayer,
              layerDatabase: database,
              runEffectWorker: true,
              recoverOnStartup: true,
            }),
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "native-fork-restart-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.timeout("30 seconds"),
    ),
  ),
);

// --- Local forks: an imported conversation with attachments. ---

const importRegistry = makeLayer([
  {
    instanceId: PROVIDER_ID,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("A local fork cannot execute a provider"),
  },
]);
const importRuntime = () =>
  nativeImportRuntimeTestLayer(importRegistry, { runEffectWorker: false }).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
const seedImported = Effect.gen(function* () {
  yield* createNativeProjects;
  const config = yield* ServerConfig;
  const { lease } = testLease({
    fixture: importFixture({ turns: 2, attachments: true, reasoning: true, workLog: true }),
    attemptDirectory: NodePath.join(config.stateDir, "conversation-imports", "fork-lifecycle"),
  });
  const { result } = yield* (yield* ConversationImporter).importConversation(lease, {
    destination: destination(),
    principal: principal(),
  });
  const source = yield* (yield* ProjectionStoreV2).getThreadProjection(result.threadId);
  const answer = source.messages.find((message) => message.text === "Answer 2");
  assert.ok(answer);
  const command: ThreadForkCommand = {
    type: "thread.fork",
    commandId: CommandId.make("lifecycle-local-fork"),
    originThreadId: source.thread.id,
    newThreadId: ThreadId.make("lifecycle-local-target"),
    sourceAssistantMessageId: answer.id,
    workspaceMode: "local",
  };
  return { command, source };
});

it.live.each(
  [false, true].map((sourceFilesMissing) => ({
    caseTitle: `a local fork is ready at acceptance with no setup job and shares history and files by reference: source-files-missing=${sourceFilesMissing}`,
    sourceFilesMissing,
  })),
)("$caseTitle", ({ sourceFilesMissing }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { command, source } = yield* seedImported;
      const sourceAttachments = source.messages.flatMap((message) => message.attachments ?? []);
      assert.isAbove(sourceAttachments.length, 0);
      const fs = yield* FileSystem.FileSystem;
      const { attachmentsDir } = yield* ServerConfig;
      const paths = sourceAttachments.map((attachment) => {
        const path = resolveAttachmentPath({ attachmentsDir, attachment });
        assert.ok(path);
        return path;
      });
      // A missing file no longer blocks a fork: it shows what the source shows.
      if (sourceFilesMissing) for (const path of paths) yield* fs.remove(path);
      const forks = yield* ConversationForkService;
      const outbox = yield* EffectOutboxV2;
      // Dispatch settles without any effect worker, so nothing awaited a job.
      const receipt = yield* forks.dispatch(command);
      const target = yield* (yield* ProjectionStoreV2).getThreadProjection(command.newThreadId);
      assert.equal(target.thread.conversationFork?.status, "ready");
      assert.equal(target.thread.conversationFork?.workspaceMode, "local");
      assert.isNull(target.thread.conversationFork?.error);
      assert.isNull(target.thread.deletedAt);
      assert.deepEqual(yield* outbox.listByCommandId(command.commandId), []);
      // The fork was created ready: no later metadata update published readiness.
      assert.deepEqual(yield* publishedStatuses(command.newThreadId), ["ready"]);

      // Visible history is the source's retained items, in order: settled items
      // by reference, and actionable plans as fork-owned copies of them.
      const inherited = target.visibleTurnItems.filter((row) => row.visibility === "inherited");
      assert.isAbove(inherited.length, 0);
      const sourceRows = source.visibleTurnItems.slice(0, inherited.length);
      assert.deepEqual(
        inherited.map((row) => [
          row.item.type,
          row.sourceThreadId === source.thread.id
            ? row.sourceItemId
            : row.item.inheritedFrom?.itemId,
        ]),
        sourceRows.map((row) => [row.item.type, row.item.id]),
      );
      const owned = inherited.filter((row) => row.sourceThreadId !== source.thread.id);
      assert.ok(
        owned.every(
          (row) =>
            row.sourceThreadId === command.newThreadId &&
            (row.item.type === "proposed_plan" || row.item.type === "todo_list"),
        ),
      );
      const answerIndex = source.visibleTurnItems.findIndex(
        (row) =>
          row.item.type === "assistant_message" &&
          row.item.messageId === command.sourceAssistantMessageId,
      );
      assert.isAtLeast(answerIndex, 0);
      assert.isAtLeast(inherited.length, answerIndex + 1);

      // Files are shared: the same attachment ids, mapped to themselves.
      const sourceIds = [...new Set(sourceAttachments.map((attachment) => attachment.id))].sort();
      const copies = target.thread.conversationFork!.attachmentCopies;
      assert.deepEqual(copies.map((copy) => copy.source.id).sort(), sourceIds);
      assert.ok(copies.every((copy) => copy.target.id === copy.source.id));
      assert.deepEqual(
        receipt.forkAttachmentIdMap,
        Object.fromEntries(sourceIds.map((id) => [id, id])),
      );
      const itemAttachmentIds = (rows: typeof inherited) =>
        rows.flatMap((row) =>
          row.item.type === "user_message" ? row.item.attachments.map((a) => a.id) : [],
        );
      assert.deepEqual(itemAttachmentIds(inherited), itemAttachmentIds(sourceRows));
      for (const path of paths) assert.equal(yield* fs.exists(path), !sourceFilesMissing);
      const after = yield* (yield* ProjectionStoreV2).getThreadProjection(source.thread.id);
      assert.deepEqual(after.thread, source.thread);
      assert.deepEqual(after.turnItems, source.turnItems);
    }).pipe(Effect.provide(importRuntime()), Effect.timeout("20 seconds")),
  ),
);
