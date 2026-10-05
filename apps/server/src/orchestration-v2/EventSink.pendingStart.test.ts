import { assert, it } from "@effect/vitest";
import {
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
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { CheckpointScopeId, TurnItemId } from "@t3tools/contracts";

const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const testLayer = Layer.mergeAll(
  EventSink.layer,
  ProjectionMaintenance.layer,
  EffectOutbox.layer,
).pipe(Layer.provideMerge(stores));
const instanceId = ProviderInstanceId.make("controlled-plan-owner");
const driver = ProviderDriverKind.make("omp");
const seed = Effect.fnUntraced(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("plan-consumer");
  const runId = RunId.make("plan-consumer:run");
  const attemptId = RunAttemptId.make("plan-consumer:attempt");
  const rootId = NodeId.make("plan-consumer:root");
  const providerThreadId = ProviderThreadId.make("plan-consumer:native");
  const projectId = ProjectId.make("plan-consumption-project");
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId,
    title: "Consumer",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "controlled-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThreadId,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 3,
    providerInstanceId: instanceId,
    modelSelection: thread.modelSelection,
    providerThreadId,
    userMessageId: MessageId.make("plan-consumer:message"),
    rootNodeId: rootId,
    activeAttemptId: attemptId,
    status: "running",
    queuePosition: 1,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const attempt: OrchestrationV2RunAttempt = {
    id: attemptId,
    runId,
    attemptOrdinal: 1,
    rootNodeId: rootId,
    providerInstanceId: instanceId,
    providerThreadId,
    providerTurnId: null,
    reason: "initial",
    status: "running",
    startedAt: now,
    completedAt: null,
  };
  const root: OrchestrationV2ExecutionNode = {
    id: rootId,
    threadId,
    runId,
    parentNodeId: null,
    rootNodeId: rootId,
    kind: "root_turn",
    status: "running",
    countsForRun: true,
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: CheckpointScopeId.make("exact-captured-scope"),
    startedAt: now,
    completedAt: null,
  };
  const providerThread: OrchestrationV2ProviderThread = {
    id: providerThreadId,
    driver,
    providerInstanceId: instanceId,
    providerSessionId: ProviderSessionId.make("plan-consumer:session"),
    appThreadId: threadId,
    ownerNodeId: rootId,
    nativeThreadRef: { driver, nativeId: "owned-native-thread", strength: "strong" },
    nativeConversationHeadRef: null,
    status: "active",
    firstRunOrdinal: 1,
    lastRunOrdinal: 3,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    createdAt: now,
    updatedAt: now,
  };
  const turn: OrchestrationV2ProviderTurn = {
    id: ProviderTurnId.make("plan-consumer:turn"),
    providerThreadId,
    nodeId: rootId,
    runAttemptId: attemptId,
    nativeTurnRef: { driver, nativeId: "actual-native-turn", strength: "strong" },
    ordinal: 1,
    status: "running",
    nativeAcceptance: "accepted",
    acceptedAt: now,
    startedAt: now,
    completedAt: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make("consumer:create"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make("consumer:native"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      },
      {
        id: EventId.make("consumer:run"),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: run,
      },
      {
        id: EventId.make("consumer:attempt"),
        type: "run-attempt.created",
        threadId,
        occurredAt: now,
        payload: attempt,
      },
      {
        id: EventId.make("consumer:root"),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: root,
      },
    ],
  });
  const receipt: Extract<OrchestrationV2DomainEvent, { type: "provider-turn.updated" }> = {
    id: EventId.make("native-acceptance"),
    type: "provider-turn.updated",
    threadId,
    runId,
    nodeId: rootId,
    driver,
    providerInstanceId: instanceId,
    occurredAt: now,
    payload: turn,
  };
  const requestId = TurnItemId.make("pending-start:stop-request");
  const resultId = TurnItemId.make("pending-start:stop-result");
  yield* sink.write({
    events: [
      {
        id: EventId.make("pending-start:stop"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootId,
        occurredAt: now,
        payload: {
          id: requestId,
          type: "run_interrupt_request",
          threadId,
          runId,
          nodeId: rootId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: "Stop",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          message: "Stop requested",
        },
      },
    ],
  });
  const owner: EventSink.PendingStartOwner = {
    threadId,
    runId,
    activeAttemptId: attemptId,
    rootNodeId: rootId,
    checkpointScopeId: root.checkpointScopeId,
    runOrdinal: run.ordinal,
    providerThread,
    interruptRequestId: requestId,
    interruptResultId: resultId,
  };
  return { sink, thread, run, attempt, root, providerThread, receipt, now, owner };
});

