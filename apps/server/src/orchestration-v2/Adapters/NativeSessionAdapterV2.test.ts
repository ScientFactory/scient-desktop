import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import { AcpProviderCapabilitiesV2 } from "./AcpAdapterV2.ts";
import {
  makeNativeSessionAdapterV2,
  NativeSessionOperationError,
  type NativeSessionUpdate,
} from "./NativeSessionAdapterV2.ts";

const instanceId = ProviderInstanceId.make("omp-test");
const threadId = ThreadId.make("native-thread-test");
const modelSelection = { instanceId, model: "provider/model" };
const runtimePolicy = {
  cwd: null,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
};
const TestLayer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer);
const isProviderEvent = Schema.is(ProviderAdapter.ProviderAdapterV2Event);

const harness = Effect.fnUntraced(function* (
  replySettlesTurn = false,
  failSend = false,
  nativeThreadKnown = true,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  let publish: (update: NativeSessionUpdate) => Effect.Effect<void> = () =>
    Effect.die("Native callback not registered");
  let replies = 0;
  let wakes = 0;
  let steers = 0;
  const adapter = makeNativeSessionAdapterV2({
    instanceId,
    driver: ProviderDriverKind.make("omp"),
    idAllocator,
    defaultCwd: "/workspace",
    capabilities: AcpProviderCapabilitiesV2,
    continuations: {
      offer: () =>
        Effect.sync(() => {
          wakes += 1;
        }),
    },
    open: (_, callback) =>
      Effect.sync(() => {
        publish = callback;
        return {
          nativeId: "native-test",
          nativeThreadKnown,
          steer: () =>
            Effect.sync(() => {
              steers += 1;
            }),
          send: () =>
            failSend
              ? Effect.fail(new NativeSessionOperationError({ detail: "Transport write failed" }))
              : Effect.void,
          resume: () => Effect.void,
          interrupt: Effect.void,
          interruptBreaksSession: true,
          respond: (id: string) =>
            Effect.gen(function* () {
              replies += 1;
              if (replySettlesTurn) {
                yield* publish({ type: "question-resolved", id });
                yield* publish({ type: "terminal", status: "completed" });
              }
            }),
        };
      }),
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("native-session"),
    modelSelection,
    runtimePolicy,
  });
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const appThread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project"),
    title: "Native conversation",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const turnInput: ProviderAdapter.ProviderAdapterV2TurnInput = {
    appThread,
    threadId,
    runId: RunId.make("native-run"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("native-attempt"),
    rootNodeId: NodeId.make("native-root"),
    providerThread,
    modelSelection,
    runtimePolicy,
    message: {
      messageId: MessageId.make("native-user-message"),
      text: "Run",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
  };
  const start = runtime.startTurn(turnInput);
  const recorded: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const takeUntil = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(events);
        assert.isTrue(isProviderEvent(event));
        recorded.push(event);
        if (predicate(event)) return event;
      }
    });
  const question = publish({
    type: "question",
    id: "approval",
    method: "confirm",
    title: "Confirm",
    message: "Proceed?",
    options: [],
  });
  return {
    runtime,
    turnInput,
    providerThread,
    start,
    startWake: runtime.startTurn({
      ...turnInput,
      runId: RunId.make("native-wake-run"),
      runOrdinal: 2,
      providerTurnOrdinal: 2,
      attemptId: RunAttemptId.make("native-wake-attempt"),
      rootNodeId: NodeId.make("native-wake-root"),
      message: {
        ...turnInput.message,
        messageId: MessageId.make("native-wake-message"),
        createdBy: "agent",
        creationSource: "provider",
      },
    }),
    publish: (update: NativeSessionUpdate) => publish(update),
    question,
    takeUntil,
    recorded,
    replies: () => replies,
    wakes: () => wakes,
    steers: () => steers,
  };
});

