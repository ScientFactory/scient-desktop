import type { SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { type ProviderAdapterV2Event } from "../ProviderAdapter.ts";
import type { ProviderContinuationRequest } from "../ProviderContinuationRequests.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  DEFAULT_CLAUDE_SETTINGS,
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
} from "./ClaudeAdapterV2.fixture.ts";

const WAKE_NATIVE_SESSION = "native-thread-claude-wake";

// Background Bash ids and texts follow the claude_background_task_wake
// recording, so the frames below have the shapes the CLI really sends.
const WAKE_TASK_ID = "bdqirlcyw";

const WAKE_TOOL_USE_ID = "toolu_01Rs6JNNf5SqHRxpq5DeJHrW";

const WAKE_TASK_DESCRIPTION = "Background sleep test";

const WAKE_SUMMARY = 'Background command "Background sleep test" completed (exit code 0)';

const WAKE_ASSISTANT_TEXT = "WAKE_DONE";

const WAKE_RESULT_TEXT = "WAKE_DONE";

function claudeSdkFrame(frame: unknown): SDKMessage {
  if (
    typeof frame !== "object" ||
    frame === null ||
    typeof Reflect.get(frame, "type") !== "string"
  ) {
    throw new Error("Frame is not a Claude Agent SDK message.");
  }
  return frame as SDKMessage;
}

const wakeTaskStarted = claudeSdkFrame({
  type: "system",
  subtype: "task_started",
  task_id: WAKE_TASK_ID,
  tool_use_id: WAKE_TOOL_USE_ID,
  description: WAKE_TASK_DESCRIPTION,
  is_backgrounded: true,
  task_type: "local_bash",
  uuid: "00000000-0000-4000-8000-000000000101",
  session_id: WAKE_NATIVE_SESSION,
});

const makeAssistantTextFrame = (input: { readonly uuid: string; readonly text: string }) =>
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      id: `msg_${input.uuid}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: input.text }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

const makeAssistantErrorFrame = (input: {
  readonly uuid: string;
  readonly error: "authentication_failed" | "rate_limit" | "server_error" | undefined;
  readonly parentToolUseId?: string | null;
}) =>
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      id: `msg_${input.uuid}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Claude could not complete this request." }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: input.parentToolUseId ?? null,
    ...(input.error === undefined ? {} : { error: input.error }),
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

const makeResultFrame = (input: {
  readonly uuid: string;
  readonly result: string;
  readonly numTurns?: number;
  readonly origin?: { readonly kind: "task-notification" };
  readonly subtype?: string;
  readonly isError?: boolean;
  readonly errors?: ReadonlyArray<string>;
  readonly userMessageUuid?: string;
  readonly apiErrorStatus?: number;
  // null omits the field, as the CLI does on a zero-turn result.
  readonly terminalReason?: SDKResultMessage["terminal_reason"] | null;
}) =>
  claudeSdkFrame({
    type: "result",
    subtype: input.subtype ?? "success",
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: input.isError ?? false,
    num_turns: input.numTurns ?? 1,
    result: input.result,
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
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.errors === undefined ? {} : { errors: input.errors }),
    ...(input.userMessageUuid === undefined ? {} : { user_message_uuid: input.userMessageUuid }),
    ...(input.apiErrorStatus === undefined ? {} : { api_error_status: input.apiErrorStatus }),
    ...(input.terminalReason === null
      ? {}
      : { terminal_reason: input.terminalReason ?? "completed" }),
  });

const turnOneResult = makeResultFrame({
  uuid: "00000000-0000-4000-8000-000000000102",
  result: "Kicked off the build in the background.",
});

const wakeNotification = claudeSdkFrame({
  type: "system",
  subtype: "task_notification",
  task_id: WAKE_TASK_ID,
  tool_use_id: WAKE_TOOL_USE_ID,
  status: "completed",
  output_file: `/tmp/claude-replay/tasks/${WAKE_TASK_ID}.output`,
  summary: WAKE_SUMMARY,
  uuid: "00000000-0000-4000-8000-000000000103",
  session_id: WAKE_NATIVE_SESSION,
});

const wakeAssistant = makeAssistantTextFrame({
  uuid: "00000000-0000-4000-8000-000000000107",
  text: WAKE_ASSISTANT_TEXT,
});