for (const change of [
  "none",
  "captured-weak",
  "captured-null",
  "retained-exact-ordinal",
  "retained-foreign-ordinal",
  "retained-running-owner",
  "native-receipt-pending",
  "native-receipt-accepted",
  "native-receipt-unknown",
  "session",
  "native-id",
  "native-strength",
  "native-null",
  "root",
  "scope",
  "attempt",
  "active-thread",
  "archived",
  "deleted",
  "foreign-older-ordinal",
  "greater-ordinal",
  "paired-stop",
] as const) {
  it.effect(`pre-receipt Stop cancellation fences real SQL owner: ${change}`, () =>
    Effect.gen(function* () {
      const f = yield* seed();
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      if (change === "captured-weak" || change === "captured-null") {
        const thread = {
          ...f.providerThread,
          nativeThreadRef:
            change === "captured-null"
              ? null
              : { ...f.providerThread.nativeThreadRef!, strength: "weak" as const },
        };
        yield* f.sink.write({
          events: [
            {
              id: EventId.make("captured-native-ref"),
              type: "provider-thread.updated",
              threadId: f.thread.id,
              occurredAt: f.now,
              payload: thread,
            },
          ],
        });
        f.owner = { ...f.owner, providerThread: thread };
      } else if (
        change === "retained-exact-ordinal" ||
        change === "retained-foreign-ordinal" ||
        change === "retained-running-owner"
      ) {
        const run = {
          ...f.run,
          id: RunId.make("retained-parent-run"),
          ordinal: 2,
          rootNodeId: NodeId.make("retained-parent-root"),
          activeAttemptId: RunAttemptId.make("retained-parent-attempt"),
          status:
            change === "retained-running-owner" ? ("running" as const) : ("completed" as const),
          completedAt: change === "retained-running-owner" ? null : f.now,
        };
        const root = {
          ...f.root,
          id: run.rootNodeId,
          rootNodeId: run.rootNodeId,
          runId: run.id,
          status: "completed" as const,
          completedAt: f.now,
        };
        const attempt = {
          ...f.attempt,
          id: run.activeAttemptId,
          runId: run.id,
          rootNodeId: root.id,
          status: "completed" as const,
          completedAt: f.now,
        };
        const turn = {
          ...f.receipt.payload,
          id: ProviderTurnId.make("retained-parent-turn"),
          runAttemptId: attempt.id,
          nodeId: root.id,
          status: "completed" as const,
          completedAt: f.now,
        };
        yield* f.sink.write({
          events: [
            {
              id: EventId.make("retained-parent-run"),
              type: "run.created",
              threadId: f.thread.id,
              occurredAt: f.now,
              payload: run,
            },
            {
              id: EventId.make("retained-parent-attempt"),
              type: "run-attempt.created",
              threadId: f.thread.id,
              occurredAt: f.now,
              payload: attempt,
            },
            {
              id: EventId.make("retained-parent-root"),
              type: "node.updated",
              threadId: f.thread.id,
              occurredAt: f.now,
              payload: root,
            },
            {
              id: EventId.make("retained-parent-turn"),
              type: "provider-turn.updated",
              threadId: f.thread.id,
              runId: run.id,
              nodeId: root.id,
              occurredAt: f.now,
              payload: turn,
            },
            {
              id: EventId.make("retained-parent-cleared-thread"),
              type: "provider-thread.updated",
              threadId: f.thread.id,
              occurredAt: f.now,
              payload: {
                ...f.providerThread,
                lastRunOrdinal: change === "retained-foreign-ordinal" ? 1 : 2,
              },
            },
          ],
        });
        f.owner = {
          ...f.owner,
          retainedTurn: {
            id: turn.id,
            attemptId: attempt.id,
            runId: run.id,
            runOrdinal: run.ordinal,
          },
        };
      } else if (change.startsWith("native-receipt")) {
        yield* f.sink.write({
          events: [
            {
              ...f.receipt,
              payload: {
                ...f.receipt.payload,
                nativeAcceptance:
                  change === "native-receipt-pending"
                    ? "pending"
                    : change === "native-receipt-unknown"
                      ? "unknown"
                      : "accepted",
              },
            },
          ],
        });
      } else if (
        [
          "session",
          "native-id",
          "native-strength",
          "native-null",
          "foreign-older-ordinal",
          "greater-ordinal",
        ].includes(change)
      ) {
        yield* f.sink.write({
          events: [
            {
              id: EventId.make("replacement-thread"),
              type: "provider-thread.updated",
              threadId: f.thread.id,
              occurredAt: f.now,
              payload: {
                ...f.providerThread,
                ...(change === "session"
                  ? { providerSessionId: ProviderSessionId.make("replacement-session") }
                  : {}),
                ...(change === "native-id"
                  ? {
                      nativeThreadRef: {
                        ...f.providerThread.nativeThreadRef!,
                        nativeId: "replacement-native",
                      },
                    }
                  : {}),
                ...(change === "native-strength"
                  ? {
                      nativeThreadRef: {
                        ...f.providerThread.nativeThreadRef!,
                        strength: "weak" as const,
                      },
                    }
                  : {}),
                ...(change === "native-null" ? { nativeThreadRef: null } : {}),
                ...(change === "foreign-older-ordinal" ? { lastRunOrdinal: 1 } : {}),
                ...(change === "greater-ordinal" ? { lastRunOrdinal: 4 } : {}),
              },
            },
          ],
        });
      } else if (change === "root" || change === "scope") {
        yield* f.sink.write({
          events: [
            {
              id: EventId.make("replacement-root"),
              type: "node.updated",
              threadId: f.thread.id,
              runId: f.run.id,
              nodeId: f.root.id,
              occurredAt: f.now,
              payload: {
                ...f.root,
                ...(change === "root"
                  ? { rootNodeId: NodeId.make("foreign-root") }
                  : { checkpointScopeId: CheckpointScopeId.make("replacement-scope") }),
              },
            },
          ],
        });
      } else if (change === "attempt") {
        yield* f.sink.write({
          events: [
            {
              id: EventId.make("replacement-attempt"),
              type: "run.updated",
              threadId: f.thread.id,
              runId: f.run.id,
              occurredAt: f.now,
              payload: { ...f.run, activeAttemptId: RunAttemptId.make("replacement-attempt") },
            },
          ],
        });
      } else if (change === "active-thread" || change === "archived" || change === "deleted") {
        yield* f.sink.write({
          events: [
            {
              id: EventId.make("replacement-app-thread"),
              type: "thread.metadata-updated",
              threadId: f.thread.id,
              occurredAt: f.now,
              payload: {
                ...f.thread,
                ...(change === "active-thread"
                  ? { activeProviderThreadId: ProviderThreadId.make("replacement-thread") }
                  : {}),
                ...(change === "archived" ? { archivedAt: f.now } : {}),
                ...(change === "deleted" ? { deletedAt: f.now } : {}),
              },
            },
          ],
        });
      } else if (change === "paired-stop") {
        const request = (yield* projection.getThreadProjection(f.thread.id)).turnItems.find(
          (item) => item.id === f.owner.interruptRequestId,
        );
        if (request?.type !== "run_interrupt_request")
          return yield* Effect.die("Missing original Stop");
        yield* f.sink.write({
          events: [
            {
              id: EventId.make("paired-stop"),
              type: "turn-item.updated",
              threadId: f.thread.id,
              runId: f.run.id,
              occurredAt: f.now,
              payload: {
                ...request,
                id: f.owner.interruptResultId,
                parentItemId: request.id,
                type: "run_interrupt_result",
                status: "interrupted",
              },
            },
          ],
        });
      }
      const before = yield* projection.getThreadProjection(f.thread.id);
      const commandId = CommandId.make("cancelled-before-native:checkpoint");
      const effect = {
        id: "effect:cancelled-before-native:checkpoint",
        commandId,
        threadId: f.thread.id,
        request: {
          type: "checkpoint.capture" as const,
          runId: f.run.id,
          scopeId: CheckpointScopeId.make("exact-captured-scope"),
        },
      };
      const input = {
        threadId: f.thread.id,
        runId: f.run.id,
        activeAttemptId: f.attempt.id,
        expectedStatus: "running" as const,
        pendingStartOwner: { ...f.owner, effects: [effect] },
        events: [
          {
            id: EventId.make("cancelled-before-native:terminal"),
            type: "run.updated" as const,
            threadId: f.thread.id,
            runId: f.run.id,
            occurredAt: f.now,
            payload: { ...f.run, status: "interrupted" as const, completedAt: f.now },
          },
        ],
      };
      const result = yield* f.sink.writeIfRunCurrent(input);
      const shouldCommit = [
        "none",
        "captured-weak",
        "captured-null",
        "retained-exact-ordinal",
      ].includes(change);
      assert.equal(result.committed, shouldCommit);
      const after = yield* projection.getThreadProjection(f.thread.id);
      assert.deepEqual(after.providerThreads, before.providerThreads);
      assert.deepEqual(after.providerTurns, before.providerTurns);
      if (shouldCommit) {
        assert.equal(after.runs.find((run) => run.id === f.run.id)?.status, "interrupted");
        const pending = yield* outbox.listByCommandId(commandId);
        assert.lengthOf(pending, 1);
        assert.deepEqual(pending[0]?.request, effect.request);
        const replay = yield* f.sink.writeIfRunCurrent(input);
        assert.isFalse(replay.committed);
        assert.lengthOf(yield* outbox.listByCommandId(commandId), 1);
      } else {
        assert.deepEqual(after, before);
        assert.isEmpty(result.storedEvents);
        assert.isEmpty(yield* outbox.listByCommandId(commandId));
      }
    }).pipe(Effect.provide(testLayer)),
  );
}
