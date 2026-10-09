import * as Crypto from "effect/Crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ModelSelection, ProviderSessionId, RunAttemptId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { type ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/continuationRequests";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  DEFAULT_CLAUDE_SETTINGS,
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
} from "./ClaudeAdapterV2.fixture.ts";
import {
  WAKE_NATIVE_SESSION,
  wakeTaskStarted,
  turnOneResult,
  awaitUntil,
  wakeNotification,
  makeResultFrame,
  wakeResult,
  WAKE_SUMMARY,
  WAKE_RESULT_TEXT,
  WAKE_TASK_ID,
  claudeSdkFrame,
} from "./ClaudeAdapterV2.wake.testkit.ts";
describe("ClaudeAdapterV2 background wake turns", () => {
  it.effect(
    "preserves buffered local_bash notification classification across model/policy query replacement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-buffer-replace-",
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
                    close: Queue.shutdown(sdkMessages),
                  };
                }),
              forkSession: () => Effect.die("unused forkSession"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          const threadId = ThreadId.make("thread-claude-buffer-replace");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("provider-session-claude-buffer-replace"),
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
              attemptId: RunAttemptId.make("attempt-claude-buffer-replace-a"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 1);
          const firstProcess = processQueues[0]!;
          yield* Queue.offer(firstProcess, wakeTaskStarted);
          yield* Queue.offer(firstProcess, turnOneResult);
          yield* awaitUntil(
            () => events.some((event) => event.type === "turn.terminal"),
            "first turn terminal",
          );
          assert.isTrue(yield* hasPendingBackgroundWork);

          // Idle completion notification buffers before any continuation runs.
          yield* Queue.offer(firstProcess, wakeNotification);
          let quietYields = 0;
          yield* awaitUntil(() => quietYields++ >= 50, "notification-only quiet window");
          assert.lengthOf(continuationRequests, 0);

          // User turn changes model, replacing the query while the wake buffer
          // stays queued for the later provider continuation.
          const alternateModel = {
            ...CLAUDE_TEST_MODEL_SELECTION,
            model: "claude-haiku-4-5-20251001",
          } satisfies ModelSelection;
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-buffer-replace-user"),
              text: "Switch model while background work completes.",
              attachments: [],
              providerTurnOrdinal: 2,
              modelSelection: alternateModel,
            }),
          );
          assert.equal(processQueues.length, 2);
          const secondProcess = processQueues[1]!;
          yield* Queue.offer(
            secondProcess,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000701",
              result: "User turn finished after model switch.",
            }),
          );
          yield* awaitUntil(
            () => events.filter((event) => event.type === "turn.terminal").length === 2,
            "user turn terminal after replace",
          );
          // The terminal notification remains buffered for classification, but
          // notification-only traffic no longer pins pending work.
          assert.isFalse(yield* hasPendingBackgroundWork);
          assert.lengthOf(continuationRequests, 0);

          // Continuation drains the buffered local_bash notification with no
          // fabricated subagent/node and attributes the wake result text.
          yield* Queue.offer(secondProcess, wakeResult);
          yield* awaitUntil(() => continuationRequests.length === 1, "continuation after result");
          assert.equal(continuationRequests[0]?.detail, WAKE_SUMMARY);
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-buffer-replace-cont"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 3,
              modelSelection: alternateModel,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* awaitUntil(
            () => events.filter((event) => event.type === "turn.terminal").length === 3,
            "continuation terminal after buffered drain",
          );
          assert.isTrue(
            events.some(
              (event) =>
                event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
            ),
          );
          assert.isFalse(
            events.some(
              (event) =>
                event.type === "subagent.updated" ||
                (event.type === "node.updated" && event.node.kind === "subagent"),
            ),
          );
          // Must not re-project the opaque task id as anything but roster history.
          assert.isFalse(
            events.some(
              (event) =>
                event.type !== "provider_thread.updated" &&
                JSON.stringify(event).includes(WAKE_TASK_ID),
            ),
          );
          assert.isFalse(yield* hasPendingBackgroundWork);
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
  );

  it.effect(
    "does not opaque-misclassify a buffered subagent notification across model/policy query replacement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const SUBAGENT_TASK_ID = "task-buffer-replace-subagent";
          const SUBAGENT_TOOL_USE_ID = "toolu-buffer-replace-subagent";
          const SUBAGENT_SUMMARY = "SUB_BUFFER_REPLACE_DONE";
          const subagentTaskStarted = claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: SUBAGENT_TASK_ID,
            tool_use_id: SUBAGENT_TOOL_USE_ID,
            description: "Background research",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Research then return SUB_BUFFER_REPLACE_DONE.",
            uuid: "00000000-0000-4000-8000-000000000801",
            session_id: WAKE_NATIVE_SESSION,
          });
          const subagentNotification = claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: SUBAGENT_TASK_ID,
            tool_use_id: SUBAGENT_TOOL_USE_ID,
            status: "completed",
            output_file: "/tmp/task-buffer-replace-subagent.output",
            summary: SUBAGENT_SUMMARY,
            uuid: "00000000-0000-4000-8000-000000000802",
            session_id: WAKE_NATIVE_SESSION,
          });
          const subagentAsyncAck = claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: SUBAGENT_TOOL_USE_ID,
                  content: [{ type: "text", text: "Async agent launched successfully." }],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000803",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: {
              isAsync: true,
              status: "async_launched",
              agentId: SUBAGENT_TASK_ID,
              prompt: "Research then return SUB_BUFFER_REPLACE_DONE.",
            },
          });

          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-subagent-buffer-replace-",
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
                    close: Queue.shutdown(sdkMessages),
                  };
                }),
              forkSession: () => Effect.die("unused forkSession"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          const threadId = ThreadId.make("thread-claude-subagent-buffer-replace");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make(
              "provider-session-claude-subagent-buffer-replace",
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
          const subagentEvents = () =>
            events.filter(
              (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
                event.type === "subagent.updated",
            );
          const now = yield* DateTime.now;

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-subagent-buffer-replace-a"),
              text: "Spawn a background subagent and stop.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 1);
          const firstProcess = processQueues[0]!;
          yield* Queue.offer(firstProcess, subagentTaskStarted);
          yield* awaitUntil(() => subagentEvents().length >= 1, "subagent node created");
          assert.equal(subagentEvents()[0]?.subagent.status, "running");
          yield* Queue.offer(firstProcess, subagentAsyncAck);
          yield* Queue.offer(
            firstProcess,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000804",
              result: "Spawned the subagent in the background.",
            }),
          );
          yield* awaitUntil(
            () => events.some((event) => event.type === "turn.terminal"),
            "first turn terminal",
          );
          assert.isTrue(yield* hasPendingBackgroundWork);

          // Session-registered subagent completion buffers; no opaque tombstone.
          yield* Queue.offer(firstProcess, subagentNotification);
          yield* awaitUntil(() => continuationRequests.length === 1, "continuation after notify");
          assert.equal(continuationRequests[0]?.detail, SUBAGENT_SUMMARY);

          // Model-changing user turn replaces the query while continuation stays
          // queued. Process reset must not invent opaque classification for the
          // buffered subagent notification.
          const alternateModel = {
            ...CLAUDE_TEST_MODEL_SELECTION,
            model: "claude-haiku-4-5-20251001",
          } satisfies ModelSelection;
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-subagent-buffer-replace-user"),
              text: "Switch model while the subagent completes.",
              attachments: [],
              providerTurnOrdinal: 2,
              modelSelection: alternateModel,
            }),
          );
          assert.equal(processQueues.length, 2);
          const secondProcess = processQueues[1]!;
          yield* Queue.offer(
            secondProcess,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000805",
              result: "User turn finished after model switch.",
            }),
          );
          yield* awaitUntil(
            () => events.filter((event) => event.type === "turn.terminal").length === 2,
            "user turn terminal after replace",
          );
          assert.isTrue(yield* hasPendingBackgroundWork);
          assert.lengthOf(continuationRequests, 1);

          yield* Queue.offer(
            secondProcess,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000806",
              result: "The subagent finished with SUB_BUFFER_REPLACE_DONE.",
            }),
          );
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-subagent-buffer-replace-cont"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 3,
              modelSelection: alternateModel,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* awaitUntil(
            () => events.filter((event) => event.type === "turn.terminal").length === 3,
            "continuation terminal after buffered subagent drain",
          );

          const finalSubagent = subagentEvents().at(-1)?.subagent;
          assert.equal(finalSubagent?.status, "completed");
          assert.equal(finalSubagent?.result, SUBAGENT_SUMMARY);
          assert.equal(finalSubagent?.runId, subagentEvents()[0]?.subagent.runId);
          const subagentNodeEvents = events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "node.updated" }> =>
              event.type === "node.updated" &&
              event.node.kind === "subagent" &&
              event.node.nativeItemRef?.nativeId === SUBAGENT_TASK_ID,
          );
          assert.equal(subagentNodeEvents.at(-1)?.node.status, "completed");
          assert.isFalse(yield* hasPendingBackgroundWork);
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
  );

  it.effect("refuses a model change that would kill a running background subagent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-model-change-running-subagent";
        const SUBAGENT_TOOL_USE_ID = "toolu-model-change-running-subagent";
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-model-change-running-subagent-",
        });
        const processQueues: Array<Queue.Queue<SDKMessage>> = [];
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
          continuationRequests: { offer: () => Effect.void },
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
                  close: Queue.shutdown(sdkMessages),
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-model-change-running-subagent");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-claude-model-change-running-subagent",
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
        const terminals = () => events.filter((event) => event.type === "turn.terminal");
        const now = yield* DateTime.now;

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-model-change-running-subagent-a"),
            text: "Spawn a background subagent and stop.",
            attachments: [],
          }),
        );
        const firstProcess = processQueues[0]!;
        yield* Queue.offer(
          firstProcess,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: SUBAGENT_TASK_ID,
            tool_use_id: SUBAGENT_TOOL_USE_ID,
            description: "Background research",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Research, then report.",
            uuid: "00000000-0000-4000-8000-000000000901",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          firstProcess,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000902",
            result: "Spawned the subagent in the background.",
          }),
        );
        yield* awaitUntil(() => terminals().length === 1, "first turn terminal");
        const settledTurn = terminals()[0]!;

        // The subagent runs inside the first CLI process. Another model needs
        // another process, so the turn must not start and close this one.
        const alternateModel = {
          ...CLAUDE_TEST_MODEL_SELECTION,
          model: "claude-haiku-4-5-20251001",
        } satisfies ModelSelection;
        const switchTurn = (attempt: string) =>
          runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make(attempt),
              text: "Switch model while the subagent runs.",
              attachments: [],
              providerTurnOrdinal: 2,
              modelSelection: alternateModel,
            }),
          );
        const refused = yield* switchTurn("attempt-claude-model-change-running-subagent-b").pipe(
          Effect.flip,
        );
        assert.equal(
          makeProviderFailure({ cause: refused, class: "provider_error" }).message,
          new ClaudeAdapterV2.ClaudeBackgroundWorkBlocksQueryReplacementError().message,
        );
        assert.lengthOf(processQueues, 1);

        // Stop ends the background work, so the switch may replace the process.
        yield* runtime.interruptTurn({
          providerThread,
          providerTurnId: settledTurn.providerTurnId,
          requestRuntimeRestart: true,
        });
        yield* switchTurn("attempt-claude-model-change-running-subagent-c");
        assert.lengthOf(processQueues, 2);

        // The stopped subagent never reports its end, so it must not block
        // later changes on the replacement process either.
        yield* Queue.offer(
          processQueues[1]!,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000903",
            result: "Switched model.",
          }),
        );
        yield* awaitUntil(() => terminals().length === 2, "switched turn terminal");
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread: { ...providerThread, status: "active" },
            now,
            attemptId: RunAttemptId.make("attempt-claude-model-change-running-subagent-d"),
            text: "Switch back.",
            attachments: [],
            providerTurnOrdinal: 3,
          }),
        );
        assert.lengthOf(processQueues, 3);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect(
    "keeps the process and its roster when a model change meets a running background shell",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-replace-open-fail-",
          });
          let openCount = 0;
          const processQueues: Array<Queue.Queue<SDKMessage>> = [];
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
          const threadId = ThreadId.make("thread-claude-replace-open-fail");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("provider-session-claude-replace-open-fail"),
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
              attemptId: RunAttemptId.make("attempt-claude-replace-open-fail-a"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 1);
          yield* Queue.offer(processQueues[0]!, wakeTaskStarted);
          yield* Queue.offer(processQueues[0]!, turnOneResult);
          yield* awaitUntil(
            () => events.some((event) => event.type === "turn.terminal"),
            "first turn terminal",
          );
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
                attemptId: RunAttemptId.make("attempt-claude-replace-open-fail-b"),
                text: "Replace process but fail open.",
                attachments: [],
                providerTurnOrdinal: 2,
                modelSelection: alternateModel,
              }),
            )
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(failedStart));
          // The shell runs in the first process, so it is never closed and
          // no replacement is opened.
          assert.equal(openCount, 1);
          assert.isTrue(yield* hasPendingBackgroundWork);
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
  );
});
