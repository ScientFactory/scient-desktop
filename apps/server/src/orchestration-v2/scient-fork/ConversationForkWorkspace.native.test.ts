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
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import { TestClock } from "effect/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { CheckpointServiceV2 } from "../CheckpointService.ts";
import { AcpProviderCapabilitiesV2 } from "../Adapters/AcpAdapterV2.ts";
import {
  makeNativeSessionAdapterV2,
  NativeSessionOperationError,
} from "../Adapters/NativeSessionAdapterV2.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as GitManager from "../../git/GitManager.ts";
import * as GitVcs from "../../vcs/GitVcsDriver.ts";
import * as VcsRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import { makeLayer } from "../ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { OrchestrationEffectWorkerV2 } from "../EffectWorker.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { ConversationForkService } from "./ConversationForkService.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../../persistence/Layers/Sqlite.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "fixture" };
const sourceId = ThreadId.make("workspace-source");
const projectId = ProjectId.make("workspace-project");
const vcsLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const gitLayer = GitWorkflow.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      GitVcs.layer,
      VcsRegistry.layer,
      Layer.mock(GitManager.GitManager)({
        invalidateLocalStatus: () => Effect.void,
        invalidateRemoteStatus: () => Effect.void,
        invalidateStatus: () => Effect.void,
      }),
    ),
  ),
  Layer.provide(vcsLayer),
  Layer.provide(NodeServices.layer),
);
const makeRuntime = (
  workflow = gitLayer,
  options: NonNullable<Parameters<typeof makeOrchestratorV2ReplayLayerWithRegistry>[2]> = {},
) =>
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "native-fork-workspace" },
    makeLayer([
      {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: () => Effect.die("A workspace fork must not execute a provider"),
      },
    ]),
    { runEffectWorker: false, configureMcp: false, forkGitWorkflowLayer: workflow, ...options },
  ).pipe(Layer.provideMerge(vcsLayer), Layer.provideMerge(NodeServices.layer));
