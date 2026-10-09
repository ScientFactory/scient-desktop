import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderEventRoutingState, routeProviderEvent } from "../RunExecutionService.ts";
import * as ProviderEventIngestor from "../ProviderEventIngestor.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import { layerFromAdapters as makeLayer } from "../ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeReplayLayer } from "../testkit/ProviderReplayHarness.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { ConversationForkService } from "./ConversationForkService.ts";
import * as ThreadCommandExecutor from "../ThreadCommandExecutor.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { ServerConfig } from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "fixture" };

let forkCommitGate:
  | {
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    }
  | undefined;

const layer = makeReplayLayer(
  { name: "conversation-fork-pi-rewind-race" },
  makeLayer([
    {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("A history fork must not execute the provider"),
    },
  ]),
  {
    decorateEventSink: (sink) => ({
      ...sink,
      commitCommand: (input) => {
        const gate = forkCommitGate;
        if (
          gate === undefined ||
          input.commandType !== "thread.conversation.fork" ||
          input.forkHistory === undefined
        )
          return sink.commitCommand(input);
        forkCommitGate = undefined;
        return Effect.gen(function* () {
          // Planning is complete, but the real canonical EventSink transaction
          // has not accepted the fork yet.
          yield* Deferred.succeed(gate.entered, undefined);
          yield* Deferred.await(gate.release);
          return yield* sink.commitCommand(input);
        });
      },
    }),
  },
).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
  // The ingestor layer is composed inside the test so it can use the same
  // allocator and per-thread command lock as the replay runtime.
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(ThreadCommandExecutor.layer),
);