const wakeResult = makeResultFrame({
  uuid: "00000000-0000-4000-8000-000000000104",
  result: WAKE_RESULT_TEXT,
  origin: { kind: "task-notification" },
});

const STALE_TASK_NOTIFICATION_RESULT_TEXT =
  "Stale task-notification origin text that must not appear.";

// Shape seen live after interrupt recovery: zero turns, no terminal_reason.
const staleTaskNotificationResult = makeResultFrame({
  uuid: "00000000-0000-4000-8000-000000000106",
  result: STALE_TASK_NOTIFICATION_RESULT_TEXT,
  numTurns: 0,
  origin: { kind: "task-notification" },
  terminalReason: null,
});

const awaitUntil = (predicate: () => boolean, label: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 5000; attempt++) {
      if (predicate()) {
        return;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(`Timed out waiting for ${label}.`);
  });

const makeWakeHarnessWithOptions = (options?: {
  readonly close?: (sdkMessages: Queue.Queue<SDKMessage>) => Effect.Effect<void>;
  readonly interrupt?: Effect.Effect<void>;
  readonly environment?: NodeJS.ProcessEnv;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-claude-v2-wake-",
    });
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const processedMessages = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
    const offerAndWait = Effect.fnUntraced(function* (message: SDKMessage) {
      const processed = yield* Deferred.make<void>();
      processedMessages.set(message, processed);
      yield* Queue.offer(sdkMessages, message);
      yield* Deferred.await(processed);
    });
    const offeredMessages: Array<SDKUserMessage> = [];
    const continuationRequests: Array<ProviderContinuationRequest> = [];
    const terminalReceipts =
      yield* Queue.unbounded<Extract<ProviderAdapterV2Event, { type: "turn.terminal" }>>();
    const systemNoticeReceipts =
      yield* Queue.unbounded<Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>>();
    let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
    const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CLAUDE_SETTINGS,
      environment: options?.environment ?? {},
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
        open: (input) =>
          Effect.sync(() => {
            openedOptions = input.options;
            return {
              messages: Stream.fromQueue(sdkMessages).pipe(
                Stream.flatMap((message) =>
                  Stream.make(message).pipe(
                    // The next pull happens after runForEach finishes handling this frame.
                    Stream.concat(
                      Stream.fromEffect(
                        Effect.suspend(() => {
                          const processed = processedMessages.get(message);
                          return processed === undefined
                            ? Effect.void
                            : Deferred.succeed(processed, undefined);
                        }),
                      ).pipe(Stream.drain),
                    ),
                  ),
                ),
              ),
              offer: (message) =>
                Effect.sync(() => {
                  offeredMessages.push(message);
                }),
              setModel: () => Effect.void,
              interrupt: options?.interrupt ?? Effect.void,
              close: options?.close?.(sdkMessages) ?? Effect.void,
            };
          }),
        forkSession: () => Effect.die("unused forkSession"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make("thread-claude-wake");
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-claude-wake"),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const events: Array<ProviderAdapterV2Event> = [];
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.terminal") {
            yield* Queue.offer(terminalReceipts, event);
          }
          if (event.type === "turn_item.updated" && event.turnItem.type === "system_notice") {
            yield* Queue.offer(systemNoticeReceipts, event);
          }
        }),
      ),
      Effect.forkScoped,
    );
    if (runtime.hasPendingBackgroundWork === undefined) {
      throw new Error("Claude adapter runtime must expose hasPendingBackgroundWork.");
    }
    const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
    const terminalEvents = () =>
      events.filter(
        (event): event is Extract<ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      );
    return {
      runtime,
      providerThread,
      threadId,
      sdkMessages,
      offerAndWait,
      offeredMessages,
      continuationRequests,
      events,
      terminalReceipts,
      systemNoticeReceipts,
      getOpenedOptions: () => openedOptions,
      terminalEvents,
      hasPendingBackgroundWork,
    };
  });

const makeWakeHarness = makeWakeHarnessWithOptions();

const providerThreadRosterEvents = (events: ReadonlyArray<ProviderAdapterV2Event>) =>
  events.filter(
    (event): event is Extract<ProviderAdapterV2Event, { type: "provider_thread.updated" }> =>
      event.type === "provider_thread.updated",
  );

