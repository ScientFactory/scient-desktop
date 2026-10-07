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
const makeRuntime = (workflow = gitLayer) =>
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
    { runEffectWorker: false, configureMcp: false, forkGitWorkflowLayer: workflow },
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
const seed = Effect.fn("Workspace.seed")(function* (running = false) {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "native-fork-git-" });
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