it.effect(
  "retains the selected fork prefix when a valid retained-turn rewind commits after planning",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const sink = yield* EventSinkV2;
      const store = yield* ProjectionStoreV2;
      const forks = yield* ConversationForkService;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2.pipe(
        Effect.provide(ProviderEventIngestor.layer),
      );
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-fork-rewind-" });
      const actualProjectId = ProjectId.make("project:pi-fork-rewind");
      const threadId = ThreadId.make("thread:pi-fork-rewind-source");
      const targetThreadId = ThreadId.make("thread:pi-fork-rewind-target");
      const providerSessionId = ProviderSessionId.make("provider-session:pi-fork-rewind");
      const providerThreadId = ProviderThreadId.make("provider-thread:pi-fork-rewind");
      const selectedRunId = RunId.make("run:pi-fork-rewind-selected");
      const reportingRunId = RunId.make("run:pi-fork-rewind-reporting");
      const selectedAttemptId = RunAttemptId.make("attempt:pi-fork-rewind-selected");
      const reportingAttemptId = RunAttemptId.make("attempt:pi-fork-rewind-reporting");
      const selectedTurnId = ProviderTurnId.make("provider-turn:pi-fork-rewind-selected");
      const reportingTurnId = ProviderTurnId.make("provider-turn:pi-fork-rewind-reporting");
      const selectedNodeId = NodeId.make("node:pi-fork-rewind-selected");
      const reportingNodeId = NodeId.make("node:pi-fork-rewind-reporting");
      const selectedMessageId = MessageId.make("message:pi-fork-rewind-selected");
      const selectedItemId = TurnItemId.make("item:pi-fork-rewind-selected");
      const now = yield* DateTime.now;
      const { attachmentsDir } = yield* ServerConfig;
      yield* fs.makeDirectory(attachmentsDir, { recursive: true });

      yield* sink.commitProjectCommand({
        commandId: CommandId.make("pi-fork-rewind-project-create"),
        projectId: actualProjectId,
        commandType: "project.create",
        acceptedAt: now,
        event: {
          eventId: EventId.make("pi-fork-rewind-project-created"),
          type: "project.created",
          aggregateKind: "project",
          aggregateId: actualProjectId,
          occurredAt: DateTime.formatIso(now),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId: actualProjectId,
            title: "Native rewind fork",
            workspaceRoot: cwd,
            scripts: [],
            createdAt: DateTime.formatIso(now),
            updatedAt: DateTime.formatIso(now),
            defaultModelSelection: modelSelection,
          },
        },
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("pi-fork-rewind-thread-create"),
        threadId,
        projectId: actualProjectId,
        title: "Native rewind source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });

      const scopeId = CheckpointScopeId.make("checkpoint-scope:pi-fork-rewind");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        nativeConversationHeadRef: {
          driver,
          nativeId: "native-reporting-turn",
          strength: "strong",
        },
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const makeRun = (
        id: RunId,
        ordinal: number,
        attemptId: RunAttemptId,
        nodeId: NodeId,
      ): OrchestrationV2Run => ({
        id,
        threadId,
        ordinal,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message:pi-fork-rewind-user-${ordinal}`),
        rootNodeId: nodeId,
        activeAttemptId: attemptId,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      });
      const runs = [
        makeRun(selectedRunId, 1, selectedAttemptId, selectedNodeId),
        makeRun(reportingRunId, 2, reportingAttemptId, reportingNodeId),
      ];
      const makeAttempt = (
        run: OrchestrationV2Run,
        attemptId: RunAttemptId,
        turnId: ProviderTurnId,
        nodeId: NodeId,
      ): OrchestrationV2RunAttempt => ({
        id: attemptId,
        runId: run.id,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId: instanceId,
        providerThreadId,
        providerTurnId: turnId,
        reason: "initial",
        status: "completed",
        startedAt: now,
        completedAt: now,
      });
      const attempts = [
        makeAttempt(runs[0]!, selectedAttemptId, selectedTurnId, selectedNodeId),
        makeAttempt(runs[1]!, reportingAttemptId, reportingTurnId, reportingNodeId),
      ];
      const makeProviderTurn = (
        ordinal: number,
        attemptId: RunAttemptId,
        turnId: ProviderTurnId,
        nodeId: NodeId,
        nativeTurnId: string,
      ): OrchestrationV2ProviderTurn => ({
        id: turnId,
        providerThreadId,
        nodeId,
        runAttemptId: attemptId,
        nativeTurnRef: { driver, nativeId: nativeTurnId, strength: "strong" },
        ordinal,
        status: "completed",
        startedAt: now,
        completedAt: now,
      });
      const providerTurns = [
        makeProviderTurn(1, selectedAttemptId, selectedTurnId, selectedNodeId, "native-old-turn"),
        makeProviderTurn(
          2,
          reportingAttemptId,
          reportingTurnId,
          reportingNodeId,
          "native-current-turn",
        ),
      ];
      const makeNode = (
        run: OrchestrationV2Run,
        turnId: ProviderTurnId,
        nodeId: NodeId,
      ): OrchestrationV2ExecutionNode => ({
        id: nodeId,
        threadId,
        runId: run.id,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "root_turn",
        status: "completed",
        countsForRun: true,
        providerThreadId,
        providerTurnId: turnId,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: scopeId,
        startedAt: now,
        completedAt: now,
      });
      const nodes = [
        makeNode(runs[0]!, selectedTurnId, selectedNodeId),
        makeNode(runs[1]!, reportingTurnId, reportingNodeId),
      ];
      const selectedItem = {
        id: selectedItemId,
        threadId,
        runId: selectedRunId,
        ordinal: 0,
        nodeId: selectedNodeId,
        providerThreadId,
        providerTurnId: selectedTurnId,
        nativeItemRef: null,
        parentItemId: null,
        type: "assistant_message" as const,
        status: "completed" as const,
        title: null,
        messageId: selectedMessageId,
        text: "Response before the provider rewound its native branch",
        streaming: false,
        startedAt: now,
        completedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      const events: OrchestrationV2DomainEvent[] = [
        {
          id: EventId.make("pi-fork-rewind-provider-thread"),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: providerThread,
        },
        ...runs.map((payload): OrchestrationV2DomainEvent => ({
          id: EventId.make(`pi-fork-rewind-run:${payload.id}`),
          type: "run.created",
          threadId,
          occurredAt: now,
          payload,
        })),
        ...attempts.map((payload): OrchestrationV2DomainEvent => ({
          id: EventId.make(`pi-fork-rewind-attempt:${payload.id}`),
          type: "run-attempt.created",
          threadId,
          occurredAt: now,
          payload,
        })),
        ...providerTurns.map((payload): OrchestrationV2DomainEvent => ({
          id: EventId.make(`pi-fork-rewind-turn:${payload.id}`),
          type: "provider-turn.updated",
          threadId,
          occurredAt: now,
          payload,
        })),
        ...nodes.map((payload): OrchestrationV2DomainEvent => ({
          id: EventId.make(`pi-fork-rewind-node:${payload.id}`),
          type: "node.updated",
          threadId,
          occurredAt: now,
          payload,
        })),
        {
          id: EventId.make(`pi-fork-rewind-item:${selectedItemId}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: selectedItem,
        },
        {
          id: EventId.make(`pi-fork-rewind-message:${selectedMessageId}`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: selectedMessageId,
            threadId,
            runId: selectedRunId,
            nodeId: selectedNodeId,
            role: "assistant",
            createdBy: "agent",
            creationSource: "web",
            text: selectedItem.text,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      ];
      yield* sink.write({ events });

      const command = {
        type: "thread.fork" as const,
        commandId: CommandId.make("pi-fork-rewind-command"),
        originThreadId: threadId,
        newThreadId: targetThreadId,
        sourceAssistantMessageId: selectedMessageId,
        workspaceMode: "local" as const,
      };
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      forkCommitGate = { entered, release };
      const forkFiber = yield* forks.dispatch(command).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);

      // This follows the production acceptance path: the live run router first
      // accepts a matching provider-thread update after turn terminal, then
      // the ingestor's provider-thread/run/attempt/ordinal owner fence commits
      // the native retained-turn roster and rollback events.
      const identity = {
        driver,
        providerInstanceId: instanceId,
        threadId,
        runId: reportingRunId,
        attemptId: reportingAttemptId,
        providerThreadId,
      };
      let routed = makeProviderEventRoutingState({
        identity,
        providerTurnId: reportingTurnId,
      });
      const [terminalAccepted, afterTerminal] = routeProviderEvent(
        {
          type: "turn.terminal",
          driver,
          providerThreadId,
          providerTurnId: reportingTurnId,
          runOrdinal: 2,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        },
        identity,
        routed,
      );
      assert.isTrue(terminalAccepted);
      routed = afterTerminal;
      const rewindEvent = {
        type: "provider_thread.updated" as const,
        driver,
        providerThread: {
          ...providerThread,
          nativeConversationHeadRef: {
            driver,
            nativeId: "native-current-turn",
            strength: "strong" as const,
          },
          updatedAt: yield* DateTime.now,
        },
        retainedNativeTurnIds: ["native-current-turn"],
      };
      const [rewindAccepted] = routeProviderEvent(rewindEvent, identity, routed);
      assert.isTrue(rewindAccepted);
      const rewritten = yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: instanceId,
        threadId,
        runId: reportingRunId,
        event: rewindEvent,
        writeIfProviderThreadOwner: {
          providerThreadId,
          runId: reportingRunId,
          activeAttemptId: reportingAttemptId,
          expectedLastRunOrdinal: 2,
        },
      });
      assert.isAtLeast(rewritten.length, 2, "the owner-fenced provider rewind must be committed");

      const sourceAfterRewind = yield* store.getThreadProjection(threadId);
      assert.equal(
        sourceAfterRewind.runs.find((run) => run.id === selectedRunId)?.status,
        "rolled_back",
      );
      assert.isFalse(
        sourceAfterRewind.visibleTurnItems.some((row) => row.item.id === selectedItemId),
        "the rewind hides the selected run from the live source timeline",
      );

      yield* Deferred.succeed(release, undefined);
      const receipt = yield* Fiber.join(forkFiber);
      assert.ok(receipt.sequence > 0);
      const forked = yield* store.getThreadProjection(targetThreadId);
      assert.deepEqual(
        forked.messages.map((message) => message.text),
        ["Response before the provider rewound its native branch"],
        "the fork must retain the visible prefix captured before the rewind",
      );
      assert.deepEqual(
        forked.visibleTurnItems.map((row) => row.item.type),
        ["assistant_message", "fork"],
      );
      const inherited = forked.visibleTurnItems[0];
      assert.ok(inherited?.item.type === "assistant_message");
      assert.equal(inherited.visibility, "inherited");
      assert.equal(inherited.item.messageId, selectedMessageId);
    }).pipe(
      Effect.provide(layer),
      Effect.timeout("15 seconds"),
      Effect.ensuring(
        Effect.gen(function* () {
          const gate = forkCommitGate;
          forkCommitGate = undefined;
          if (gate !== undefined) yield* Deferred.succeed(gate.release, undefined);
        }),
      ),
    ),
);
