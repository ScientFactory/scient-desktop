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
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { canSendQueueHead, isQueueUsageLimitProven } from "@t3tools/shared/scientQueueHeadSend";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { makeLayer } from "../ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";

// The queue strip offers Send by `canSendQueueHead`; queue.resume must refuse
// exactly where the rule says no, with the server's own refusal text.

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const testLayer = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "queue-head-send-rule" },
  makeLayer([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Provider execution is not part of this rule"),
    },
  ]),
  { runEffectWorker: false },
);

/** The refusal text a dispatch error carries, however deeply it is wrapped. */
function refusalText(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    if (!("cause" in current)) break;
    current = current.cause;
  }
  return typeof current === "string" ? current : String(current);
}

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId: ProjectId.make(`${threadId}:project`),
      title: "Queue head",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

/** A thread whose active run failed at the usage limit, with one queued run behind it. */
const usageLimitedThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const sink = yield* EventSinkV2;
    yield* createThread(threadId);
    for (const index of [0, 1]) {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:message:${index}`),
        threadId,
        messageId: MessageId.make(`${threadId}:message:${index}`),
        text: index === 0 ? "Active" : "Queued",
        attachments: [],
        modelSelection,
        dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
      });
    }
    const before = yield* orchestrator.getThreadProjection(threadId);
    const activeRun = before.runs.find((run) => run.status !== "queued");
    const queuedRun = before.runs.find((run) => run.status === "queued");
    assert.isDefined(activeRun);
    assert.isDefined(queuedRun);
    assert.isNotNull(activeRun.rootNodeId);

    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`${threadId}:error`),
          type: "turn-item.updated",
          threadId,
          runId: activeRun.id,
          nodeId: activeRun.rootNodeId,
          providerInstanceId: activeRun.providerInstanceId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`${threadId}:error`),
            type: "error",
            threadId,
            runId: activeRun.id,
            nodeId: activeRun.rootNodeId,
            providerThreadId: activeRun.providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 2,
            status: "failed",
            title: "Usage limit",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            failure: {
              class: "usage_limit",
              message: "Usage limit reached.",
              code: "usage_limit",
              retryable: null,
            },
          },
        },
        {
          id: EventId.make(`${threadId}:failed`),
          type: "run.updated",
          threadId,
          runId: activeRun.id,
          nodeId: activeRun.rootNodeId,
          providerInstanceId: activeRun.providerInstanceId,
          occurredAt: now,
          payload: { ...activeRun, status: "failed", startedAt: now, completedAt: now },
        },
      ],
    });
    return queuedRun;
  });

it.effect("refuses Send of the queue head after the usage limit, as the rule says", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const threadId = ThreadId.make("queue-head-rule-usage-limit");
    const queuedRun = yield* usageLimitedThread(threadId);
    const limited = yield* orchestrator.getThreadProjection(threadId);
    assert.isFalse(canSendQueueHead(limited, queuedRun.id));
    const refused = yield* orchestrator
      .dispatch({
        type: "queue.resume",
        threadId,
        commandId: CommandId.make(`${threadId}:send`),
        runId: queuedRun.id,
      })
      .pipe(Effect.flip);
    assert.include(refusalText(refused), "Continue the limited thread before resuming its queue.");
    const after = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(after.runs.find((run) => run.id === queuedRun.id)?.status, "queued");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps Send on a windowed snapshot that misses the session lifting the limit", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const sink = yield* EventSinkV2;
    const threadId = ThreadId.make("queue-head-rule-windowed-session");
    const queuedRun = yield* usageLimitedThread(threadId);
    // A newer session for the same provider instance ends with another error.
    // It owns no provider thread, so a windowed snapshot leaves it out.
    const now = yield* DateTime.now;
    const sessionId = ProviderSessionId.make(`${threadId}:newer-session`);
    yield* sink.write({
      events: [
        {
          id: EventId.make(`${threadId}:newer-session`),
          type: "provider-session.attached",
          threadId,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: sessionId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: instanceId,
            status: "error",
            cwd: process.cwd(),
            model: null,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: "The provider process exited.",
          },
        },
      ],
    });

    const full = yield* orchestrator.getThreadProjection(threadId);
    const windowed = (yield* orchestrator.getThreadSnapshotWindow(threadId, { rowLimit: 50 }))
      .projection;
    assert.deepEqual(
      full.providerSessions.map((session) => session.id),
      [sessionId],
    );
    assert.deepEqual(windowed.providerSessions, []);
    assert.isTrue(canSendQueueHead(full, queuedRun.id));
    // The snapshot alone still looks limited; the shell, built from every
    // bound session, does not confirm it, so the client keeps Send.
    assert.isFalse(canSendQueueHead(windowed, queuedRun.id));
    const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
      (thread) => thread.id === threadId,
    );
    assert.notEqual(shell?.lastErrorClass, "usage_limit");
    assert.isTrue(
      canSendQueueHead(
        windowed,
        queuedRun.id,
        isQueueUsageLimitProven(windowed, shell?.lastErrorClass),
      ),
    );
    yield* orchestrator.dispatch({
      type: "queue.resume",
      threadId,
      commandId: CommandId.make(`${threadId}:send`),
      runId: queuedRun.id,
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses Send of the first visible row while a delegated completion goes first", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const sink = yield* EventSinkV2;
    const threadId = ThreadId.make("queue-head-rule-delegated");
    yield* createThread(threadId);
    for (const suffix of ["ordinary", "automatic"]) {
      yield* orchestrator.dispatch({
        type: "legacy-queue.import",
        commandId: CommandId.make(`${threadId}:admit:${suffix}`),
        threadId,
        queueItemId: `qitem_${suffix}`,
        messageId: MessageId.make(`${threadId}:message:${suffix}`),
        text: suffix,
        attachments: [],
        modelSelection,
        createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
      });
    }
    const imported = yield* orchestrator.getThreadProjection(threadId);
    const [ordinaryRun, automaticRun] = imported.runs;
    assert.isDefined(ordinaryRun);
    assert.isDefined(automaticRun);
    const automatic = imported.messages.find(
      (message) => message.id === automaticRun.userMessageId,
    );
    assert.isDefined(automatic);
    yield* sink.writeWithEffects({
      effects: [],
      events: [
        {
          id: EventId.make(`${threadId}:automatic-delivery`),
          type: "message.updated",
          threadId,
          occurredAt: yield* DateTime.now,
          payload: {
            ...automatic,
            delegatedCompletion: {
              parentRunId: ordinaryRun.id,
              generation: 1,
              taskIds: [NodeId.make("completed-task")],
            },
          },
        },
      ],
    });

    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.isFalse(canSendQueueHead(projection, ordinaryRun.id));
    assert.isTrue(canSendQueueHead(projection, automaticRun.id));
    const refused = yield* orchestrator
      .dispatch({
        type: "queue.resume",
        threadId,
        commandId: CommandId.make(`${threadId}:send-ordinary`),
        runId: ordinaryRun.id,
      })
      .pipe(Effect.flip);
    assert.include(refusalText(refused), "Only the idle queue head is ready to send.");
    yield* orchestrator.dispatch({
      type: "queue.resume",
      threadId,
      commandId: CommandId.make(`${threadId}:send-automatic`),
      runId: automaticRun.id,
    });
    const delivered = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(delivered.runs.find((run) => run.id === automaticRun.id)?.status, "starting");
  }).pipe(Effect.provide(testLayer)),
);
