import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  PlanId,
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
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import { sourcePlanFingerprint } from "./SourcePlan.ts";

const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const testLayer = Layer.merge(EventSink.layer, ProjectionMaintenance.layer).pipe(
  Layer.provideMerge(stores),
);
const instanceId = ProviderInstanceId.make("controlled-plan-owner");
const driver = ProviderDriverKind.make("omp");
const seed = Effect.fnUntraced(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("plan-consumer");
  const sourceThreadId = ThreadId.make("plan-source");
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
  const sourceThread = {
    ...thread,
    id: sourceThreadId,
    title: "Source",
    activeProviderThreadId: null,
    lineage: { ...thread.lineage, rootThreadId: sourceThreadId },
  };
  const plan: Extract<OrchestrationV2PlanArtifact, { kind: "proposed_plan" }> = {
    id: PlanId.make("source-plan"),
    threadId: sourceThreadId,
    runId: null,
    nodeId: NodeId.make("source-plan:node"),
    kind: "proposed_plan",
    markdown: "# Exact selected plan",
    status: "active",
  };
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 1,
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
    sourcePlanRef: { threadId: sourceThreadId, planId: plan.id },
    sourcePlanFingerprint: sourcePlanFingerprint(plan),
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
    checkpointScopeId: null,
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
    lastRunOrdinal: 1,
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
        id: EventId.make("source:create"),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: sourceThread,
      },
      {
        id: EventId.make("plan:create"),
        type: "plan.updated",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: plan,
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
  return { sink, thread, sourceThread, run, attempt, root, providerThread, plan, receipt, now };
});

for (const receiptKind of ["local-pending", "offered-unknown", "old-unknown"] as const) {
  it.effect(`does not consume a plan from ${receiptKind} running installation`, () =>
    Effect.gen(function* () {
      const { sink, plan, receipt } = yield* seed();
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const {
        acceptedAt: _acceptedAt,
        nativeAcceptance: _nativeAcceptance,
        ...installed
      } = receipt.payload;
      yield* sink.write({
        events: [
          {
            ...receipt,
            payload: {
              ...installed,
              ...(receiptKind === "local-pending"
                ? { nativeAcceptance: "pending" as const }
                : receiptKind === "offered-unknown"
                  ? { nativeAcceptance: "unknown" as const }
                  : {}),
            },
          },
        ],
      });
      assert.equal((yield* projection.getPlan(plan.threadId, plan.id))?.status, "active");
      // The later, exact-owner native acknowledgement consumes exactly once.
      yield* sink.write({ events: [{ ...receipt, id: EventId.make("later-native-acceptance") }] });
      const consumed = yield* projection.getPlan(plan.threadId, plan.id);
      assert.ok(consumed?.kind === "proposed_plan");
      assert.equal(consumed.status, "completed");
      assert.equal(consumed.consumedBy?.providerTurnId, receipt.payload.id);
    }).pipe(Effect.provide(testLayer)),
  );
}

it.effect(
  "consumes a queued plan with the native receipt atomically and retains exact owner through replay/new attempts",
  () =>
    Effect.gen(function* () {
      const { sink, run, attempt, plan, receipt, now } = yield* seed();
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const written = yield* sink.write({ events: [receipt] });
      assert.deepEqual(
        written.map((entry) => entry.event.type),
        ["provider-turn.updated", "plan.updated"],
      );
      const consumed = yield* projection.getPlan(plan.threadId, plan.id);
      assert.ok(consumed?.kind === "proposed_plan");
      assert.equal(consumed.status, "completed");
      assert.deepEqual(consumed.consumedBy, {
        threadId: run.threadId,
        runId: run.id,
        runAttemptId: attempt.id,
        providerTurnId: receipt.payload.id,
      });
      yield* sink.write({
        events: [
          {
            ...receipt,
            id: EventId.make("native-terminal"),
            payload: { ...receipt.payload, status: "failed", completedAt: now },
          },
        ],
      });
      assert.equal(
        (yield* events.read({ eventType: "plan.updated" }).pipe(Stream.runCollect)).length,
        2,
      );
      // A later attempt by the same consumer cannot rewrite the original acceptance owner.
      const retryAttempt = {
        ...attempt,
        id: RunAttemptId.make("retry-attempt"),
        attemptOrdinal: 2,
        reason: "retry" as const,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("retry:attempt"),
            type: "run-attempt.created",
            threadId: run.threadId,
            occurredAt: now,
            payload: retryAttempt,
          },
          {
            id: EventId.make("retry:run"),
            type: "run.updated",
            threadId: run.threadId,
            occurredAt: now,
            payload: { ...run, activeAttemptId: retryAttempt.id },
          },
        ],
      });
      yield* sink.write({
        events: [
          {
            ...receipt,
            id: EventId.make("retry:accepted"),
            payload: {
              ...receipt.payload,
              runAttemptId: retryAttempt.id,
              id: ProviderTurnId.make("retry-turn"),
              ordinal: 2,
            },
          },
        ],
      });
      assert.deepEqual(yield* projection.getPlan(plan.threadId, plan.id), consumed);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* projection.getPlan(plan.threadId, plan.id), consumed);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "a plan projection failure rolls back the acceptance receipt and consumption together",
  () =>
    Effect.gen(function* () {
      const { sink, plan, receipt } = yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const sequence = yield* events.latestSequence();
      yield* sql`CREATE TRIGGER reject_plan_completion BEFORE UPDATE ON orchestration_v2_projection_plans
      WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'controlled plan completion failure'); END`;
      const failed = yield* sink.write({ events: [receipt] }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(failed));
      assert.equal(yield* events.latestSequence(), sequence);
      assert.equal((yield* projection.getPlan(plan.threadId, plan.id))?.status, "active");
      assert.equal(
        (yield* projection.getThreadProjection(receipt.threadId)).providerTurns.length,
        0,
      );
      yield* sql`DROP TRIGGER reject_plan_completion`;
      yield* sink.write({ events: [receipt] });
      assert.equal((yield* projection.getPlan(plan.threadId, plan.id))?.status, "completed");
    }).pipe(Effect.provide(testLayer)),
);

