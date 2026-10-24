import type { SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { type ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  DEFAULT_CLAUDE_SETTINGS,
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
} from "./ClaudeAdapterV2.fixture.ts";

const WAKE_NATIVE_SESSION = "native-thread-claude-wake";

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
  readonly stopTask?: (taskId: string) => Effect.Effect<void>;
  readonly settings?: typeof DEFAULT_CLAUDE_SETTINGS;
  readonly environment?: NodeJS.ProcessEnv;
  // A reopened CLI process must not inherit the exited process's message queue.
  readonly freshQueueOnReopen?: boolean;
  /** Synthetic SDK EOF observation; does not signal adapter cleanup completion. */
  readonly onStreamExit?: Effect.Effect<void>;
  readonly forkSession?: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape["forkSession"];
  // SCIENT-FORK:START Scient Extensions native inventory
  readonly onNativeInventory?: ClaudeAdapterV2.ClaudeAdapterV2Options["onNativeInventory"];
  readonly mcpServerStatus?: ClaudeAdapterV2.ClaudeAgentSdkQuerySession["mcpServerStatus"];
  // SCIENT-FORK:END
}) =>
  Effect.gen(function* () {
    const observeStreamExit = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
      options?.onStreamExit === undefined
        ? stream
        : stream.pipe(Stream.ensuring(options.onStreamExit));
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-claude-v2-wake-",
    });
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const processQueues: Array<Queue.Queue<SDKMessage>> = [];
    const processedMessages = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
    const offerAndWait = Effect.fnUntraced(function* (message: SDKMessage) {
      const processed = yield* Deferred.make<void>();
      processedMessages.set(message, processed);
      yield* Queue.offer(sdkMessages, message);
      yield* Deferred.await(processed);
    });
    const offeredMessages: Array<SDKUserMessage> = [];
    const permissionModeChanges: Array<
      ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"]
    > = [];
    const continuationRequests: Array<ProviderContinuationRequest> = [];
    const subagentReceipts =
      yield* Queue.unbounded<Extract<ProviderAdapterV2Event, { type: "subagent.updated" }>>();
    const terminalReceipts =
      yield* Queue.unbounded<Extract<ProviderAdapterV2Event, { type: "turn.terminal" }>>();
    const systemNoticeReceipts =
      yield* Queue.unbounded<Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>>();
    let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: options?.settings ?? DEFAULT_CLAUDE_SETTINGS,
      environment: options?.environment ?? {},
      attachmentsDir,
      fileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator,
      continuationRequests: {
        offer: (request) =>
          Effect.sync(() => {
            continuationRequests.push(request);
          }),
      },
      // SCIENT-FORK:START Scient Extensions native inventory
      ...(options?.onNativeInventory === undefined
        ? {}
        : { onNativeInventory: options.onNativeInventory }),
      // SCIENT-FORK:END
      queryRunner: {
        allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
        open: (input) =>
          Effect.gen(function* () {
            openedOptions = input.options;
            if (options?.freshQueueOnReopen === true && processQueues.length > 0) {
              const processMessages = yield* Queue.unbounded<SDKMessage>();
              processQueues.push(processMessages);
              return {
                messages: observeStreamExit(Stream.fromQueue(processMessages)),
                offer: (message: SDKUserMessage) =>
                  Effect.sync(() => {
                    offeredMessages.push(message);
                  }),
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                stopTask: () => Effect.die("Unexpected workflow task stop in this fixture."),
                backgroundTasks: () => Effect.succeed(false),
                setPermissionMode: () => Effect.void,
                interrupt: Effect.void,
                close: Queue.shutdown(processMessages),
              };
            }
            processQueues.push(sdkMessages);
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
                observeStreamExit,
              ),
              offer: (message) =>
                Effect.sync(() => {
                  offeredMessages.push(message);
                }),
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              stopTask: () => Effect.die("Unexpected workflow task stop in this fixture."),
              backgroundTasks: () => Effect.succeed(false),
              setPermissionMode: (mode) =>
                Effect.sync(() => {
                  permissionModeChanges.push(mode);
                  if (mode !== input.options.permissionMode)
                    throw new Error("Wake fixture may only restore its captured permission mode.");
                }),
              ...(options?.stopTask === undefined ? {} : { stopTask: options.stopTask }),
              interrupt: options?.interrupt ?? Effect.void,
              close: options?.close?.(sdkMessages) ?? Effect.void,
              // SCIENT-FORK:START Scient Extensions native inventory
              ...(options?.mcpServerStatus === undefined
                ? {}
                : { mcpServerStatus: options.mcpServerStatus }),
              // SCIENT-FORK:END
            };
          }),
        forkSession: options?.forkSession ?? (() => Effect.die("unused forkSession")),
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
          if (event.type === "subagent.updated") yield* Queue.offer(subagentReceipts, event);
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
      processQueues,
      offerAndWait,
      offeredMessages,
      promptUuid: (index: number) => {
        const uuid = offeredMessages[index]?.uuid;
        if (uuid === undefined || !ClaudeAdapterV2.isClaudePromptUuid(uuid))
          throw new Error(`No valid prompt offered at index ${index}.`);
        return uuid;
      },
      permissionModeChanges,
      continuationRequests,
      events,
      terminalReceipts,
      subagentReceipts,
      systemNoticeReceipts,
      getOpenedOptions: () => openedOptions,
      terminalEvents,
      hasPendingBackgroundWork,
    };
  });

const makeWakeHarness = makeWakeHarnessWithOptions();

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
export { claudeSdkFrame, awaitUntil, makeResultFrame };

export {
  makeWakeHarness,
  makeAssistantTextFrame,
  WAKE_NATIVE_SESSION,
  makeWakeHarnessWithOptions,
  makeSubagentNotificationFrame,
};
