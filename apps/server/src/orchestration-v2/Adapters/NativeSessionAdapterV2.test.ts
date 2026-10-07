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
import * as Fiber from "effect/Fiber";
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
  failFirstResponse = false,
  canReadThreadSnapshot = false,
  interruptOptions: { readonly breaksSession?: boolean; readonly fail?: boolean } = {},
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  let publish: (update: NativeSessionUpdate) => Effect.Effect<void> = () =>
    Effect.die("Native callback not registered");
  let replies = 0;
  let wakes = 0;
  let steers = 0;
  let interrupts = 0;
  const adapter = makeNativeSessionAdapterV2({
    instanceId,
    driver: ProviderDriverKind.make("omp"),
    idAllocator,
    defaultCwd: "/workspace",
    capabilities: {
      ...AcpProviderCapabilitiesV2,
      threads: { ...AcpProviderCapabilitiesV2.threads, canReadThreadSnapshot },
    },
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
          interrupt: Effect.gen(function* () {
            interrupts += 1;
            if (interruptOptions.fail)
              return yield* new NativeSessionOperationError({ detail: "Close unconfirmed" });
          }),
          interruptBreaksSession: interruptOptions.breaksSession ?? true,
          respond: (id: string) =>
            Effect.gen(function* () {
              replies += 1;
              if (failFirstResponse && replies === 1)
                return yield* new NativeSessionOperationError({ detail: "Response write failed" });
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
  const eventPump = yield* runtime.events.pipe(
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
    eventPump,
    eventQueue: events,
    interrupts: () => interrupts,
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
  it.effect(
    "content settlement never invents replies or ordinals and snapshots replace deltas",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(false, false, true, false, true);
          yield* h.start;
          yield* h.publish({ type: "text-completed", id: "tool-only" });
          yield* h.publish({ type: "text", id: "empty", delta: "" });
          yield* h.publish({ type: "text-snapshot", id: "empty", text: "" });
          yield* h.publish({ type: "text", id: "reason", delta: "Reason", reasoning: true });
          yield* h.publish({ type: "text-completed", id: "reason" });
          yield* h.publish({ type: "text-completed", id: "reason" });
          yield* h.publish({ type: "text", id: "reason", delta: "late", reasoning: true });
          yield* h.publish({ type: "text", id: "answer", delta: "Draft" });
          yield* h.publish({ type: "text-snapshot", id: "answer", text: "Final answer" });
          yield* h.publish({ type: "text-completed", id: "answer" });
          yield* h.publish({ type: "text", id: "answer", delta: "late" });
          yield* h.publish({ type: "terminal", status: "completed" });
          yield* h.takeUntil((e) => e.type === "turn.terminal");
          const snapshot = yield* h.runtime.readThreadSnapshot({
            providerThread: h.providerThread,
          });
          assert.deepEqual(
            snapshot.messages.map((m) => [m.text, m.streaming]),
            [["Final answer", false]],
          );
          const items = [
            ...new Map(
              h.recorded.flatMap((e) =>
                e.type === "turn_item.updated" ? [[e.turnItem.id, e.turnItem] as const] : [],
              ),
            ).values(),
          ];
          assert.deepEqual(
            items.map((item) => [item.type, item.ordinal, item.status]),
            [
              ["reasoning", 101, "completed"],
              ["assistant_message", 102, "completed"],
            ],
          );
          assert.equal(
            h.recorded.filter(
              (e) => e.type === "turn_item.updated" && e.turnItem.type === "reasoning",
            ).length,
            2,
          );
          assert.isFalse(
            h.recorded.some((e) => e.type === "message.updated" && e.message.text.length === 0),
          );
        }),
      ),
  );

  it.effect("fails rather than reinterpreting an existing content identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.start;
        yield* h.publish({ type: "text", id: "shared", delta: "Reason", reasoning: true });
        yield* h.publish({ type: "text-snapshot", id: "shared", text: "Answer" });
        const terminal = yield* h.takeUntil((e) => e.type === "turn.terminal");
        assert.equal(terminal.type === "turn.terminal" && terminal.status, "failed");
        assert.isFalse(h.recorded.some((e) => e.type === "message.updated"));
      }),
    ),
  );

  it.effect("seals a confirmed breaking interrupt after the complete receipt prefix", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.start;
        yield* h.question;
        yield* h.publish({ type: "text", id: "answer", delta: "Retained partial answer" });
        yield* h.publish({ type: "tool", id: "tool-before-stop", name: "read", status: "running" });
        const started = yield* h.takeUntil(
          (e) => e.type === "provider_turn.updated" && e.providerTurn.status === "running",
        );
        assert.equal(started.type, "provider_turn.updated");
        if (started.type !== "provider_turn.updated") return;
        yield* h.runtime.interruptTurn({
          providerThread: h.providerThread,
          providerTurnId: started.providerTurn.id,
        });
        yield* Fiber.join(h.eventPump);
        const prefix = [...h.recorded, ...(yield* Queue.takeAll(h.eventQueue))];
        assert.isTrue(prefix.every(isProviderEvent));
        const terminals = prefix.filter((e) => e.type === "turn.terminal");
        assert.equal(terminals.length, 1);
        assert.deepInclude(terminals[0], {
          providerTurnId: started.providerTurn.id,
          status: "interrupted",
          threadDisposition: "broken",
        });
        const terminalIndex = prefix.indexOf(terminals[0]!);
        assert.isTrue(
          prefix.some(
            (e, i) =>
              i < terminalIndex &&
              e.type === "runtime_request.updated" &&
              e.runtimeRequest.status === "cancelled",
          ),
        );
        assert.isTrue(
          prefix.some(
            (e, i) =>
              i < terminalIndex &&
              e.type === "message.updated" &&
              e.message.text === "Retained partial answer" &&
              !e.message.streaming,
          ),
        );
        assert.isTrue(
          prefix.some(
            (e, i) =>
              i < terminalIndex &&
              e.type === "turn_item.updated" &&
              e.turnItem.type === "dynamic_tool" &&
              e.turnItem.status === "interrupted",
          ),
        );
        assert.isTrue(
          prefix.some(
            (e, i) =>
              i > terminalIndex &&
              e.type === "provider_session.updated" &&
              e.providerSession.status === "stopped",
          ),
        );
        assert.equal(h.runtime.providerSession.status, "stopped");
        assert.equal(h.interrupts(), 1);
        yield* h.publish({ type: "text", id: "late", delta: "Late callback" });
        assert.equal(yield* Queue.size(h.eventQueue), 0);
        assert.equal((yield* Effect.result(h.startWake))._tag, "Failure");
      }),
    ),
  );
  it.effect("keeps a reusable interrupt producer open for the next turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, true, false, false, { breaksSession: false });
        yield* h.start;
        const started = yield* h.takeUntil(
          (e) => e.type === "provider_turn.updated" && e.providerTurn.status === "running",
        );
        if (started.type !== "provider_turn.updated") return;
        yield* h.runtime.interruptTurn({
          providerThread: h.providerThread,
          providerTurnId: started.providerTurn.id,
        });
        const terminal = yield* h.takeUntil((e) => e.type === "turn.terminal");
        assert.deepInclude(terminal, { status: "interrupted", threadDisposition: "reusable" });
        assert.isUndefined(h.eventPump.pollUnsafe());
        assert.equal(h.runtime.providerSession.status, "ready");
        yield* h.startWake;
        yield* h.publish({ type: "text", id: "next", delta: "Next answer" });
        yield* h.publish({ type: "terminal", status: "completed" });
        const next = yield* h.takeUntil((e) => e.type === "turn.terminal");
        assert.deepInclude(next, { status: "completed" });
        assert.isUndefined(h.eventPump.pollUnsafe());
      }),
    ),
  );
  it.effect("does not seal or invent a terminal after an unconfirmed breaking interrupt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, true, false, false, { fail: true });
        yield* h.start;
        const started = yield* h.takeUntil(
          (e) => e.type === "provider_turn.updated" && e.providerTurn.status === "running",
        );
        if (started.type !== "provider_turn.updated") return;
        assert.equal(
          (yield* Effect.result(
            h.runtime.interruptTurn({
              providerThread: h.providerThread,
              providerTurnId: started.providerTurn.id,
            }),
          ))._tag,
          "Failure",
        );
        assert.equal(h.interrupts(), 1);
        assert.isUndefined(h.eventPump.pollUnsafe());
        assert.equal(h.runtime.providerSession.status, "running");
        yield* h.publish({ type: "text", id: "live", delta: "Peer still live" });
        yield* h.takeUntil((e) => e.type === "message.updated");
        assert.isFalse(
          h.recorded.some(
            (e) =>
              e.type === "turn.terminal" ||
              (e.type === "provider_session.updated" && e.providerSession.status === "stopped"),
          ),
        );
      }),
    ),
  );
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
          answers: { choice: "Approved value" },
        });
        yield* h.takeUntil((event) => event.type === "turn.terminal");
        assert.equal(h.replies(), 1);
        assert.equal(h.runtime.providerSession.status, "ready");
        const resolved = h.recorded.find(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "resolved",
        );
        if (resolved?.type !== "runtime_request.updated")
          return assert.fail("Expected resolved native request before terminal");
        assert.equal(resolved.runtimeRequest.decision, "accept");
        assert.deepEqual(resolved.runtimeRequest.answers, { choice: "Approved value" });
      }),
    ),
  );

  it.effect(
    "restores an unobserved failed response and preserves the successful retry decision",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(true, false, true, true, true);
          yield* h.start;
          yield* h.question;
          const pending = yield* h.takeUntil((event) => event.type === "runtime_request.updated");
          if (pending.type !== "runtime_request.updated")
            return assert.fail("Expected native request");
          const failure = yield* h.runtime
            .respondToRuntimeRequest({
              requestId: pending.runtimeRequest.id,
              decision: "accept",
            })
            .pipe(Effect.flip);
          assert.equal(failure._tag, "ProviderAdapterRuntimeRequestResponseError");
          const snapshot = yield* h.runtime.readThreadSnapshot({
            providerThread: h.providerThread,
          });
          const stillPending = snapshot.runtimeRequests.find(
            (request) => request.id === pending.runtimeRequest.id,
          );
          assert.ok(stillPending);
          assert.equal(stillPending.status, "pending");
          assert.isUndefined(stillPending.decision);
          yield* h.runtime.respondToRuntimeRequest({
            requestId: pending.runtimeRequest.id,
            decision: "decline",
          });
          yield* h.takeUntil((event) => event.type === "turn.terminal");
          assert.equal(h.replies(), 2);
          const resolved = h.recorded.find(
            (event) =>
              event.type === "runtime_request.updated" &&
              event.runtimeRequest.status === "resolved",
          );
          if (resolved?.type !== "runtime_request.updated")
            return assert.fail("Expected native resolved receipt");
          assert.equal(resolved.runtimeRequest.decision, "decline");
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