for (const mismatch of [
  "attempt",
  "root",
  "provider-thread",
  "envelope-run",
  "envelope-node",
  "envelope-instance",
  "native-driver",
  "bound-turn",
  "source-content",
  "source-deleted",
  "source-project",
  "target-archived",
  "same-batch-content",
  "same-batch-plan-owner",
] as const) {
  it.effect(`does not consume a plan from a mismatched native receipt: ${mismatch}`, () =>
    Effect.gen(function* () {
      const { sink, root, run, sourceThread, thread, plan, receipt, now } = yield* seed();
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const payload = { ...receipt.payload };
      const event = { ...receipt, payload };
      const before: OrchestrationV2DomainEvent[] = [];
      if (mismatch === "attempt") payload.runAttemptId = RunAttemptId.make("foreign-attempt");
      if (mismatch === "root") payload.nodeId = NodeId.make("foreign-root");
      if (mismatch === "provider-thread")
        payload.providerThreadId = ProviderThreadId.make("foreign-native");
      if (mismatch === "envelope-run") event.runId = RunId.make("foreign-run");
      if (mismatch === "envelope-node") event.nodeId = NodeId.make("foreign-envelope-node");
      if (mismatch === "envelope-instance")
        event.providerInstanceId = ProviderInstanceId.make("foreign-instance");
      if (mismatch === "native-driver")
        payload.nativeTurnRef = {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "foreign",
          strength: "strong",
        };
      if (mismatch === "bound-turn")
        before.push({
          id: EventId.make("changed:root"),
          type: "node.updated",
          threadId: run.threadId,
          occurredAt: now,
          payload: { ...root, providerTurnId: ProviderTurnId.make("different-bound-turn") },
        });
      if (mismatch === "source-content")
        before.push({
          id: EventId.make("changed:plan"),
          type: "plan.updated",
          threadId: plan.threadId,
          occurredAt: now,
          payload: { ...plan, markdown: "# A newer selected plan" },
        });
      if (mismatch === "source-deleted" || mismatch === "source-project")
        before.push({
          id: EventId.make("changed:source"),
          type: "thread.metadata-updated",
          threadId: plan.threadId,
          occurredAt: now,
          payload: {
            ...sourceThread,
            ...(mismatch === "source-deleted"
              ? { deletedAt: now }
              : { projectId: ProjectId.make("foreign-project") }),
          },
        });
      if (mismatch === "target-archived")
        before.push({
          id: EventId.make("changed:target"),
          type: "thread.metadata-updated",
          threadId: thread.id,
          occurredAt: now,
          payload: { ...thread, archivedAt: now },
        });
      if (before.length > 0) yield* sink.write({ events: before });
      const changedPlan: OrchestrationV2DomainEvent = {
        id: EventId.make("same-batch:changed-plan"),
        type: "plan.updated",
        threadId: plan.threadId,
        occurredAt: now,
        payload: { ...plan, markdown: "# Newer plan in this transaction" },
      };
      const wrongOwner: OrchestrationV2DomainEvent = {
        ...changedPlan,
        payload: { ...plan, threadId: thread.id },
      };
      const written = yield* sink.write({
        events:
          mismatch === "same-batch-content"
            ? [changedPlan, event]
            : mismatch === "same-batch-plan-owner"
              ? [wrongOwner, event]
              : [event],
      });
      assert.isFalse(
        written.some(
          (entry) =>
            entry.event.type === "plan.updated" && entry.event.payload.status === "completed",
        ),
      );
      const currentPlan = yield* projection.getPlan(
        mismatch === "same-batch-plan-owner" ? thread.id : plan.threadId,
        plan.id,
      );
      assert.equal(currentPlan?.status, "active");
    }).pipe(Effect.provide(testLayer)),
  );
}