it.layer(TestLayer)("NativeSessionAdapterV2", (it) => {
  it.effect("rejects a provider thread owned by another instance before resume", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const foreign = {
          ...h.providerThread,
          providerInstanceId: ProviderInstanceId.make("another-instance"),
        };
        assert.equal(
          (yield* Effect.result(h.runtime.resumeThread({ providerThread: foreign })))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.result(
            h.runtime.ensureThread({
              threadId,
              modelSelection,
              runtimePolicy,
              existingProviderThread: foreign,
            }),
          ))._tag,
          "Failure",
        );
      }),
    ),
  );
  it.effect("does not turn a local startup identity into native resume authority", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, false);
        assert.isNull(h.providerThread.nativeThreadRef);
        yield* h.publish({ type: "native-thread", id: "confirmed-conversation" });
        const receipt = yield* h.takeUntil(
          (event) =>
            event.type === "provider_thread.updated" &&
            event.providerThread.nativeThreadRef?.nativeId === "confirmed-conversation",
        );
        if (receipt.type === "provider_thread.updated")
          assert.equal(receipt.providerThread.nativeThreadRef?.strength, "strong");
        const again = yield* h.runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        assert.equal(again.id, h.providerThread.id);
        assert.equal(again.nativeThreadRef?.nativeId, "confirmed-conversation");
      }),
    ),
  );
  it.effect("rejects stale steering before the native transport receives it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.start;
        const receipt = yield* h.takeUntil((event) => event.type === "provider_turn.updated");
        if (receipt.type !== "provider_turn.updated")
          return yield* Effect.die("Missing turn receipt");
        const request = {
          threadId,
          runId: h.turnInput.runId,
          providerThread: h.providerThread,
          providerTurnId: ProviderTurnId.make("stale-turn"),
          message: h.turnInput.message,
        };
        assert.equal((yield* Effect.result(h.runtime.steerTurn(request)))._tag, "Failure");
        assert.equal(h.steers(), 0);
        yield* h.runtime.steerTurn({ ...request, providerTurnId: receipt.providerTurn.id });
        assert.equal(h.steers(), 1);
        yield* h.publish({ type: "terminal", status: "completed" });
        assert.equal(
          (yield* Effect.result(
            h.runtime.steerTurn({ ...request, providerTurnId: receipt.providerTurn.id }),
          ))._tag,
          "Failure",
        );
        assert.equal(h.steers(), 1);
      }),
    ),
  );
  it.effect("projects a confirmed native model change while idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.publish({ type: "model", model: "provider/confirmed-model" });
        const receipt = yield* h.takeUntil(
          (event) =>
            event.type === "provider_session.updated" &&
            event.providerSession.model === "provider/confirmed-model",
        );
        assert.equal(receipt.type, "provider_session.updated");
        assert.equal(h.runtime.providerSession.model, "provider/confirmed-model");
      }),
    ),
  );
  it.effect("retains native presentation through sparse terminal observations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.start;
        yield* h.publish({
          type: "subagent",
          id: "metadata",
          title: "Audit",
          status: "running",
          model: "provider/auditor",
          presentation: {
            kind: "workflow",
            workflowName: "Verification",
            phases: [{ index: 0, title: "Inspect" }],
            usage: { totalTokens: 20, inputTokens: 12 },
            role: "researcher",
            effort: "high",
            runHandles: { runId: "native-workflow-run" },
          },
        });
        yield* h.takeUntil((event) => event.type === "subagent.updated");
        const first = h.recorded.findLast((event) => event.type === "subagent.updated");
        if (first?.type !== "subagent.updated")
          return yield* Effect.die("Missing initial subagent");
        yield* h.publish({
          type: "subagent",
          id: "metadata",
          title: "Audit",
          status: "completed",
          detail: "Verified",
          presentation: { kind: "workflow", usage: { totalTokens: 40, toolUses: 2 } },
        });
        yield* h.takeUntil(
          (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
        );
        const terminal = h.recorded.findLast((event) => event.type === "subagent.updated");
        if (terminal?.type !== "subagent.updated")
          return yield* Effect.die("Missing terminal subagent");
        assert.deepEqual(terminal.subagent.presentation?.usage, {
          totalTokens: 40,
          inputTokens: 12,
          toolUses: 2,
        });
        assert.equal(
          terminal.subagent.presentation?.firstSeenAt,
          first.subagent.presentation?.firstSeenAt,
        );
        assert.equal(terminal.subagent.model, "provider/auditor");
        assert.equal(terminal.subagent.presentation?.role, "researcher");
        assert.deepEqual(terminal.subagent.presentation?.phases, [{ index: 0, title: "Inspect" }]);
        assert.equal(terminal.subagent.nativeTaskRef?.nativeId, "metadata");
        assert.equal(terminal.subagent.result, "Verified");
        assert.equal(terminal.subagent.presentation?.activationCount, 1);
        const settledCount = h.recorded.filter((event) => event.type === "subagent.updated").length;
        yield* h.publish({
          type: "subagent",
          id: "metadata",
          title: "Audit",
          status: "running",
          detail: "Late progress",
        });
        yield* h.publish({ type: "tool", id: "after-late", name: "Barrier", status: "completed" });
        yield* h.takeUntil(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.toolName === "Barrier",
        );
        assert.equal(
          h.recorded.filter((event) => event.type === "subagent.updated").length,
          settledCount,
        );
        yield* h.publish({
          type: "subagent",
          id: "metadata",
          title: "Audit",
          status: "running",
          reopen: true,
        });
        yield* h.takeUntil(
          (event) =>
            event.type === "subagent.updated" && event.subagent.presentation?.activationCount === 2,
        );
        const reopened = h.recorded.findLast((event) => event.type === "subagent.updated");
        if (reopened?.type !== "subagent.updated")
          return yield* Effect.die("Missing reopened subagent");
        assert.equal(
          reopened.subagent.presentation?.firstSeenAt,
          first.subagent.presentation?.firstSeenAt,
        );
        assert.isUndefined(reopened.subagent.presentation?.usage);
        assert.isNull(reopened.subagent.result);
        assert.isNull(reopened.subagent.completedAt);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("retains background task identity and spawning-run ownership across a wake turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.start;
        yield* h.publish({
          type: "subagent",
          id: "background-task",
          title: "Measure",
          status: "running",
        });
        yield* h.publish({ type: "terminal", status: "completed" });
        yield* h.takeUntil((event) => event.type === "turn.terminal");
        assert.isTrue(
          yield* (
            h.runtime.hasPendingBackgroundWork ?? Effect.die("Missing background-work capability")
          ),
        );
        const spawned = h.recorded.find((event) => event.type === "subagent.updated");
        if (spawned?.type !== "subagent.updated") return yield* Effect.die("Missing spawn receipt");
        assert.isFalse(
          h.recorded.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "subagent" &&
              event.turnItem.status === "completed",
          ),
        );
        yield* h.publish({
          type: "subagent",
          id: "background-task",
          title: "Measure",
          status: "completed",
          detail: "Measured",
        });
        assert.equal(h.wakes(), 1);
        yield* h.startWake;
        yield* h.takeUntil((event) => event.type === "turn.terminal" && event.runOrdinal === 2);
        const finished = h.recorded.findLast((event) => event.type === "subagent.updated");
        if (finished?.type !== "subagent.updated")
          return yield* Effect.die("Missing completion receipt");
        assert.equal(finished.subagent.id, spawned.subagent.id);
        assert.equal(finished.subagent.childThreadId, spawned.subagent.childThreadId);
        assert.equal(finished.subagent.runId, RunId.make("native-run"));
        assert.equal(finished.subagent.parentNodeId, NodeId.make("native-root"));
        assert.equal(h.recorded.filter((event) => event.type === "app_thread.created").length, 1);
        assert.isFalse(
          yield* (
            h.runtime.hasPendingBackgroundWork ?? Effect.die("Missing background-work capability")
          ),
        );
      }),
    ),
  );

  it.effect(
    "settles background tasks when their native process fails after the foreground turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          yield* h.start;
          yield* h.publish({
            type: "subagent",
            id: "background",
            title: "Inspect",
            status: "running",
          });
          yield* h.publish({ type: "terminal", status: "completed" });
          yield* h.takeUntil((event) => event.type === "turn.terminal");
          const roster = h.recorded.findLast((event) => event.type === "provider_thread.updated");
          if (roster?.type !== "provider_thread.updated")
            return yield* Effect.die("Missing thread receipt");
          assert.equal(roster.providerThread.pendingBackgroundTasks?.length, 1);
          assert.equal(roster.providerThread.pendingBackgroundTasks?.[0]?.kind, "subagent");
          yield* h.publish({
            type: "terminal",
            status: "failed",
            broken: true,
            detail: "Process exited",
          });
          yield* h.takeUntil(
            (event) =>
              event.type === "provider_thread.updated" && event.providerThread.status === "error",
          );
          const task = h.recorded.findLast((event) => event.type === "subagent.updated");
          if (task?.type !== "subagent.updated") return yield* Effect.die("Missing task receipt");
          assert.equal(task.subagent.status, "failed");
          assert.equal(task.subagent.runId, RunId.make("native-run"));
          assert.isTrue(
            h.recorded.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "subagent" &&
                event.turnItem.status === "failed",
            ),
          );
          assert.isTrue(
            h.recorded.some(
              (event) =>
                event.type === "node.updated" &&
                event.node.kind === "subagent" &&
                event.node.status === "failed",
            ),
          );
          const cleared = h.recorded.findLast((event) => event.type === "provider_thread.updated");
          if (cleared?.type !== "provider_thread.updated")
            return yield* Effect.die("Missing error receipt");
          assert.deepEqual(cleared.providerThread.pendingBackgroundTasks, []);
          assert.isFalse(
            yield* (
              h.runtime.hasPendingBackgroundWork ?? Effect.die("Missing background-work capability")
            ),
          );
          assert.equal(h.wakes(), 0);
        }),
      ),
  );

  it.effect("settles a failed send and rejects reuse of the broken session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, true);
        assert.isTrue((yield* Effect.result(h.start))._tag === "Failure");
        const terminal = yield* h.takeUntil((event) => event.type === "turn.terminal");
        if (terminal.type === "turn.terminal") {
          assert.equal(terminal.status, "failed");
          assert.equal(terminal.threadDisposition, "broken");
        }
        assert.equal(h.runtime.providerSession.status, "error");
        assert.equal(h.runtime.providerSession.lastError, "Transport write failed");
        assert.isTrue((yield* Effect.result(h.start))._tag === "Failure");
      }),
    ),
  );

  it.effect("cancels unanswered dialogs and open nodes before the terminal receipt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.start;
        yield* h.question;
        const pending = yield* h.takeUntil((event) => event.type === "runtime_request.updated");
        assert.equal(pending.type, "runtime_request.updated");
        if (pending.type !== "runtime_request.updated") return;
        yield* h.publish({ type: "text", id: "answer", delta: "Partial answer" });
        yield* h.publish({
          type: "terminal",
          status: "failed",
          detail: "Process failed",
          broken: true,
        });
        yield* h.takeUntil((event) => event.type === "turn.terminal");
        const cancelled = h.recorded.findIndex(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
        );
        assert.isAbove(cancelled, -1);
        assert.isBelow(
          cancelled,
          h.recorded.findIndex((event) => event.type === "turn.terminal"),
        );
        assert.isTrue(
          h.recorded.some(
            (event) =>
              event.type === "node.updated" &&
              event.node.kind === "assistant_message" &&
              event.node.status === "failed",
          ),
        );
        const error = yield* h.runtime
          .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "accept" })
          .pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterRuntimeRequestResponseError");
        assert.equal(h.replies(), 0);
        assert.equal(h.runtime.providerSession.status, "error");
        assert.equal(h.runtime.providerSession.cwd, "/workspace");
      }),
    ),
  );

  it.effect("allows synchronous native resolution and completion during a response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(true);
        yield* h.start;
        yield* h.question;
        const pending = yield* h.takeUntil((event) => event.type === "runtime_request.updated");
        if (pending.type !== "runtime_request.updated") return;
        yield* h.runtime.respondToRuntimeRequest({
          requestId: pending.runtimeRequest.id,
          decision: "accept",
        });
        yield* h.takeUntil((event) => event.type === "turn.terminal");
        assert.equal(h.replies(), 1);
        assert.equal(h.runtime.providerSession.status, "ready");
        assert.isTrue(
          h.recorded.some(
            (event) =>
              event.type === "runtime_request.updated" &&
              event.runtimeRequest.status === "resolved",
          ),
        );
      }),
    ),
  );

  it.effect(
    "records process failure while idle instead of scheduling a synthetic continuation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          yield* h.publish({
            type: "terminal",
            status: "failed",
            broken: true,
            detail: "Transport closed",
          });
          yield* h.takeUntil(
            (event) =>
              event.type === "provider_thread.updated" && event.providerThread.status === "error",
          );
          assert.equal(h.runtime.providerSession.status, "error");
          assert.equal(h.wakes(), 0);
        }),
      ),
  );

  it.effect("publishes readable child results for native subagents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.start;
        yield* h.publish({
          type: "subagent",
          id: "child",
          title: "Inspect result",
          status: "running",
        });
        yield* h.publish({
          type: "subagent",
          id: "child",
          title: "Inspect result",
          status: "completed",
          detail: "The measured result is consistent.",
        });
        yield* h.publish({ type: "terminal", status: "completed" });
        yield* h.takeUntil((event) => event.type === "turn.terminal");
        const child = h.recorded.find((event) => event.type === "app_thread.created");
        assert.isDefined(child);
        if (child?.type !== "app_thread.created") return;
        assert.equal(child.appThread.lineage.parentThreadId, threadId);
        assert.isTrue(
          h.recorded.some(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.childThreadId === child.appThread.id,
          ),
        );
        assert.isTrue(
          h.recorded.some(
            (event) =>
              event.type === "message.updated" &&
              event.message.threadId === child.appThread.id &&
              event.message.text === "The measured result is consistent.",
          ),
        );
      }),
    ),
  );

  it.effect("persists successful output truncation without turning it into failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.start;
        yield* h.publish({ type: "text", id: "answer", delta: "Limited answer" });
        yield* h.publish({ type: "terminal", status: "completed", stopReason: "length" });
        const terminal = yield* h.takeUntil((event) => event.type === "turn.terminal");
        if (terminal.type === "turn.terminal") assert.equal(terminal.status, "completed");
        assert.isTrue(
          h.recorded.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "notification" &&
              event.turnItem.source.kind === "output_truncated",
          ),
        );
      }),
    ),
  );
});