const layer = makeRuntime();
const git = Effect.fn("Workspace.git")(function* (cwd: string, args: string[]) {
  const result = yield* (yield* VcsProcess.VcsProcess).run({
    operation: "NativeForkWorkspace.test",
    command: "git",
    cwd,
    args,
  });
  assert.equal(result.exitCode, 0);
  return result.stdout.trim();
});
const seed = Effect.fn("Workspace.seed")(function* (running = false, suppliedCwd?: string) {
  const fs = yield* FileSystem.FileSystem;
  const cwd = suppliedCwd ?? (yield* fs.makeTempDirectoryScoped({ prefix: "native-fork-git-" }));
  yield* git(cwd, ["init", "-b", "main"]);
  yield* git(cwd, ["config", "user.name", "Synthetic Scient"]);
  yield* git(cwd, ["config", "user.email", "fixture@example.invalid"]);
  const now = yield* DateTime.now;
  const sink = yield* EventSinkV2;
  yield* sink.commitProjectCommand({
    commandId: CommandId.make("workspace-project"),
    projectId,
    commandType: "project.create",
    acceptedAt: now,
    event: {
      eventId: EventId.make("workspace-project"),
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
        title: "Workspace fork",
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
    commandId: CommandId.make("workspace-source"),
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
  const events: OrchestrationV2DomainEvent[] = [];
  const commits: string[] = [];
  for (const n of [1, 2, 3]) {
    yield* fs.writeFileString(NodePath.join(cwd, "evidence.txt"), `version ${n}`);
    yield* git(cwd, ["add", "evidence.txt"]);
    yield* git(cwd, ["commit", "-m", `Synthetic version ${n}`]);
    const oid = yield* git(cwd, ["rev-parse", "HEAD"]);
    commits.push(oid);
    const ref = CheckpointRef.make(`refs/scient/source/${n}`);
    yield* git(cwd, ["update-ref", ref, oid]);
    const runId = RunId.make(`workspace-run-${n}`);
    const nodeId = NodeId.make(`workspace-root-${n}`);
    const scopeId = CheckpointScopeId.make(`workspace-scope-${n}`);
    const checkpointId = CheckpointId.make(`workspace-checkpoint-${n}`);
    const run: OrchestrationV2Run = {
      id: runId,
      threadId: sourceId,
      ordinal: n,
      providerInstanceId: instanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`workspace-q${n}`),
      rootNodeId: nodeId,
      activeAttemptId: null,
      status: running && n === 3 ? "running" : "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: running && n === 3 ? null : now,
      checkpointId,
      contextHandoffId: null,
    };
    events.push({
      id: EventId.make(`workspace-run-${n}`),
      threadId: sourceId,
      occurredAt: now,
      type: "run.created",
      payload: run,
    });
    events.push({
      id: EventId.make(`workspace-scope-${n}`),
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
    });
    events.push({
      id: EventId.make(`workspace-checkpoint-${n}`),
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
    });
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
        id: TurnItemId.make(`workspace-q${n}`),
        ordinal: n * 2 - 2,
        type: "user_message",
        status: "completed",
        createdBy: "user",
        creationSource: "web",
        inputIntent: "turn_start",
        messageId: MessageId.make(`workspace-q${n}`),
        text: `Question ${n}`,
        attachments: [],
      },
      {
        ...common,
        id: TurnItemId.make(`workspace-a${n}`),
        ordinal: n * 2 - 1,
        type: "assistant_message",
        status: running && n === 3 ? "running" : "completed",
        streaming: running && n === 3,
        messageId: MessageId.make(`workspace-a${n}`),
        text: `Answer ${n}`,
      },
    ];
    for (const item of items) {
      events.push({
        id: EventId.make(`workspace-item-${item.id}`),
        threadId: sourceId,
        occurredAt: now,
        type: "turn-item.updated",
        payload: item,
      });
      if (item.type === "user_message" || item.type === "assistant_message")
        events.push({
          id: EventId.make(`workspace-message-${item.id}`),
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
            streaming: item.type === "assistant_message" && item.streaming,
            createdAt: now,
            updatedAt: now,
          },
        });
    }
  }
  yield* sink.write({ events });
  return { cwd, commits };
});
const pending = Effect.fn("Workspace.pending")(function* (
  suffix: string,
  workspaceMode: "local" | "new-worktree",
  running = false,
) {
  const command = {
    type: "thread.fork" as const,
    commandId: CommandId.make(`workspace-fork-${suffix}`),
    originThreadId: sourceId,
    newThreadId: ThreadId.make(`workspace-fork-${suffix}`),
    workspaceMode,
    ...(running
      ? { sourceRunningRunId: RunId.make("workspace-run-3") }
      : { sourceAssistantMessageId: MessageId.make("workspace-a1") }),
  };
  const pull = yield* Stream.toPull(
    (yield* EventSinkV2).stream({
      threadId: command.newThreadId,
      eventType: "thread.created",
      afterSequence: 0,
    }),
  );
  const waiting = yield* (yield* ConversationForkService)
    .dispatch(command)
    .pipe(Effect.exit, Effect.forkChild);
  yield* pull;
  return {
    command,
    waiting,
    frozen: yield* (yield* ProjectionStoreV2).getThreadProjection(command.newThreadId),
  };
});

for (const mode of ["local", "new-worktree"] as const)
  it.live(
    `native ${mode} fork freezes the selected older checkpoint and never substitutes the later source head`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { cwd, commits } = yield* seed();
          const store = yield* ProjectionStoreV2;
          const source = yield* store.getThreadProjection(sourceId);
          const { command, waiting, frozen } = yield* pending(mode, mode);
          assert.equal(frozen.thread.conversationFork?.checkpointOid, commits[0]);
          assert.equal(
            yield* git(cwd, ["rev-parse", frozen.thread.conversationFork!.checkpointRef!]),
            commits[0],
          );
          yield* git(cwd, ["update-ref", "refs/scient/source/1", commits[1]!]);
          yield* (yield* OrchestrationEffectWorkerV2).drain();
          assert.equal((yield* Fiber.join(waiting))._tag, "Success");
          const ready = yield* store.getThreadProjection(command.newThreadId);
          assert.equal(ready.thread.conversationFork?.status, "ready");
          assert.deepEqual(
            ready.messages.map((message) => message.text),
            ["Question 1", "Answer 1"],
          );
          if (mode === "new-worktree") {
            assert.ok(ready.thread.worktreePath);
            assert.equal(yield* fsRead(ready.thread.worktreePath, "evidence.txt"), "version 1");
            assert.equal(yield* git(ready.thread.worktreePath, ["rev-parse", "HEAD"]), commits[0]);
          } else {
            assert.isNull(ready.thread.worktreePath);
            assert.equal(yield* fsRead(cwd, "evidence.txt"), "version 3");
          }
          assert.deepEqual((yield* store.getThreadProjection(sourceId)).thread, source.thread);
        }).pipe(Effect.provide(layer), Effect.timeout("20 seconds")),
      ),
  );