// The CLI sends one frame per content block, each carrying the id of the
// native message it belongs to.
const makeSubagentAssistantFrames = (input: {
  readonly parentToolUseId: string;
  readonly uuid: string;
  readonly messageId?: string;
  readonly text?: string;
  readonly bashToolUseId?: string;
}): ReadonlyArray<SDKMessage> =>
  [
    ...(input.text === undefined ? [] : [{ type: "text", text: input.text }]),
    ...(input.bashToolUseId === undefined
      ? []
      : [
          {
            type: "tool_use",
            id: input.bashToolUseId,
            name: "Bash",
            input: { command: "git log -5" },
          },
        ]),
  ].map((block, index) =>
    claudeSdkFrame({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        id: input.messageId ?? `msg_${input.uuid}`,
        type: "message",
        role: "assistant",
        content: [block],
      },
      parent_tool_use_id: input.parentToolUseId,
      uuid: index === 0 ? input.uuid : `${input.uuid}:${index}`,
      session_id: WAKE_NATIVE_SESSION,
    }),
  );

const makeSubagentToolResultFrame = (input: {
  readonly parentToolUseId: string;
  readonly uuid: string;
  readonly toolUseId: string;
}) =>
  claudeSdkFrame({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: input.toolUseId, content: "ok" }],
    },
    parent_tool_use_id: input.parentToolUseId,
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

const makeSubagentTaskStartedFrame = (input: {
  readonly taskId: string;
  readonly toolUseId: string;
  readonly uuid: string;
}) =>
  claudeSdkFrame({
    type: "system",
    subtype: "task_started",
    task_id: input.taskId,
    tool_use_id: input.toolUseId,
    description: "Audit recent commits",
    subagent_type: "general-purpose",
    is_backgrounded: true,
    task_type: "local_agent",
    prompt: "Audit the last five commits.",
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

const makeSubagentNotificationFrame = (input: {
  readonly taskId: string;
  readonly toolUseId: string;
  readonly summary: string;
  readonly uuid: string;
}) =>
  claudeSdkFrame({
    type: "system",
    subtype: "task_notification",
    task_id: input.taskId,
    tool_use_id: input.toolUseId,
    status: "completed",
    output_file: `/tmp/${input.taskId}.output`,
    summary: input.summary,
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

const subagentRouting = (
  events: ReadonlyArray<ProviderAdapterV2Event>,
  nativeToolIds: ReadonlyArray<string>,
) => {
  const childThreadId =
    events.find((event) => event.type === "subagent.updated")?.subagent.childThreadId ?? undefined;
  const toolThreadIds = new Map<string, Set<string>>();
  for (const event of events) {
    const nativeId =
      event.type === "turn_item.updated" ? event.turnItem.nativeItemRef?.nativeId : undefined;
    if (event.type === "turn_item.updated" && nativeId && nativeToolIds.includes(nativeId)) {
      toolThreadIds.set(
        nativeId,
        (toolThreadIds.get(nativeId) ?? new Set()).add(event.turnItem.threadId),
      );
    }
  }
  const assistantTexts = (threadId: string | undefined) =>
    events.flatMap((event) =>
      event.type === "message.updated" &&
      event.message.role === "assistant" &&
      event.message.threadId === threadId
        ? [event.message.text]
        : [],
    );
  return { childThreadId, toolThreadIds, assistantTexts };
};
export { claudeSdkFrame, awaitUntil, makeResultFrame };

export {
  makeWakeHarness,
  makeAssistantTextFrame,
  WAKE_NATIVE_SESSION,
  wakeAssistant,
  WAKE_ASSISTANT_TEXT,
  makeWakeHarnessWithOptions,
  makeAssistantErrorFrame,
  wakeTaskStarted,
  turnOneResult,
  providerThreadRosterEvents,
  WAKE_TASK_ID,
  wakeNotification,
  wakeResult,
  staleTaskNotificationResult,
  STALE_TASK_NOTIFICATION_RESULT_TEXT,
  WAKE_SUMMARY,
  WAKE_RESULT_TEXT,
  makeSubagentNotificationFrame,
  makeSubagentTaskStartedFrame,
  WAKE_TASK_DESCRIPTION,
  makeSubagentAssistantFrames,
  makeSubagentToolResultFrame,
  subagentRouting,
};
