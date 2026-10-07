import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MessageId, ProviderSessionId, RunAttemptId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { type ProviderAdapterV2Event } from "../ProviderAdapter.ts";
import type { ProviderContinuationRequest } from "../ProviderContinuationRequests.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { makeCapturedStopHarness } from "./ClaudeAdapterV2.stop.testkit.ts";
import {
  CLAUDE_TEST_MODEL_SELECTION,
  isStopInterruptError,
  isStopQueryRunnerError,
  makeClaudeTestTurnInput,
  DEFAULT_CLAUDE_SETTINGS,
  CLAUDE_TEST_RUNTIME_POLICY,
} from "./ClaudeAdapterV2.fixture.ts";
import {
  awaitUntil,
  makeWakeHarnessWithOptions,
  makeResultFrame,
  wakeTaskStarted,
  turnOneResult,
  providerThreadRosterEvents,
  WAKE_TASK_ID,
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  wakeNotification,
  makeAssistantTextFrame,
  WAKE_ASSISTANT_TEXT,
} from "./ClaudeAdapterV2.wake.testkit.ts";
describe("ClaudeAdapterV2 background wake turns", () => {
  it.effect.each([false, true])(
    "refuses delayed native Stop rejection after a newer root settled, replacement=%s",
    (replacement) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeCapturedStopHarness(`settled-newer-${replacement}`);
          yield* Effect.gen(function* () {
            const a = yield* h.start("captured-A");
            const peer = yield* h.start("untouched-peer", CLAUDE_TEST_MODEL_SELECTION, h.peer);
            const stop = yield* h.source.runtime
              .interruptTurn({
                providerThread: h.source.providerThread,
                providerTurnId: a.turnId,
                requestRuntimeRestart: true,
              })
              .pipe(Effect.exit, Effect.forkChild);
            yield* Deferred.await(h.interruptEntered);
            yield* h.settle(a.query, a.turnId);
            assert.lengthOf(h.terminals(a.turnId), 1);
            const selection = replacement
              ? { ...CLAUDE_TEST_MODEL_SELECTION, model: "claude-haiku-4-5-20251001" }
              : CLAUDE_TEST_MODEL_SELECTION;
            const b = yield* h.start("newer-B", selection);
            yield* h.settle(b.query, b.turnId);
            assert.lengthOf(h.terminals(b.turnId), 1);
            const beforeCloses = h.queries.map((q) => q.closes);
            yield* Deferred.succeed(h.interruptRelease, undefined);
            const outcome = yield* Fiber.join(stop);
            assert.isTrue(Exit.isFailure(outcome));
            if (Exit.isSuccess(outcome))
              return yield* Effect.die("Stale Stop unexpectedly succeeded");
            const error = Cause.squash(outcome.cause);
            if (
              !isStopInterruptError(error) ||
              !isStopQueryRunnerError(error.cause) ||
              !(error.cause.cause instanceof AggregateError)
            )
              return yield* Effect.die("Stale refusal lost the original native cause");
            assert.isTrue(
              error.cause.cause.errors.some(
                (cause: unknown) =>
                  isStopQueryRunnerError(cause) &&
                  cause.cause === "Held exact native interrupt rejected",
              ),
            );
            assert.deepEqual(
              h.queries.map((q) => q.closes),
              beforeCloses,
            );
            assert.equal(b.query.closes, 0);
            assert.isFalse(
              h.events.some((e) => e.type === "turn_item.updated" && e.turnItem.type === "error"),
            );
            const c = yield* h.start("usable-C", selection);
            assert.strictEqual(c.query, b.query);
            yield* h.settle(c.query, c.turnId);
            assert.lengthOf(h.terminals(c.turnId), 1);
            yield* h.peer.runtime.steerTurn({
              threadId: h.peer.threadId,
              runId: peer.input.runId,
              providerThread: h.peer.providerThread,
              providerTurnId: peer.turnId,
              message: {
                messageId: MessageId.make("peer-steer"),
                createdBy: "user",
                creationSource: "web",
                text: "Peer still usable",
                attachments: [],
              },
            });
            assert.equal(peer.query.offers.length, 2);
            assert.equal(peer.query.closes, 0);
            assert.equal(peer.query.interrupts, 0);
            yield* h.settle(peer.query, peer.turnId);
            assert.lengthOf(h.terminals(peer.turnId), 1);
          }).pipe(Effect.ensuring(h.save));
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
  );

  it.effect.each(["prepare", "open"] as const)(
    "refuses stale Stop while a newer native start is in flight at %s",
    (phase) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeCapturedStopHarness(`inflight-${phase}`);
          yield* Effect.gen(function* () {
            const a = yield* h.start("inflight-A");
            const stop = yield* h.source.runtime
              .interruptTurn({ providerThread: h.source.providerThread, providerTurnId: a.turnId })
              .pipe(Effect.exit, Effect.forkChild);
            yield* Deferred.await(h.interruptEntered);
            yield* h.settle(a.query, a.turnId);
            h.setPause(phase);
            const selection =
              phase === "open"
                ? { ...CLAUDE_TEST_MODEL_SELECTION, model: "claude-haiku-4-5-20251001" }
                : CLAUDE_TEST_MODEL_SELECTION;
            const start = yield* h.start("inflight-B", selection).pipe(Effect.forkChild);
            yield* Deferred.await(h.pauseEntered);
            const closes = a.query.closes;
            const offers = a.query.offers.length;
            yield* Deferred.succeed(h.interruptRelease, undefined);
            assert.isTrue(Exit.isFailure(yield* Fiber.join(stop)));
            assert.equal(
              a.query.closes,
              closes,
              "stale Stop cannot close over pending native start",
            );
            assert.equal(a.query.offers.length, offers, "pending start has not offered");
            yield* Deferred.succeed(h.pauseRelease, undefined);
            const b = yield* Fiber.join(start);
            yield* h.settle(b.query, b.turnId);
            assert.lengthOf(h.terminals(b.turnId), 1);
            assert.equal(b.query.closes, 0);
          }).pipe(Effect.ensuring(h.save));
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
  );

  it.effect.each([false, true])(
    "fences ordinary reuse and replacement until actual captured-query EOF, closeFails=%s",
    (closeFails) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeCapturedStopHarness(`close-fence-${closeFails}`, closeFails);
          yield* Effect.gen(function* () {
            const a = yield* h.start("fenced-A");
            if (!closeFails) h.setPause("close");
            const stop = yield* h.source.runtime
              .interruptTurn({ providerThread: h.source.providerThread, providerTurnId: a.turnId })
              .pipe(Effect.exit, Effect.forkChild);
            yield* Deferred.await(h.interruptEntered);
            yield* Deferred.succeed(h.interruptRelease, undefined);
            yield* Deferred.await(h.closeEntered);
            if (closeFails) {
              assert.isTrue(Exit.isFailure(yield* Fiber.join(stop)));
              yield* awaitUntil(
                () =>
                  h.events.some(
                    (e) =>
                      e.type === "turn_item.updated" &&
                      e.turnItem.type === "error" &&
                      e.turnItem.providerTurnId === a.turnId,
                  ),
                "truthful owned Stop failure",
              );
              assert.lengthOf(h.terminals(a.turnId), 0);
              const retry = yield* h.source.runtime
                .interruptTurn({
                  providerThread: h.source.providerThread,
                  providerTurnId: a.turnId,
                })
                .pipe(Effect.exit);
              assert.isTrue(Exit.isFailure(retry));
              assert.equal(a.query.closes, 1);
              assert.equal(a.query.interrupts, 1);
            } else yield* Deferred.await(h.pauseEntered);
            yield* h.settle(a.query, a.turnId);
            assert.lengthOf(h.terminals(a.turnId), 1, "genuine root result, not query EOF");
            const opens = h.queries.length;
            const offers = a.query.offers.length;
            for (const model of ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]) {
              const rejected = yield* h
                .start(`blocked-${model}`, { ...CLAUDE_TEST_MODEL_SELECTION, model })
                .pipe(Effect.exit);
              assert.isTrue(Exit.isFailure(rejected));
            }
            assert.equal(h.queries.length, opens);
            assert.equal(a.query.offers.length, offers);
            assert.equal(a.query.closes, 1);
            if (closeFails) yield* Queue.shutdown(a.query.sdkMessages);
            else {
              yield* Deferred.succeed(h.pauseRelease, undefined);
              assert.isTrue(Exit.isSuccess(yield* Fiber.join(stop)));
            }
            yield* awaitUntil(
              () =>
                h.events.some(
                  (e) => e.type === "provider_thread.updated" && e.providerThread.status === "idle",
                ),
              "genuine query exit settlement",
            );
            // The stream consumer's EOF receipt is observed by an ordinary start;
            // yielding lets that existing exact-query finalizer complete.
            let yields = 0;
            yield* awaitUntil(() => ++yields >= 50, "native EOF finalizer");
            const next = yield* h.start("after-real-EOF");
            assert.notStrictEqual(next.query, a.query);
            assert.equal(a.query.closes, 1);
            yield* h.settle(next.query, next.turnId);
            assert.lengthOf(h.terminals(a.turnId), 1);
            assert.lengthOf(h.terminals(next.turnId), 1);
            assert.equal(
              h.events.filter(
                (e) =>
                  e.type === "turn_item.updated" &&
                  e.turnItem.type === "error" &&
                  e.turnItem.providerTurnId === a.turnId,
              ).length,
              closeFails ? 1 : 0,
            );
          }).pipe(Effect.ensuring(h.save));
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
  );

  it.effect("lets the native SDK acknowledge Stop before closing its own query", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let closes = 0;
        let acknowledge = Effect.void;
        const harness = yield* makeWakeHarnessWithOptions({
          interrupt: Effect.suspend(() => {
            assert.equal(closes, 0);
            return acknowledge;
          }),
          close: (messages) =>
            Effect.sync(() => {
              closes++;
            }).pipe(Effect.andThen(Queue.shutdown(messages))),
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("graceful-stop"),
            text: "Work until stopped",
            attachments: [],
          }),
        );
        const userMessageUuid = harness.offeredMessages.at(-1)?.uuid;
        if (userMessageUuid === undefined) return yield* Effect.die("Missing native user message");
        acknowledge = harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000620",
            result: "",
            subtype: "error_during_execution",
            errors: ["Error: Request was aborted."],
            terminalReason: "aborted_streaming",
            userMessageUuid,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" && event.providerTurn.status === "running",
            ),
          "running native turn",
        );
        const active = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        );
        if (active?.type !== "provider_turn.updated")
          return yield* Effect.die("Missing running native turn");
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: active.providerTurn.id,
          requestRuntimeRestart: true,
        });
        assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "interrupted");
        assert.equal(closes, 1);
        assert.lengthOf(harness.terminalEvents(), 1);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("bounds an unacknowledged native Stop and settles its turn once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let closes = 0;
        const interruptStarted = yield* Deferred.make<void>();
        const harness = yield* makeWakeHarnessWithOptions({
          interrupt: Deferred.succeed(interruptStarted, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
          close: (messages) =>
            Effect.sync(() => {
              closes++;
            }).pipe(Effect.andThen(Queue.shutdown(messages))),
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("unacknowledged-stop"),
            text: "Work until stopped",
            attachments: [],
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" && event.providerTurn.status === "running",
            ),
          "running native turn",
        );
        const active = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        );
        if (active?.type !== "provider_turn.updated")
          return yield* Effect.die("Missing running native turn");
        const stop = yield* harness.runtime
          .interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: active.providerTurn.id,
            requestRuntimeRestart: true,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(interruptStarted);
        assert.equal(closes, 0);
        yield* TestClock.adjust("11 seconds");
        assert.isDefined(
          stop.pollUnsafe(),
          "Stop must finish despite a missing SDK acknowledgement",
        );
        yield* Fiber.join(stop);
        assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "interrupted");
        assert.equal(closes, 1);
        assert.lengthOf(harness.terminalEvents(), 1);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("stops background work after the turn settled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let closes = 0;
        const harness = yield* makeWakeHarnessWithOptions({
          close: (sdkMessages) =>
            Effect.sync(() => {
              closes++;
            }).pipe(Effect.andThen(Queue.shutdown(sdkMessages))),
        });
        const now = yield* DateTime.now;
        const attemptId = RunAttemptId.make("attempt-claude-settled-stop");
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId,
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        const settledThread = providerThreadRosterEvents(harness.events).at(-1)?.providerThread;
        assert.equal(settledThread?.pendingBackgroundTasks?.[0]?.taskId, WAKE_TASK_ID);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        // The Waiting strip's Stop reaches the adapter as an interrupt of the
        // settled turn with requestRuntimeRestart.
        yield* harness.runtime.interruptTurn({
          providerThread: settledThread ?? harness.providerThread,
          providerTurnId: harness.terminalEvents()[0]!.providerTurnId,
          requestRuntimeRestart: true,
        });

        assert.equal(closes, 1, "Stop must close the CLI process that owns the task");
        yield* awaitUntil(
          () =>
            (providerThreadRosterEvents(harness.events).at(-1)?.providerThread
              .pendingBackgroundTasks?.length ?? 0) === 0,
          "roster clear after Stop",
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  // The CLI process exits on its own after the turn settled (idle, crash),
  // leaving its background task on the roster. Stop must succeed so the
  // orchestrator goes on to settle what the thread still shows.
  it.effect("a settled Stop with no CLI process left succeeds and clears the roster", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions();
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-settled-stop-no-process"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        const settledThread = providerThreadRosterEvents(harness.events).at(-1)?.providerThread;
        assert.equal(settledThread?.pendingBackgroundTasks?.[0]?.taskId, WAKE_TASK_ID);

        yield* Queue.shutdown(harness.sdkMessages);
        let quietYields = 0;
        yield* awaitUntil(() => quietYields++ >= 50, "query exit");

        yield* harness.runtime.interruptTurn({
          providerThread: settledThread ?? harness.providerThread,
          providerTurnId: harness.terminalEvents()[0]!.providerTurnId,
          requestRuntimeRestart: true,
        });
        yield* awaitUntil(
          () =>
            (providerThreadRosterEvents(harness.events).at(-1)?.providerThread
              .pendingBackgroundTasks?.length ?? 0) === 0,
          "roster clear after Stop",
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("a settled Stop leaves a turn that replaced the closing process alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-settled-stop-replaced-",
        });
        const processQueues: Array<Queue.Queue<SDKMessage>> = [];
        const firstCloseRequested = yield* Deferred.make<void>();
        const events: Array<ProviderAdapterV2Event> = [];
        const continuationRequests: Array<ProviderContinuationRequest> = [];
        const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          idAllocator,
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => {
                continuationRequests.push(request);
              }),
          },
          queryRunner: {
            allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
            open: () =>
              Effect.gen(function* () {
                const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                const isFirstProcess = processQueues.length === 0;
                processQueues.push(sdkMessages);
                return {
                  messages: Stream.fromQueue(sdkMessages),
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  interrupt: Effect.void,
                  // The first CLI process keeps streaming until the test ends
                  // it, so Stop stays parked waiting for it to exit.
                  close: isFirstProcess
                    ? Deferred.succeed(firstCloseRequested, undefined).pipe(Effect.asVoid)
                    : Queue.shutdown(sdkMessages),
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-settled-stop-replaced");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-settled-stop"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.forkScoped,
        );
        if (runtime.hasPendingBackgroundWork === undefined) {
          return yield* Effect.die("Claude adapter runtime must expose hasPendingBackgroundWork.");
        }
        const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
        const terminals = () => events.filter((event) => event.type === "turn.terminal");
        const now = yield* DateTime.now;

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-settled-stop-replaced-a"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(processQueues[0]!, wakeTaskStarted);
        yield* Queue.offer(processQueues[0]!, turnOneResult);
        yield* awaitUntil(() => terminals().length === 1, "first turn terminal");
        const settledThread = providerThreadRosterEvents(events).at(-1)?.providerThread;
        const settledTurn = terminals()[0];
        assert.equal(settledThread?.pendingBackgroundTasks?.[0]?.taskId, WAKE_TASK_ID);

        const stop = yield* runtime
          .interruptTurn({
            providerThread: settledThread ?? providerThread,
            providerTurnId: settledTurn!.providerTurnId,
            requestRuntimeRestart: true,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(firstCloseRequested);

        // While Stop waits for the old CLI to exit, a new turn on another
        // model replaces the process and starts its own background task.
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread: { ...providerThread, status: "active" },
            now,
            attemptId: RunAttemptId.make("attempt-claude-settled-stop-replaced-b"),
            text: "Start another background build.",
            attachments: [],
            providerTurnOrdinal: 2,
            modelSelection: {
              ...CLAUDE_TEST_MODEL_SELECTION,
              model: "claude-haiku-4-5-20251001",
            },
          }),
        );
        assert.lengthOf(processQueues, 2);
        const replacementTaskId = "replacement-task";
        yield* Queue.offer(
          processQueues[1]!,
          claudeSdkFrame({
            ...wakeTaskStarted,
            task_id: replacementTaskId,
            uuid: "00000000-0000-4000-8000-000000000905",
          }),
        );
        yield* awaitUntil(
          () =>
            providerThreadRosterEvents(events).at(-1)?.providerThread.pendingBackgroundTasks?.[0]
              ?.taskId === replacementTaskId,
          "replacement roster",
        );

        yield* Queue.shutdown(processQueues[0]!);
        yield* Fiber.join(stop);
        assert.isTrue(yield* hasPendingBackgroundWork);
        let quietYields = 0;
        yield* awaitUntil(() => quietYields++ >= 50, "late roster events");
        const latestThread = providerThreadRosterEvents(events).at(-1)?.providerThread;
        assert.equal(latestThread?.status, "active");
        assert.deepEqual(
          latestThread?.pendingBackgroundTasks?.map((task) => task.taskId),
          [replacementTaskId],
        );

        // The replacement's background task still wakes Claude once its
        // turn settles.
        yield* Queue.offer(
          processQueues[1]!,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000906",
            result: "Started another build.",
          }),
        );
        yield* awaitUntil(() => terminals().length === 2, "replacement turn terminal");
        yield* Queue.offer(
          processQueues[1]!,
          claudeSdkFrame({
            ...wakeNotification,
            task_id: replacementTaskId,
            uuid: "00000000-0000-4000-8000-000000000907",
          }),
        );
        yield* Queue.offer(
          processQueues[1]!,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000908",
            text: WAKE_ASSISTANT_TEXT,
          }),
        );
        yield* awaitUntil(() => continuationRequests.length === 1, "replacement wake");
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );
});