const fsRead = (cwd: string, file: string) =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(NodePath.join(cwd, file)));

it.live(
  "native running-turn worktree forks freeze dirty and untracked files without changing the source index",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd } = yield* seed(true);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(NodePath.join(cwd, "evidence.txt"), "Live partial work");
        yield* fs.writeFileString(NodePath.join(cwd, "new.txt"), "Untracked live work");
        const index = yield* git(cwd, ["write-tree"]);
        const { command, waiting } = yield* pending("running", "new-worktree", true);
        yield* (yield* OrchestrationEffectWorkerV2).drain();
        assert.equal((yield* Fiber.join(waiting))._tag, "Success");
        const ready = yield* (yield* ProjectionStoreV2).getThreadProjection(command.newThreadId);
        assert.ok(ready.thread.worktreePath);
        assert.equal(yield* fsRead(ready.thread.worktreePath, "evidence.txt"), "Live partial work");
        assert.equal(yield* fsRead(ready.thread.worktreePath, "new.txt"), "Untracked live work");
        assert.equal(yield* git(cwd, ["write-tree"]), index);
        assert.equal(yield* fsRead(cwd, "evidence.txt"), "Live partial work");
      }).pipe(Effect.provide(layer), Effect.timeout("20 seconds")),
    ),
);

for (const clean of [true, false])
  it.live(
    `native worktree provisioning reuses only a verified existing checkout: clean=${clean}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { cwd, commits } = yield* seed();
          const { command, waiting, frozen } = yield* pending(`existing-${clean}`, "new-worktree");
          const fs = yield* FileSystem.FileSystem;
          const path = yield* fs.makeTempDirectoryScoped({ prefix: "native-fork-existing-" });
          const branch = `scient/fork/${command.newThreadId}`;
          yield* git(cwd, [
            "worktree",
            "add",
            "-b",
            branch,
            path,
            frozen.thread.conversationFork!.checkpointRef!,
          ]);
          if (!clean)
            yield* fs.writeFileString(
              NodePath.join(path, "evidence.txt"),
              "Unfinished or edited checkout",
            );
          yield* (yield* OrchestrationEffectWorkerV2).drain();
          const result = yield* Fiber.join(waiting);
          const target = yield* (yield* ProjectionStoreV2).getThreadProjection(command.newThreadId);
          assert.equal(result._tag, clean ? "Success" : "Failure");
          assert.equal(target.thread.conversationFork?.status, clean ? "ready" : "abandoned");
          if (clean) {
            assert.equal(yield* fs.realPath(target.thread.worktreePath!), yield* fs.realPath(path));
            assert.equal(yield* git(path, ["rev-parse", "HEAD"]), commits[0]);
          } else {
            assert.isNotNull(target.thread.deletedAt);
            assert.equal(yield* fsRead(path, "evidence.txt"), "Unfinished or edited checkout");
          }
        }).pipe(Effect.provide(layer), Effect.timeout("20 seconds")),
      ),
  );

it.live("native provisioning abandons a dedicated fork whose frozen checkpoint disappeared", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd } = yield* seed();
      const { command, waiting, frozen } = yield* pending("missing-checkpoint", "new-worktree");
      yield* git(cwd, ["update-ref", "-d", frozen.thread.conversationFork!.checkpointRef!]);
      yield* (yield* OrchestrationEffectWorkerV2).drain();
      assert.equal((yield* Fiber.join(waiting))._tag, "Failure");
      const target = yield* (yield* ProjectionStoreV2).getThreadProjection(command.newThreadId);
      assert.equal(target.thread.conversationFork?.status, "abandoned");
      assert.isNotNull(target.thread.deletedAt);
      assert.isNull(target.thread.worktreePath);
    }).pipe(Effect.provide(layer), Effect.timeout("20 seconds")),
  ),
);

it.live(
  "a removed source worktree can restore its saved checkpoint only into a dedicated native worktree",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, commits } = yield* seed();
        const store = yield* ProjectionStoreV2;
        const sink = yield* EventSinkV2;
        const forks = yield* ConversationForkService;
        const source = yield* store.getThread(sourceId);
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("removed-source-worktree"),
              type: "thread.metadata-updated",
              threadId: sourceId,
              occurredAt: now,
              payload: {
                ...source,
                worktreePath: NodePath.join(cwd, "removed-worktree"),
                updatedAt: now,
              },
            },
          ],
        });
        const options = yield* forks.getOptions({
          originThreadId: sourceId,
          sourceAssistantMessageId: MessageId.make("workspace-a1"),
        });
        assert.equal(options.available, true);
        assert.equal(options.localAvailable, false);
        assert.equal(options.newWorktree, true);
        assert.include(options.reason ?? "", "original worktree");
        const before = yield* sink.latestSequence({});
        assert.equal(
          (yield* Effect.result(
            forks.dispatch({
              type: "thread.fork",
              commandId: CommandId.make("removed-local-refusal"),
              originThreadId: sourceId,
              newThreadId: ThreadId.make("removed-local-refusal"),
              sourceAssistantMessageId: MessageId.make("workspace-a1"),
              workspaceMode: "local",
            }),
          ))._tag,
          "Failure",
        );
        assert.equal(yield* sink.latestSequence({}), before);
        const { command, waiting } = yield* pending("removed-source", "new-worktree");
        yield* (yield* OrchestrationEffectWorkerV2).drain();
        assert.equal((yield* Fiber.join(waiting))._tag, "Success");
        const target = yield* store.getThread(command.newThreadId);
        assert.ok(target.worktreePath);
        assert.notEqual(target.worktreePath, cwd);
        assert.equal(target.conversationFork?.cwd, cwd);
        assert.equal(yield* git(target.worktreePath, ["rev-parse", "HEAD"]), commits[0]);
        assert.equal(yield* fsRead(target.worktreePath, "evidence.txt"), "version 1");
      }).pipe(Effect.provide(layer), Effect.timeout("20 seconds")),
    ),
);

function afterCheckout(after: (path: string) => Effect.Effect<void>) {
  return Layer.effect(
    GitWorkflow.GitWorkflowService,
    Effect.gen(function* () {
      const real = yield* GitWorkflow.GitWorkflowService;
      return {
        ...real,
        createWorktree: (
          input: Parameters<typeof real.createWorktree>[0],
          options?: Parameters<typeof real.createWorktree>[1],
        ) =>
          real
            .createWorktree(input, options)
            .pipe(Effect.tap((result) => after(result.worktree.path))),
      };
    }),
  ).pipe(Layer.provide(gitLayer));
}
it.effect(
  "native fork provisioning permits a four-minute checkout receipt without publishing ready early",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const delayed = afterCheckout(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.sleep("4 minutes")),
            Effect.andThen(Deferred.succeed(release, undefined)),
            Effect.asVoid,
          ),
        );
        yield* Effect.gen(function* () {
          yield* seed();
          const { command, waiting } = yield* pending("slow", "new-worktree");
          const drain = yield* (yield* OrchestrationEffectWorkerV2).drain().pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          assert.equal(
            (yield* (yield* ProjectionStoreV2).getThread(command.newThreadId)).conversationFork
              ?.status,
            "pending",
          );
          yield* TestClock.adjust("4 minutes");
          yield* Deferred.await(release);
          yield* Fiber.join(drain);
          assert.equal((yield* Fiber.join(waiting))._tag, "Success");
          assert.equal(
            (yield* (yield* ProjectionStoreV2).getThread(command.newThreadId)).conversationFork
              ?.status,
            "ready",
          );
        }).pipe(Effect.provide(makeRuntime(delayed)));
      }),
    ),
);

it.live(
  "native provisioning never publishes a new checkout with an unfinished index as ready",
  () => {
    let unfinishedPath: string | undefined;
    const unfinished = afterCheckout((path) =>
      Effect.gen(function* () {
        unfinishedPath = path;
        const fs = yield* FileSystem.FileSystem;
        const link = yield* fs.readFileString(NodePath.join(path, ".git"));
        const gitDir = link.trim().replace(/^gitdir: /, "");
        yield* fs.writeFileString(
          NodePath.join(gitDir, "index.lock"),
          "Controlled unfinished checkout",
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        yield* seed();
        const { command, waiting } = yield* pending("incomplete", "new-worktree");
        yield* (yield* OrchestrationEffectWorkerV2).drain();
        assert.equal((yield* Fiber.join(waiting))._tag, "Failure");
        const target = yield* (yield* ProjectionStoreV2).getThread(command.newThreadId);
        assert.equal(target.conversationFork?.status, "abandoned");
        assert.isNotNull(target.deletedAt);
        assert.isNull(target.worktreePath);
        assert.ok(unfinishedPath);
        assert.equal(yield* fsRead(unfinishedPath, "evidence.txt"), "version 1");
      }).pipe(Effect.provide(makeRuntime(unfinished)), Effect.timeout("20 seconds")),
    );
  },
);

// RunExecutionService must capture the fork's first-send baseline independently
// of the optional fork-time ref. Provider execution here uses the native adapter
// and real EventSink, checkpoint service and Git store, without a live account.
it.live(
  "running local fork first send captures intervening edits and rewind never falls back to HEAD",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstCwd = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "native-fork-first-send-",
        });
        const registry = Layer.effectContext(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const adapter = makeNativeSessionAdapterV2({
              instanceId,
              driver: ProviderDriverKind.make("codex"),
              capabilities: AcpProviderCapabilitiesV2,
              defaultCwd: process.cwd(),
              idAllocator: yield* IdAllocator.IdAllocatorV2,
              mcpSessionInjection: false,
              continuations: { offer: () => Effect.void },
              open: (_input, onUpdate) =>
                Effect.succeed({
                  nativeId: "first-send-native",
                  nativeThreadKnown: true,
                  ensureFresh: () => Effect.void,
                  resume: () => Effect.void,
                  interrupt: Effect.void,
                  respond: () => Effect.void,
                  send: (input) =>
                    Effect.gen(function* () {
                      yield* fs.writeFileString(
                        NodePath.join(firstCwd, "evidence.txt"),
                        "Provider turn edit",
                      );
                      yield* onUpdate({ type: "text", id: "first-send-answer", delta: "Done" });
                      yield* onUpdate({ type: "terminal", status: "completed" });
                    }).pipe(
                      Effect.mapError(
                        (cause) => new NativeSessionOperationError({ detail: cause.message }),
                      ),
                    ),
                }),
            });
            return yield* Layer.build(makeLayer([adapter]));
          }),
        ).pipe(Layer.provide(IdAllocator.layer), Layer.provide(NodeServices.layer));
        const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
          { name: "running-local-first-baseline", runtimePolicyOverride: { cwd: firstCwd } },
          registry,
          { runEffectWorker: true, configureMcp: false, forkGitWorkflowLayer: gitLayer },
        ).pipe(Layer.provideMerge(vcsLayer), Layer.provideMerge(NodeServices.layer));
        yield* Effect.gen(function* () {
          const { cwd } = yield* seed(true, firstCwd);
          const fs = yield* FileSystem.FileSystem;
          const store = yield* ProjectionStoreV2;
          const worker = yield* OrchestrationEffectWorkerV2;
          const { command, waiting, frozen } = yield* pending("first-baseline", "local", true);
          assert.isNull(frozen.thread.conversationFork?.checkpointRef);
          yield* worker.drain();
          assert.equal((yield* Fiber.join(waiting))._tag, "Success");
          yield* fs.writeFileString(
            NodePath.join(cwd, "evidence.txt"),
            "Between fork and first send",
          );
          const orchestrator = yield* OrchestratorV2;
          const cursor = yield* orchestrator.getThreadEventSequence(command.newThreadId);
          const pull = yield* Stream.toPull(
            orchestrator.streamStoredEventsFrom({
              threadId: command.newThreadId,
              afterSequence: cursor,
            }),
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("first-baseline-send"),
            threadId: command.newThreadId,
            messageId: MessageId.make("first-baseline-send"),
            text: "Continue",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          const completed = yield* Stream.concat(
            Stream.succeed(yield* store.getThreadProjection(command.newThreadId)),
            Stream.fromPull(Effect.succeed(pull)).pipe(
              Stream.mapEffect(() => store.getThreadProjection(command.newThreadId)),
            ),
          ).pipe(
            Stream.filter(
              (p) =>
                p.runs[0]?.status === "failed" ||
                (p.runs[0]?.status === "completed" && p.checkpoints.some((c) => c.runId === null)),
            ),
            Stream.runHead,
            Effect.timeout("10 seconds"),
          );
          assert.ok(Option.isSome(completed));
          assert.equal(completed.value.runs[0]?.status, "completed");
          const baseline = completed.value.checkpoints.find((c) => c.runId === null)!;
          assert.equal(baseline.status, "ready");
          const scope = completed.value.checkpointScopes.find(
            (scope) => scope.id === baseline.scopeId,
          )!;
          assert.equal(
            yield* git(cwd, ["show", `${baseline.ref}:evidence.txt`]),
            "Between fork and first send",
          );
          assert.equal(yield* fsRead(cwd, "evidence.txt"), "Provider turn edit");
          // The user-facing command still refuses a file restore into a shared folder.
          const rejected = yield* orchestrator
            .dispatch({
              type: "checkpoint.rollback",
              commandId: CommandId.make("first-baseline-shared-refusal"),
              threadId: command.newThreadId,
              checkpointId: baseline.id,
              scopeId: baseline.scopeId,
              restoreFiles: true,
            })
            .pipe(Effect.result);
          assert.equal(rejected._tag, "Failure");
          assert.equal(yield* fsRead(cwd, "evidence.txt"), "Provider turn edit");
          // Qualify the actual file-store semantics separately from the ownership policy.
          const checkpoints = yield* CheckpointServiceV2;
          yield* checkpoints.restore({ scope, checkpoint: baseline });
          assert.equal(yield* fsRead(cwd, "evidence.txt"), "Between fork and first send");
          yield* git(cwd, ["update-ref", "-d", baseline.ref]);
          yield* fs.writeFileString(
            NodePath.join(cwd, "evidence.txt"),
            "Preserve after missing ref",
          );
          const absent = yield* checkpoints.materializeBaselineCheckpoint({
            scope,
            ordinalWithinScope: 0,
          });
          assert.equal(absent.status, "missing");
          assert.equal(
            (yield* checkpoints.restore({ scope, checkpoint: absent }).pipe(Effect.result))._tag,
            "Failure",
          );
          assert.equal(
            (yield* checkpoints.restore({ scope, checkpoint: baseline }).pipe(Effect.result))._tag,
            "Failure",
          );
          assert.equal(yield* fsRead(cwd, "evidence.txt"), "Preserve after missing ref");
        }).pipe(Effect.provide(runtime));
      }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("30 seconds")),
    ),
);

it.live("late SQL admission failure releases only the just-published snapshot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const databaseLayer = SqlitePersistenceMemory;
      yield* Effect.gen(function* () {
        const { cwd } = yield* seed(true);
        const sql = yield* SqlClient.SqlClient;
        const destination = ThreadId.make("late-rejected-fork");
        yield* sql.unsafe(`CREATE TRIGGER reject_fork BEFORE INSERT ON orchestration_v2_projection_threads
        WHEN NEW.thread_id = 'late-rejected-fork' BEGIN SELECT RAISE(ABORT, 'injected admission failure'); END`);
        const result = yield* Effect.result(
          (yield* ConversationForkService).dispatch({
            type: "thread.fork",
            commandId: CommandId.make("late-rejected-fork"),
            originThreadId: sourceId,
            newThreadId: destination,
            workspaceMode: "new-worktree",
            sourceRunningRunId: RunId.make("workspace-run-3"),
          }),
        );
        assert.equal(result._tag, "Failure");
        assert.equal(
          yield* git(cwd, [
            "for-each-ref",
            "--format=%(refname)",
            checkpointRefForThreadTurn(destination, 0),
          ]),
          "",
        );
        assert.equal((yield* sql`SELECT * FROM scient_fork_checkpoint_ownership`).length, 0);
        assert.equal(
          (yield* sql`SELECT * FROM orchestration_v2_events WHERE thread_id = ${destination}`)
            .length,
          0,
        );
        assert.equal(
          (yield* sql`SELECT * FROM orchestration_command_receipts WHERE command_id = 'late-rejected-fork'`)
            .length,
          0,
        );
        assert.equal(yield* fsRead(cwd, "evidence.txt"), "version 3");
      }).pipe(
        Effect.provide(
          makeRuntime(gitLayer, { databaseLayer }).pipe(Layer.provideMerge(databaseLayer)),
        ),
      );
    }).pipe(Effect.timeout("25 seconds")),
  ),
);

it.live("a paused running-worktree snapshot does not block an unrelated local fork", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const runtime = makeRuntime(gitLayer, {
        decorateForkCheckpointBaseline: (baseline) => ({
          ...baseline,
          capture: (input) =>
            Effect.andThen(
              Deferred.succeed(entered, undefined),
              Effect.andThen(Deferred.await(release), baseline.capture(input)),
            ),
        }),
      });
      yield* Effect.gen(function* () {
        yield* seed(true);
        const { command, waiting } = yield* pending("independent-source", "local");
        yield* (yield* OrchestrationEffectWorkerV2).drain();
        assert.equal((yield* Fiber.join(waiting))._tag, "Success");
        const source = yield* (yield* ProjectionStoreV2).getThreadProjection(command.newThreadId);
        const assistant = source.messages.find((item) => item.role === "assistant")!;
        const slowCreated = yield* Stream.toPull(
          (yield* EventSinkV2).stream({
            threadId: ThreadId.make("paused-workspace"),
            eventType: "thread.created",
            afterSequence: 0,
          }),
        );
        const slow = yield* (yield* ConversationForkService)
          .dispatch({
            type: "thread.fork",
            commandId: CommandId.make("paused-workspace"),
            originThreadId: sourceId,
            newThreadId: ThreadId.make("paused-workspace"),
            workspaceMode: "new-worktree",
            sourceRunningRunId: RunId.make("workspace-run-3"),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"));
        const target = ThreadId.make("unrelated-local");
        const pull = yield* Stream.toPull(
          (yield* EventSinkV2).stream({
            threadId: target,
            eventType: "thread.created",
            afterSequence: 0,
          }),
        );
        const fast = yield* (yield* ConversationForkService)
          .dispatch({
            type: "thread.fork",
            commandId: CommandId.make("unrelated-local"),
            originThreadId: source.thread.id,
            newThreadId: target,
            workspaceMode: "local",
            sourceAssistantMessageId: assistant.id,
          })
          .pipe(Effect.forkChild);
        yield* pull.pipe(Effect.timeout("5 seconds"));
        assert.equal(
          (yield* (yield* ProjectionStoreV2).getThread(target)).conversationFork?.status,
          "pending",
        );
        yield* Deferred.succeed(release, undefined);
        yield* slowCreated.pipe(Effect.timeout("5 seconds"));
        yield* (yield* OrchestrationEffectWorkerV2).drain();
        yield* Fiber.join(fast);
        yield* Fiber.join(slow);
        const store = yield* ProjectionStoreV2;
        assert.notEqual(
          (yield* store.getThread(target)).title,
          (yield* store.getThread(ThreadId.make("paused-workspace"))).title,
        );
        // Opposite lock directions must settle without changing either existing thread.
        const before = yield* store.getThread(sourceId);
        const reverse = yield* Effect.all(
          [
            (yield* ConversationForkService)
              .dispatch({
                type: "thread.fork",
                commandId: CommandId.make("direction-a"),
                originThreadId: sourceId,
                newThreadId: source.thread.id,
                workspaceMode: "local",
                sourceAssistantMessageId: MessageId.make("workspace-a1"),
              })
              .pipe(Effect.result),
            (yield* ConversationForkService)
              .dispatch({
                type: "thread.fork",
                commandId: CommandId.make("direction-b"),
                originThreadId: source.thread.id,
                newThreadId: sourceId,
                workspaceMode: "local",
                sourceAssistantMessageId: assistant.id,
              })
              .pipe(Effect.result),
          ],
          { concurrency: 2 },
        );
        assert.deepEqual(
          reverse.map((result) => result._tag),
          ["Failure", "Failure"],
        );
        assert.deepEqual(yield* store.getThread(sourceId), before);
      }).pipe(Effect.provide(runtime), Effect.ensuring(Deferred.succeed(release, undefined)));
    }).pipe(Effect.timeout("25 seconds")),
  ),
);

it.live(
  "file-backed recovery keeps accepted snapshots and compare-deletes rejected attempts across restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* fs.makeTempDirectoryScoped({ prefix: "fork-ownership-restart-" });
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "fork-ownership-git-" });
        const databaseLayer = makeSqlitePersistenceLive(
          NodePath.join(profile, "statev2.sqlite"),
        ).pipe(Layer.provide(NodeServices.layer));
        const runtime = makeRuntime(gitLayer, { databaseLayer }).pipe(
          Layer.provideMerge(databaseLayer),
        );
        const orphan = "refs/t3/checkpoints/orphan/turn/0-attempt";
        const changed = "refs/t3/checkpoints/changed/turn/0-attempt";
        const uncertain = "refs/t3/checkpoints/accepted-uncertain/turn/0-attempt";
        let acceptedRef = "";
        let acceptedOid = "";
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { commits } = yield* seed(false, cwd);
            const { command, waiting, frozen } = yield* pending("accepted-restart", "local");
            yield* (yield* OrchestrationEffectWorkerV2).drain();
            assert.equal((yield* Fiber.join(waiting))._tag, "Success");
            acceptedRef = frozen.thread.conversationFork!.checkpointRef!;
            acceptedOid = frozen.thread.conversationFork!.checkpointOid!;
            const sql = yield* SqlClient.SqlClient;
            for (const row of [
              {
                attempt_id: "accepted",
                command_id: command.commandId,
                target_thread_id: command.newThreadId,
                checkpoint_ref: acceptedRef,
                checkpoint_oid: acceptedOid,
              },
              {
                attempt_id: "accepted-uncertain",
                command_id: command.commandId,
                target_thread_id: command.newThreadId,
                checkpoint_ref: uncertain,
                checkpoint_oid: acceptedOid,
              },
              {
                attempt_id: "orphan",
                command_id: "orphan-command",
                target_thread_id: "orphan",
                checkpoint_ref: orphan,
                checkpoint_oid: commits[0]!,
              },
              {
                attempt_id: "changed",
                command_id: "changed-command",
                target_thread_id: "changed",
                checkpoint_ref: changed,
                checkpoint_oid: commits[0]!,
              },
              {
                attempt_id: "unpublished",
                command_id: "unpublished-command",
                target_thread_id: "unpublished",
                checkpoint_ref: "refs/t3/checkpoints/unpublished/turn/0-attempt",
                checkpoint_oid: null,
              },
            ])
              yield* sql`INSERT INTO scient_fork_checkpoint_ownership ${sql.insert({ ...row, cwd, owner_pid: process.pid })}`;
            yield* git(cwd, ["update-ref", orphan, commits[0]!]);
            yield* git(cwd, ["update-ref", uncertain, acceptedOid]);
            yield* git(cwd, ["update-ref", changed, commits[2]!]);
          }).pipe(Effect.provide(runtime)),
        );
        // Closing the first scoped runtime closes SQLite. A fresh service construction
        // must reconcile the persisted journal before accepting another command.
        for (let repeat = 0; repeat < 2; repeat++)
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* ConversationForkService;
              const sql = yield* SqlClient.SqlClient;
              const rows = yield* sql<{
                attempt_id: string;
              }>`SELECT attempt_id FROM scient_fork_checkpoint_ownership ORDER BY attempt_id`;
              assert.deepEqual(
                rows.map((row) => row.attempt_id),
                ["accepted-uncertain", "changed"],
              );
              assert.equal(yield* git(cwd, ["rev-parse", acceptedRef]), acceptedOid);
              assert.equal(yield* git(cwd, ["rev-parse", uncertain]), acceptedOid);
              assert.equal(yield* git(cwd, ["for-each-ref", "--format=%(refname)", orphan]), "");
              assert.equal(
                yield* git(cwd, ["rev-parse", changed]),
                yield* git(cwd, ["rev-parse", "HEAD"]),
              );
            }).pipe(Effect.provide(runtime)),
          );
      }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("30 seconds")),
    ),
);
