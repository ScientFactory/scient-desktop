import * as Crypto from "effect/Crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  ProviderSessionId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { type ProviderAdapterV2Event } from "../ProviderAdapter.ts";
import type { ProviderContinuationRequest } from "../ProviderContinuationRequests.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  makeWakeHarness,
  claudeSdkFrame,
  WAKE_NATIVE_SESSION,
  wakeTaskStarted,
  awaitUntil,
  providerThreadRosterEvents,
  makeResultFrame,
  turnOneResult,
  wakeNotification,
  wakeAssistant,
  makeAssistantTextFrame,
} from "./ClaudeAdapterV2.wake.testkit.ts";
import {
  makeClaudeTestTurnInput,
  DEFAULT_CLAUDE_SETTINGS,
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
} from "./ClaudeAdapterV2.fixture.ts";
describe("ClaudeAdapterV2 background wake turns", () => {
  it.effect("clears the roster when a turn fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const failedResult = claudeSdkFrame({
          type: "result",
          subtype: "error_during_execution",
          duration_ms: 10,
          duration_api_ms: 10,
          is_error: true,
          num_turns: 1,
          result: "boom",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          errors: ["boom"],
          terminal_reason: "model_error",
          uuid: "00000000-0000-4000-8000-000000000203",
          session_id: WAKE_NATIVE_SESSION,
        });

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-roster-fail"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* awaitUntil(
          () =>
            providerThreadRosterEvents(harness.events).some(
              (event) => (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
            ),
          "roster after task_started",
        );
        yield* Queue.offer(harness.sdkMessages, failedResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "failed terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "failed");

        const afterFailure = providerThreadRosterEvents(harness.events).at(-1);
        assert.deepEqual(afterFailure?.providerThread.pendingBackgroundTasks ?? [], []);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect(
    "clears the replaced sibling native thread roster when openQuery switches processes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-sibling-replace-",
          });
          const nativeIds = ["native-thread-roster-a", "native-thread-roster-b"] as const;
          let allocateIndex = 0;
          // Real two-process model: each openQuery owns its own message queue.
          // A shared queue would mask sibling process death on replacement.
          const processQueues: Array<{
            readonly nativeThreadId: string;
            readonly queue: Queue.Queue<SDKMessage>;
          }> = [];
          const events: Array<ProviderAdapterV2Event> = [];
          const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
            crypto: yield* Crypto.Crypto,
            instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
            settings: DEFAULT_CLAUDE_SETTINGS,
            environment: {},
            attachmentsDir,
            fileSystem,
            path: yield* Path.Path,
            idAllocator,
            continuationRequests: {
              offer: () => Effect.void,
            },
            queryRunner: {
              allocateSessionId: Effect.sync(() => {
                const next =
                  nativeIds[allocateIndex] ?? `native-thread-roster-extra-${allocateIndex}`;
                allocateIndex += 1;
                return next;
              }),
              open: (openInput) =>
                Effect.gen(function* () {
                  const nativeThreadId = openInput.options.sessionId ?? openInput.options.resume;
                  if (typeof nativeThreadId !== "string" || nativeThreadId.length === 0) {
                    return yield* Effect.die("openQuery must supply a native session id");
                  }
                  const queue = yield* Queue.unbounded<SDKMessage>();
                  processQueues.push({ nativeThreadId, queue });
                  return {
                    setPermissionMode: () =>
                      Effect.die("Permission-mode mutation is outside this fixture."),
                    messages: Stream.fromQueue(queue),
                    offer: () => Effect.void,
                    setModel: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(queue),
                  };
                }),
              forkSession: () => Effect.die("unused forkSession"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          const appThreadA = ThreadId.make("thread-claude-roster-a");
          const appThreadB = ThreadId.make("thread-claude-roster-b");
          const runtime = yield* adapter.openSession({
            threadId: appThreadA,
            providerSessionId: ProviderSessionId.make("provider-session-claude-sibling-replace"),
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThreadA = yield* runtime.ensureThread({
            threadId: appThreadA,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThreadB = yield* runtime.ensureThread({
            threadId: appThreadB,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          assert.notEqual(
            providerThreadA.nativeThreadRef?.nativeId,
            providerThreadB.nativeThreadRef?.nativeId,
          );
          yield* runtime.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ),
            Effect.forkScoped,
          );
          if (runtime.hasPendingBackgroundWork === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWork.",
            );
          }
          if (runtime.hasPendingBackgroundWorkForThread === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWorkForThread.",
            );
          }
          const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
          const hasPendingBackgroundWorkForThread = runtime.hasPendingBackgroundWorkForThread;
          const now = yield* DateTime.now;
          const taskA = "task-roster-a";
          const taskB = "task-roster-b";

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: appThreadA,
              providerThread: providerThreadA,
              now,
              attemptId: RunAttemptId.make("attempt-roster-iso-a"),
              text: "Background work on A.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 1);
          const processA = processQueues[0]!;
          yield* Queue.offer(
            processA.queue,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: taskA,
              tool_use_id: "toolu-roster-a",
              description: "work on A",
              is_backgrounded: true,
              task_type: "local_bash",
              uuid: "00000000-0000-4000-8000-000000000301",
              session_id: nativeIds[0],
            }),
          );
          yield* Queue.offer(
            processA.queue,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000302",
              result: "A settled with background work.",
            }),
          );
          yield* awaitUntil(
            () =>
              events.some(
                (event) =>
                  event.type === "turn.terminal" &&
                  event.providerThreadId === providerThreadA.id &&
                  event.status === "completed",
              ),
            "thread A terminal",
          );
          const rosterAAfterSettle = providerThreadRosterEvents(events).findLast(
            (event) => event.providerThread.id === providerThreadA.id,
          )?.providerThread.pendingBackgroundTasks;
          assert.deepEqual(rosterAAfterSettle ?? [], [
            { taskId: taskA, description: "work on A", kind: "command" },
          ]);
          assert.isTrue(yield* hasPendingBackgroundWork);
          assert.isTrue(yield* hasPendingBackgroundWorkForThread(providerThreadA));
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadB));

          // Starting B closes A's only live query. A can never emit a roster
          // clear from a dead process, so openQuery must idle-clear A.
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: appThreadB,
              providerThread: { ...providerThreadB, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-roster-iso-b"),
              text: "Background work on B.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 2);
          yield* awaitUntil(
            () =>
              providerThreadRosterEvents(events).some(
                (event) =>
                  event.providerThread.id === providerThreadA.id &&
                  event.providerThread.status === "idle" &&
                  (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0,
              ),
            "sibling A roster cleared idle on process replacement",
          );
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadA));

          const processB = processQueues[1]!;
          yield* Queue.offer(
            processB.queue,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: taskB,
              tool_use_id: "toolu-roster-b",
              description: "work on B",
              is_backgrounded: true,
              task_type: "local_bash",
              uuid: "00000000-0000-4000-8000-000000000303",
              session_id: nativeIds[1],
            }),
          );
          yield* awaitUntil(
            () =>
              providerThreadRosterEvents(events).some(
                (event) =>
                  event.providerThread.id === providerThreadB.id &&
                  (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
              ),
            "thread B roster populated",
          );
          assert.isTrue(yield* hasPendingBackgroundWorkForThread(providerThreadB));
          assert.isTrue(yield* hasPendingBackgroundWork);
          // Starting B's process clears only B's process-scoped level; A stays
          // empty from the sibling replacement clear above.
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadA));

          yield* Queue.offer(
            processB.queue,
            claudeSdkFrame({
              type: "result",
              subtype: "error_during_execution",
              duration_ms: 10,
              duration_api_ms: 10,
              is_error: true,
              num_turns: 1,
              result: "B failed",
              stop_reason: "end_turn",
              total_cost_usd: 0,
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
              modelUsage: {},
              permission_denials: [],
              errors: ["B failed"],
              terminal_reason: "model_error",
              uuid: "00000000-0000-4000-8000-000000000304",
              session_id: nativeIds[1],
            }),
          );
          yield* awaitUntil(
            () =>
              events.some(
                (event) =>
                  event.type === "turn.terminal" &&
                  event.providerThreadId === providerThreadB.id &&
                  event.status === "failed",
              ),
            "thread B failed terminal",
          );

          const rosterBAfterFail = providerThreadRosterEvents(events).findLast(
            (event) => event.providerThread.id === providerThreadB.id,
          )?.providerThread.pendingBackgroundTasks;
          assert.deepEqual(rosterBAfterFail ?? [], []);
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadA));
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadB));
          assert.isFalse(yield* hasPendingBackgroundWork);
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
  );

  it.effect("resets Waiting roster and wake eligibility when the CLI process is replaced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-process-reset-",
        });
        const processQueues: Array<Queue.Queue<SDKMessage>> = [];
        const events: Array<ProviderAdapterV2Event> = [];
        const continuationRequests: Array<ProviderContinuationRequest> = [];
        const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
          crypto: yield* Crypto.Crypto,
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
                processQueues.push(sdkMessages);
                return {
                  setPermissionMode: () =>
                    Effect.die("Permission-mode mutation is outside this fixture."),
                  messages: Stream.fromQueue(sdkMessages),
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  interrupt: Effect.void,
                  // End this process stream so openQuery can replace it.
                  close: Queue.shutdown(sdkMessages),
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-process-reset");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-process-reset"),
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
        const now = yield* DateTime.now;

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-process-reset-a"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        assert.equal(processQueues.length, 1);
        const firstProcess = processQueues[0]!;
        yield* Queue.offer(firstProcess, wakeTaskStarted);
        // The shell leaves the roster before its notification arrives, so
        // nothing runs in this process any more and a model change may
        // replace it. Wake eligibility outlives the empty level.
        yield* Queue.offer(
          firstProcess,
          claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [],
            uuid: "00000000-0000-4000-8000-000000000603",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(firstProcess, turnOneResult);
        yield* awaitUntil(
          () => events.some((event) => event.type === "turn.terminal"),
          "first turn terminal",
        );
        assert.isFalse(yield* hasPendingBackgroundWork);

        const alternateModel = {
          ...CLAUDE_TEST_MODEL_SELECTION,
          model: "claude-haiku-4-5-20251001",
        } satisfies ModelSelection;
        // ProviderTurnStartService marks the thread active before startTurn;
        // the process-reset clear must preserve that status.
        const activeProviderThread = {
          ...providerThread,
          status: "active" as const,
        } satisfies OrchestrationV2ProviderThread;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread: activeProviderThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-process-reset-b"),
            text: "Continue after process restart.",
            attachments: [],
            providerTurnOrdinal: 2,
            modelSelection: alternateModel,
          }),
        );
        assert.equal(processQueues.length, 2);

        // Process-scoped level resets to empty on CLI (re)start while the
        // starting turn's provider thread remains active (not idle).
        yield* awaitUntil(
          () =>
            providerThreadRosterEvents(events).some(
              (event) =>
                event.providerThread.status === "active" &&
                (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0 &&
                // Prefer the post-replace clear over the initial empty thread.
                event.providerThread.updatedAt !== undefined,
            ),
          "roster cleared on process replace while remaining active",
        );
        // After replace, the in-memory Waiting probe must be false even if a
        // late empty-level event was already present before background work.
        assert.isFalse(yield* hasPendingBackgroundWork);
        const emptyActiveRosterEvents = providerThreadRosterEvents(events).filter(
          (event) =>
            event.providerThread.status === "active" &&
            (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0,
        );
        assert.isAtLeast(emptyActiveRosterEvents.length, 1);
        assert.deepEqual(
          emptyActiveRosterEvents.at(-1)?.providerThread.pendingBackgroundTasks ?? [],
          [],
        );
        assert.equal(emptyActiveRosterEvents.at(-1)?.providerThread.status, "active");

        // A late notification from the previous process must not wake after
        // eligibility was reset with the process. Offer on the new process
        // stream (the old queue is shut down).
        const secondProcess = processQueues[1]!;
        yield* Queue.offer(secondProcess, wakeNotification);
        let settleYields = 0;
        yield* awaitUntil(() => settleYields++ >= 50, "stale notification settle");
        assert.lengthOf(continuationRequests, 0);

        yield* Queue.offer(
          secondProcess,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000602",
            result: "Process restart turn finished.",
          }),
        );
        yield* awaitUntil(
          () => events.filter((event) => event.type === "turn.terminal").length === 2,
          "second turn terminal",
        );
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect(
    "clears buffered wake and continuation state when same-native-thread replacement open fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-replace-open-fail-wake-",
          });
          let openCount = 0;
          const processQueues: Array<Queue.Queue<SDKMessage>> = [];
          const events: Array<ProviderAdapterV2Event> = [];
          const continuationRequests: Array<ProviderContinuationRequest> = [];
          const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
            crypto: yield* Crypto.Crypto,
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
              open: () => {
                openCount += 1;
                if (openCount === 2) {
                  return Effect.fail(
                    new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                      method: "open",
                      cause: "forced replacement open failure",
                    }),
                  );
                }
                return Effect.gen(function* () {
                  const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                  processQueues.push(sdkMessages);
                  return {
                    setPermissionMode: () =>
                      Effect.die("Permission-mode mutation is outside this fixture."),
                    messages: Stream.fromQueue(sdkMessages),
                    offer: () => Effect.void,
                    setModel: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(sdkMessages),
                  };
                });
              },
              forkSession: () => Effect.die("unused forkSession"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          const threadId = ThreadId.make("thread-claude-replace-open-fail-wake");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make(
              "provider-session-claude-replace-open-fail-wake",
            ),
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
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWork.",
            );
          }
          const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
          const now = yield* DateTime.now;

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-replace-open-fail-wake-a"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          yield* Queue.offer(processQueues[0]!, wakeTaskStarted);
          yield* Queue.offer(processQueues[0]!, turnOneResult);
          yield* awaitUntil(
            () => events.filter((event) => event.type === "turn.terminal").length === 1,
            "first turn terminal",
          );
          yield* Queue.offer(processQueues[0]!, wakeNotification);
          yield* Queue.offer(processQueues[0]!, wakeAssistant);
          yield* awaitUntil(() => continuationRequests.length === 1, "first continuation request");
          assert.isTrue(yield* hasPendingBackgroundWork);

          const alternateModel = {
            ...CLAUDE_TEST_MODEL_SELECTION,
            model: "claude-haiku-4-5-20251001",
          } satisfies ModelSelection;
          const failedStart = yield* runtime
            .startTurn(
              makeClaudeTestTurnInput({
                threadId,
                providerThread: { ...providerThread, status: "active" },
                now,
                attemptId: RunAttemptId.make("attempt-claude-replace-open-fail-wake-b"),
                text: "Replace process but fail open.",
                attachments: [],
                providerTurnOrdinal: 2,
                modelSelection: alternateModel,
              }),
            )
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(failedStart));
          assert.isFalse(yield* hasPendingBackgroundWork);

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-replace-open-fail-wake-c"),
              text: "Retry after the failed replacement.",
              attachments: [],
              providerTurnOrdinal: 2,
              modelSelection: alternateModel,
            }),
          );
          const retryProcess = processQueues[1]!;
          const retryTaskId = "task-wake-build-after-retry";
          yield* Queue.offer(
            retryProcess,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: retryTaskId,
              tool_use_id: "toolu-wake-build-after-retry",
              description: "npm run build after retry",
              is_backgrounded: true,
              task_type: "local_bash",
              uuid: "00000000-0000-4000-8000-000000000901",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* Queue.offer(
            retryProcess,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000902",
              result: "Kicked off the retry build in the background.",
            }),
          );
          yield* awaitUntil(
            () => events.filter((event) => event.type === "turn.terminal").length === 2,
            "retry turn terminal",
          );
          yield* Queue.offer(
            retryProcess,
            claudeSdkFrame({
              type: "system",
              subtype: "task_notification",
              task_id: retryTaskId,
              tool_use_id: "toolu-wake-build-after-retry",
              status: "completed",
              output_file: "/tmp/task-wake-build-after-retry.log",
              summary: "Retry build completed successfully",
              uuid: "00000000-0000-4000-8000-000000000903",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* Queue.offer(
            retryProcess,
            makeAssistantTextFrame({
              uuid: "00000000-0000-4000-8000-000000000904",
              text: "The retry build has finished.",
            }),
          );
          yield* awaitUntil(
            () => continuationRequests.length === 2,
            "continuation request after retry",
          );
          assert.equal(continuationRequests[1]?.detail, "Retry build completed successfully");
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
  );

  it.effect("does not invent process reset state on a first-ever failed open", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-first-open-fail-",
        });
        const events: Array<ProviderAdapterV2Event> = [];
        const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          idAllocator,
          continuationRequests: {
            offer: () => Effect.void,
          },
          queryRunner: {
            allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
            open: () =>
              Effect.fail(
                new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                  method: "open",
                  cause: "forced first open failure",
                }),
              ),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-first-open-fail");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-first-open-fail"),
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
        const now = yield* DateTime.now;
        const failedStart = yield* runtime
          .startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-first-open-fail"),
              text: "First open fails.",
              attachments: [],
            }),
          )
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(failedStart));
        // No live process ever existed: do not emit a fabricated empty roster.
        assert.lengthOf(providerThreadRosterEvents(events), 0);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );
});
