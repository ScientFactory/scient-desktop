import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RunAttemptId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { isRecord } from "effect-omp-rpc/schema";
import * as ServerConfig from "../../config.ts";
import { scriptedOmpRpc } from "../../provider/testUtils/scriptedOmpRpc.ts";
import { ompTarget, type OmpTarget } from "../../provider/omp/OmpTarget.ts";
import { scientAgentTarget } from "../../provider/scient/ScientAgentTarget.ts";
import { makeOmpAdapterV2 } from "./OmpAdapterV2.ts";

const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(HostProcess.Platform, "darwin"),
  IdAllocator.layer,
  McpProviderSessions.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-omp-stop-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

const harness = Effect.fnUntraced(function* (
  configuration: Partial<Parameters<typeof scriptedOmpRpc>[0]> = {},
  target: OmpTarget = ompTarget,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const observed = yield* Deferred.make<void>();
  const abortSent = yield* Deferred.make<void>();
  let wakes = 0;
  let processes = 0;
  const peer = scriptedOmpRpc({
    models: [{ provider: "test", id: "selected", input: ["text"] }],
    initial: { provider: "test", id: "selected" },
    version: target.driverKind === "scient" ? "0.1.2" : "18.12.6",
    abortResponse: { steering: [], followUp: [] },
    ...configuration,
  });
  const instanceId = ProviderInstanceId.make(`stop-${target.driverKind}`);
  const threadId = ThreadId.make("stop-thread");
  const modelSelection = { instanceId, model: "test/selected" };
  const runtimePolicy = {
    cwd: config.stateDir,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
  };
  const adapter = yield* makeOmpAdapterV2({
    target,
    instanceId,
    settings: { binaryPath: target.driverKind },
    environment: {},
    homePath: path.join(config.stateDir, "home"),
    spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
    fileSystem: fs,
    path,
    crypto: yield* Crypto.Crypto,
    serverConfig: config,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    continuations: {
      offer: () =>
        Effect.sync(() => {
          wakes++;
        }),
    },
    makeProcess: (options) => {
      processes++;
      // Keep the audit across restarts, but reset the peer's process-local session.
      peer.state.sessionOrdinal = 0;
      peer.state.sessionFile = undefined;
      return peer.makeProcess(options);
    },
    nativeEventLogger: {
      filePath: "synthetic",
      close: () => Effect.void,
      write: (record) => {
        if (!isRecord(record) || !isRecord(record.event)) return Effect.void;
        if (record.event.kind === "command" && record.event.method === "abort_and_restore_queue")
          return Deferred.succeed(abortSent, undefined).pipe(Effect.asVoid);
        if (record.event.kind === "notification" && record.event.method === "session_settled")
          return Deferred.succeed(observed, undefined).pipe(Effect.asVoid);
        return Effect.void;
      },
    },
  });
  let runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("stop-session"),
    modelSelection,
    runtimePolicy,
  });
  let providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const appThread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("stop-project"),
    title: "Stop",
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
  const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
  const recorded: ProviderAdapterV2Event[] = [];
  const collect = () =>
    runtime.events.pipe(
      Stream.runForEach((event) => {
        recorded.push(event);
        return Queue.offer(events, event);
      }),
      Effect.forkScoped,
    );
  yield* collect();
  const until = Effect.fnUntraced(function* (
    predicate: (event: ProviderAdapterV2Event) => boolean,
  ) {
    while (true) {
      const event = yield* Queue.take(events);
      if (predicate(event)) return event;
    }
  });
  const start = Effect.fnUntraced(function* (ordinal: number, continuation = false) {
    return yield* runtime.startTurn({
      appThread,
      threadId,
      providerThread,
      modelSelection,
      runtimePolicy,
      runId: RunId.make(`stop-run-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`stop-attempt-${ordinal}`),
      rootNodeId: NodeId.make(`stop-root-${ordinal}`),
      message: {
        messageId: MessageId.make(`stop-message-${ordinal}`),
        text: "Hello",
        attachments: [],
        createdBy: continuation ? "agent" : "user",
        creationSource: continuation ? "provider" : "web",
      },
    });
  });
  yield* start(1);
  yield* peer.promptDelivered();
  yield* peer.emit([{ type: "agent_start" }]);
  const offered = yield* until(
    (event) =>
      event.type === "provider_turn.updated" && event.providerTurn.acceptedAt !== undefined,
  );
  if (offered.type !== "provider_turn.updated") return yield* Effect.die("Missing native turn");
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  if (!nativeId) return yield* Effect.die("Missing native transcript");
  const settle = () =>
    peer.emit([
      { type: "agent_end", messages: [], isTerminal: true, yielded: true },
      {
        type: "prompt_result",
        id: peer.state.frames.find((frame) => frame.type === "prompt")?.id,
        agentInvoked: true,
        status: "aborted",
        sessionSettled: true,
      },
    ]);
  return {
    peer,
    runtime,
    providerThread,
    recorded,
    start,
    settle,
    until,
    abortSent,
    observed,
    wakes: () => wakes,
    processes: () => processes,
    reopen: Effect.gen(function* () {
      runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("stop-session-2"),
        modelSelection,
        runtimePolicy,
      });
      yield* collect();
      providerThread = yield* runtime.resumeThread({ providerThread });
    }),
    stop: () => runtime.interruptTurn({ providerThread, providerTurnId: offered.providerTurn.id }),
    lockExists: () => fs.exists(path.join(path.dirname(nativeId), ".session.lock")),
  };
});

it.layer(TestLayer)("OMP graceful Stop", (it) => {
  it.effect.each([ompTarget, scientAgentTarget])(
    "keeps $driverKind alive and fences autonomous starts until the next explicit send",
    (target) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({}, target);
          const stopping = yield* h.stop().pipe(Effect.forkChild);
          yield* Deferred.await(h.abortSent);
          assert.equal(h.peer.state.shutdowns, 0);
          assert.equal(h.recorded.filter((event) => event.type === "turn.terminal").length, 0);
          yield* h.settle();
          yield* Fiber.join(stopping);
          const terminal = yield* h.until((event) => event.type === "turn.terminal");
          assert.equal(terminal.type === "turn.terminal" && terminal.status, "interrupted");
          assert.equal(terminal.type === "turn.terminal" && terminal.threadDisposition, "reusable");
          assert.equal(h.peer.state.shutdowns, 0);
          assert.isTrue(yield* h.lockExists());
          yield* h.peer.emit([
            { type: "agent_start" },
            { type: "message_end", message: { role: "assistant", content: "phantom" } },
            { type: "agent_end", messages: [], isTerminal: true },
            { type: "session_settled" },
          ]);
          yield* Deferred.await(h.observed);
          assert.equal(h.wakes(), 0);
          yield* h.start(2);
          yield* h.until(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.ordinal === 2 &&
              event.providerTurn.acceptedAt !== undefined,
          );
          yield* h.peer.finish();
          const next = yield* h.until(
            (event) => event.type === "turn.terminal" && event.runOrdinal === 2,
          );
          assert.equal(next.type === "turn.terminal" && next.status, "completed");
          assert.equal(h.peer.state.shutdowns, 0);
          assert.equal(
            h.peer.state.frames.filter((frame) => frame.type === "new_session").length,
            1,
          );
          assert.equal(
            h.peer.state.frames.filter((frame) => frame.type === "switch_session").length,
            0,
          );
          assert.equal(h.recorded.filter((event) => event.type === "turn.terminal").length, 2);
        }),
      ),
  );

  it.effect(
    "kills an old runtime without plain abort and resumes the next message in a new process",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({
            version: "18.3.1",
            commandError: (frame) =>
              frame.type === "abort_and_restore_queue"
                ? "Unknown command: abort_and_restore_queue"
                : undefined,
          });
          yield* h.stop();
          const terminal = yield* h.until((event) => event.type === "turn.terminal");
          assert.equal(terminal.type === "turn.terminal" && terminal.status, "interrupted");
          assert.equal(terminal.type === "turn.terminal" && terminal.threadDisposition, "broken");
          assert.equal(h.runtime.providerSession.status, "stopped");
          assert.equal(h.peer.state.shutdowns, 1);
          assert.equal(h.peer.state.frames.filter((frame) => frame.type === "abort").length, 0);
          assert.isFalse(yield* h.lockExists());
          assert.equal(h.wakes(), 0);
          yield* h.reopen;
          yield* h.start(2);
          yield* h.peer.promptDelivered();
          yield* h.peer.finish();
          const next = yield* h.until(
            (event) => event.type === "turn.terminal" && event.runOrdinal === 2,
          );
          assert.equal(next.type === "turn.terminal" && next.status, "completed");
          assert.equal(next.type === "turn.terminal" && next.threadDisposition, "reusable");
          assert.equal(h.processes(), 2);
          assert.equal(h.peer.state.shutdowns, 1);
          assert.equal(
            h.peer.state.frames.filter((frame) => frame.type === "new_session").length,
            2,
          );
          assert.equal(
            h.peer.state.frames.filter((frame) => frame.type === "switch_session").length,
            1,
          );
          assert.isTrue(yield* h.lockExists());
        }),
      ),
  );

  it.effect(
    "logs a late extension error after Stop without offering a wake or creating a turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const stopping = yield* h.stop().pipe(Effect.forkChild);
          yield* Deferred.await(h.abortSent);
          yield* h.settle();
          yield* Fiber.join(stopping);
          yield* h.until((event) => event.type === "turn.terminal");
          const recorded = [...h.recorded];
          yield* h.peer.emit([
            { type: "extension_error", error: "Stopped extension failed late" },
            { type: "session_settled" },
          ]);
          yield* Deferred.await(h.observed);
          assert.equal(h.wakes(), 0);
          assert.deepEqual(h.recorded, recorded);
          assert.equal(h.recorded.filter((event) => event.type === "turn.terminal").length, 1);
          assert.equal(h.processes(), 1);
          assert.equal(h.peer.state.shutdowns, 0);
        }),
      ),
  );

  it.effect("cancels an unowned question and delivers detached results after Stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const replied = yield* Deferred.make<void>();
        const h = yield* harness(
          {
            holdReply: (frame) =>
              frame.type === "extension_ui_response"
                ? Deferred.succeed(replied, undefined).pipe(Effect.asVoid)
                : Effect.void,
          },
          scientAgentTarget,
        );
        yield* h.peer.emit([
          {
            type: "subagent_lifecycle",
            payload: { id: "detached", status: "started", description: "Review files" },
          },
        ]);
        const child = yield* h.until((event) => event.type === "subagent.updated");
        if (child.type !== "subagent.updated") return yield* Effect.die("Missing child");
        const stopping = yield* h.stop().pipe(Effect.forkChild);
        yield* Deferred.await(h.abortSent);
        yield* h.settle();
        yield* Fiber.join(stopping);
        yield* h.until((event) => event.type === "turn.terminal");
        yield* h.peer.emit([
          {
            type: "extension_ui_request",
            id: "late-confirm",
            method: "confirm",
            title: "Continue?",
          },
          { type: "message_end", message: { role: "assistant", content: "unowned tail" } },
          { type: "tool_execution_start", toolCallId: "late-tool", toolName: "read", args: {} },
          {
            type: "subagent_lifecycle",
            payload: {
              id: "detached",
              status: "completed",
              output: "Detached final report.",
            },
          },
        ]);
        yield* Deferred.await(replied);
        assert.deepEqual(
          h.peer.state.frames.find((frame) => frame.id === "late-confirm"),
          {
            type: "extension_ui_response",
            id: "late-confirm",
            cancelled: true,
          },
        );
        const finished = yield* h.until(
          (event) =>
            event.type === "subagent.updated" && event.subagent.result === "Detached final report.",
        );
        assert.equal(
          finished.type === "subagent.updated" && finished.subagent.id,
          child.subagent.id,
        );
        assert.equal(finished.type === "subagent.updated" && finished.subagent.status, "completed");
        assert.isTrue(
          h.recorded.some(
            (event) =>
              event.type === "message.updated" && event.message.text === "Detached final report.",
          ),
        );
        assert.equal(h.wakes(), 0);
        assert.isFalse(h.recorded.some((event) => event.type === "runtime_request.updated"));
        assert.isFalse(
          h.recorded.some(
            (event) =>
              (event.type === "message.updated" && event.message.text === "unowned tail") ||
              (event.type === "turn_item.updated" &&
                event.turnItem.type === "dynamic_tool" &&
                event.turnItem.toolName === "read"),
          ),
        );
      }),
    ),
  );

  it.effect.each(["no settlement", "no reply", "command failure"])(
    "kills the owned process on %s",
    (failure) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({
            silentReply: (frame) =>
              failure === "no reply" && frame.type === "abort_and_restore_queue",
            commandError: (frame) =>
              failure === "command failure" && frame.type === "abort_and_restore_queue"
                ? "Abort failed"
                : undefined,
          });
          const stopping = yield* h.stop().pipe(Effect.forkChild);
          yield* Deferred.await(h.abortSent);
          if (failure !== "command failure") yield* TestClock.adjust("3 seconds");
          yield* Fiber.join(stopping);
          const terminal = yield* h.until((event) => event.type === "turn.terminal");
          assert.equal(terminal.type === "turn.terminal" && terminal.threadDisposition, "broken");
          assert.equal(h.peer.state.shutdowns, 1);
          assert.equal(h.peer.state.frames.filter((frame) => frame.type === "abort").length, 0);
          assert.isFalse(yield* h.lockExists());
        }),
      ),
  );

  it.effect.each([false, true])(
    "finishes Stop receipts after caller cancellation with fallback=%s",
    (fallback) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const stopping = yield* h.stop().pipe(Effect.forkChild);
          yield* Deferred.await(h.abortSent);
          const cancelling = yield* Fiber.interrupt(stopping).pipe(Effect.forkChild);
          if (fallback) yield* TestClock.adjust("3 seconds");
          else yield* h.settle();
          yield* Fiber.join(cancelling);
          const terminal = yield* h.until((event) => event.type === "turn.terminal");
          assert.equal(terminal.type === "turn.terminal" && terminal.status, "interrupted");
          assert.equal(
            terminal.type === "turn.terminal" && terminal.threadDisposition,
            fallback ? "broken" : "reusable",
          );
          assert.equal(h.peer.state.shutdowns, fallback ? 1 : 0);
        }),
      ),
  );

  it.effect(
    "reports withdrawn steers and follow-ups before Stop finishes without resending them",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({
            abortResponse: {
              steering: [{ text: "unused steer" }],
              followUp: [{ text: "unused follow-up" }],
              imagesDropped: true,
              truncated: true,
            },
          });
          const active = h.recorded.find((event) => event.type === "provider_turn.updated");
          if (active?.type !== "provider_turn.updated")
            return yield* Effect.die("Missing steer owner");
          yield* h.runtime.steerTurn({
            threadId: ThreadId.make("stop-thread"),
            runId: RunId.make("stop-run-1"),
            providerThread: h.providerThread,
            providerTurnId: active.providerTurn.id,
            message: {
              messageId: MessageId.make("unused-steer"),
              text: "unused steer",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            },
          });
          const stopping = yield* h.stop().pipe(Effect.forkChild);
          yield* Deferred.await(h.abortSent);
          yield* h.settle();
          yield* Fiber.join(stopping);
          yield* h.until((event) => event.type === "turn.terminal");
          const warning = h.recorded.find(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              typeof event.turnItem.output === "string" &&
              event.turnItem.output.includes("unused steer"),
          );
          assert.ok(warning);
          if (warning.type !== "turn_item.updated" || warning.turnItem.type !== "dynamic_tool")
            return;
          assert.include(warning.turnItem.output, "unused follow-up");
          assert.include(warning.turnItem.output, "omitted withdrawn images");
          assert.include(warning.turnItem.output, "omitted some withdrawn messages");
          assert.equal(
            h.peer.state.prompts.filter((prompt) => prompt.frame.type === "prompt").length,
            1,
          );
          assert.equal(
            h.peer.state.prompts.filter((prompt) => prompt.frame.type === "steer").length,
            1,
          );
          assert.equal(h.peer.state.shutdowns, 0);
        }),
      ),
  );
});
