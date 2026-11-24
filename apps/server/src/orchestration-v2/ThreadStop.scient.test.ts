import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-stop-scient" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

/**
 * The events of a real delegation, recorded on their own database. Replayed into the
 * projection alone, they start none of the event reactions that would settle the child
 * before the parent's Stop reaches it.
 */
const recordDelegation = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const events = yield* EventStore.EventStoreV2;
    const parentThreadId = ThreadId.make(`thread:idle-settle-parent:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${parentThreadId}`),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:thread-stop-scient"),
      title: parentThreadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${parentThreadId}`),
      threadId: parentThreadId,
      messageId: MessageId.make(`message:${parentThreadId}`),
      text: "parent",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${name}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: `task ${name}`,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const recorded = yield* Stream.runCollect(events.read());
    return { parentThreadId, events: Array.from(recorded, (stored) => stored.event) };
  }).pipe(Effect.provide(layerTest));

/**
 * A child whose Stop committed its interrupted task row and result transfer, the state a
 * parent's Stop finds idle. With `questionPending`, the separate question dismissal that
 * follows that commit did not happen.
 */
const stoppedChild = (name: string, questionPending: boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { parentThreadId, events } = yield* recordDelegation(name);
    for (const event of events) yield* projections.apply(event);
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const parentRun = parent.runs.at(-1)!;
    const task = parent.subagents[0]!;
    const childThreadId = task.childThreadId!;
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    const childRun = child.runs[0]!;
    const taskItem = parent.turnItems.find((item) => item.type === "subagent")!;
    const taskNode = parent.nodes.find((node) => node.id === task.id)!;
    const now = yield* DateTime.now;
    let sequence = 0;
    const apply = (event: Omit<OrchestrationV2DomainEvent, "id">) =>
      projections.apply({
        ...event,
        id: EventId.make(`event:idle-settle:${name}:${sequence++}`),
      } as OrchestrationV2DomainEvent);
    yield* apply({
      type: "run.updated",
      threadId: childThreadId,
      occurredAt: now,
      payload: { ...childRun, status: "interrupted", startedAt: now, completedAt: now },
    });
    yield* apply({
      type: "subagent.updated",
      threadId: parentThreadId,
      occurredAt: now,
      payload: {
        ...task,
        status: "interrupted",
        result: "Stopped.",
        completedAt: now,
        completionDelivery: { state: "disposed", observedByRunId: null },
      },
    });
    yield* apply({
      type: "node.updated",
      threadId: parentThreadId,
      occurredAt: now,
      payload: { ...taskNode, status: "interrupted", completedAt: now },
    });
    yield* apply({
      type: "turn-item.updated",
      threadId: parentThreadId,
      occurredAt: now,
      payload: { ...taskItem, status: "interrupted", completedAt: now },
    });
    yield* apply({
      type: "context-transfer.created",
      threadId: parentThreadId,
      occurredAt: now,
      payload: {
        ...child.contextTransfers[0]!,
        id: ContextTransferId.make(`transfer:idle-settle-result:${name}`),
        type: "subagent_result",
        sourceThreadId: childThreadId,
        targetThreadId: parentThreadId,
        sourcePoint: { threadId: childThreadId, runId: childRun.id },
        targetRunId: parentRun.id,
      },
    });
    const requestId = RuntimeRequestId.make(`request:idle-settle:${name}`);
    yield* apply({
      type: "runtime-request.updated",
      threadId: childThreadId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId: childRun.rootNodeId!,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: questionPending ? "pending" : "cancelled",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: questionPending ? null : now,
      },
    });
    yield* apply({
      type: "run.updated",
      threadId: parentThreadId,
      occurredAt: now,
      payload: { ...parentRun, status: "completed", completedAt: now },
    });
    return { parentThreadId, childThreadId, requestId };
  });

const childStopState = (childThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(childThreadId);
    return {
      interruptRequests: projection.turnItems.filter(
        (item) => item.type === "run_interrupt_request",
      ).length,
      stopRequested: (yield* orchestrator.getThreadShell(childThreadId))?.latestRunStopRequested,
      runs: projection.runs.map((run) => run.status),
      requests: projection.runtimeRequests.map((request) => request.status),
    };
  });

it.effect(
  "a parent's Stop dismisses a stopped idle child's pending question without stopping the child",
  () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const { parentThreadId, childThreadId } = yield* stoppedChild("partial", true);
      assert.deepEqual((yield* childStopState(childThreadId)).requests, ["pending"]);

      yield* threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("stop-idle-settle:partial"),
      });

      const after = yield* childStopState(childThreadId);
      assert.equal(after.interruptRequests, 0);
      assert.isFalse(after.stopRequested);
      assert.deepEqual(after.runs, ["interrupted"]);
      assert.notInclude(after.requests, "pending");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a parent's Stop leaves a fully settled idle child without a Stop or any event", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const events = yield* EventStore.EventStoreV2;
    const { parentThreadId, childThreadId } = yield* stoppedChild("settled", false);
    const before = yield* childStopState(childThreadId);
    const sequenceBefore = yield* events.latestSequence();

    yield* threads.stopDelegatedTasks({
      threadId: parentThreadId,
      commandId: CommandId.make("stop-idle-settle:settled"),
    });

    assert.equal(yield* events.latestSequence(), sequenceBefore);
    assert.deepEqual(yield* childStopState(childThreadId), before);
    assert.equal(before.interruptRequests, 0);
    assert.isFalse(before.stopRequested);
  }).pipe(Effect.provide(layerTest)),
);
