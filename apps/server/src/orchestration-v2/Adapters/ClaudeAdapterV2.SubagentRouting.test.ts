import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChatAttachmentId, ChatImageAttachment, RunAttemptId, RunId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { type ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  makeWakeHarness,
  makeResultFrame,
  makeSubagentNotificationFrame,
  makeSubagentTaskStartedFrame,
  awaitUntil,
  claudeSdkFrame,
  wakeTaskStarted,
  wakeNotification,
  wakeAssistant,
  WAKE_TASK_DESCRIPTION,
  turnOneResult,
  WAKE_NATIVE_SESSION,
  makeSubagentAssistantFrames,
  wakeResult,
  makeAssistantTextFrame,
  makeSubagentToolResultFrame,
  subagentRouting,
} from "./ClaudeAdapterV2.wake.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeAdapterV2.fixture.ts";
describe("ClaudeAdapterV2 background wake turns", () => {
  it.effect("a subagent re-run in the foreground does not join a later wake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const taskId = "task-foreground-rerun";
        const toolUseId = "toolu_foreground_rerun";
        const userTurn = (attempt: string, providerTurnOrdinal: number) =>
          harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make(attempt),
              text: "Go on.",
              attachments: [],
              providerTurnOrdinal,
            }),
          );
        const result = (uuid: string) => makeResultFrame({ uuid, result: "Done." });
        const ended = (uuid: string) =>
          makeSubagentNotificationFrame({ taskId, toolUseId, summary: "AUDITED", uuid });

        yield* userTurn("attempt-rerun-1", 1);
        yield* Queue.offer(
          harness.sdkMessages,
          makeSubagentTaskStartedFrame({
            taskId,
            toolUseId,
            uuid: "00000000-0000-4000-8000-000000000901",
          }),
        );
        yield* Queue.offer(harness.sdkMessages, result("00000000-0000-4000-8000-000000000902"));
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        // The backgrounded subagent ends idle; its wake names it.
        yield* Queue.offer(harness.sdkMessages, ended("00000000-0000-4000-8000-000000000903"));
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "subagent wake");
        yield* Queue.offer(harness.sdkMessages, result("00000000-0000-4000-8000-000000000904"));
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-rerun-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "wake terminal");

        // A later turn re-runs it in the foreground and starts a background command.
        yield* userTurn("attempt-rerun-3", 3);
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            ...makeSubagentTaskStartedFrame({
              taskId,
              toolUseId,
              uuid: "00000000-0000-4000-8000-000000000905",
            }),
            is_backgrounded: false,
          }),
        );
        yield* Queue.offer(harness.sdkMessages, ended("00000000-0000-4000-8000-000000000906"));
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, result("00000000-0000-4000-8000-000000000907"));
        yield* awaitUntil(() => harness.terminalEvents().length === 3, "third turn terminal");

        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* Queue.offer(harness.sdkMessages, wakeAssistant);
        yield* awaitUntil(() => harness.continuationRequests.length === 2, "command wake");
        assert.equal(
          harness.continuationRequests[1]?.notification?.summary,
          `Command "${WAKE_TASK_DESCRIPTION}" finished`,
        );
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("a turn that fails to start does not expire a queued wake's report", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const userTurn = (
          attempt: string,
          providerTurnOrdinal: number,
          attachments: ProviderAdapterV2TurnInput["message"]["attachments"] = [],
        ) =>
          harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make(attempt),
              text: "Go on.",
              attachments,
              providerTurnOrdinal,
            }),
          );

        yield* userTurn("attempt-failed-start-1", 1);
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        // The command ends idle; Claude has not started its wake yet.
        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        let notificationYields = 0;
        yield* awaitUntil(() => notificationYields++ >= 50, "notification to be recorded");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        // The next prompt names an attachment that is gone, so it never reaches Claude.
        const missing = ChatImageAttachment.make({
          type: "image",
          id: ChatAttachmentId.make("thread-claude-wake-12345678-1234-1234-1234-123456789abc"),
          name: "gone.png",
          mimeType: "image/png",
          sizeBytes: 4,
        });
        const failed = yield* Effect.exit(userTurn("attempt-failed-start-2", 2, [missing]));
        assert.isTrue(Exit.isFailure(failed));

        // The user's next prompt runs before Claude's wake does.
        yield* userTurn("attempt-failed-start-3", 2);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000911", result: "Answered." }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "second turn terminal");

        yield* Queue.offer(harness.sdkMessages, wakeAssistant);
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "command wake");
        assert.equal(
          harness.continuationRequests[0]?.notification?.summary,
          `Command "${WAKE_TASK_DESCRIPTION}" finished`,
        );
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("keeps a subagent a queued wake turn launches with its continuation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const TASK_ID = "a-wake-launched-subagent";
        const TOOL_USE_ID = "toolu_01WakeLaunchedAgent";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const firstAttempt = RunAttemptId.make("attempt-claude-wake-subagent-1");
        const userAttempt = RunAttemptId.make("attempt-claude-wake-subagent-2");
        const continuationAttempt = RunAttemptId.make("attempt-claude-wake-subagent-3");
        const runOf = (attemptId: RunAttemptId) => RunId.make(`run-${attemptId}`);
        const promptUuids = new Map<RunAttemptId, string>();
        const stamp = (frame: SDKMessage, attemptId: RunAttemptId) => {
          const uuid = promptUuids.get(attemptId);
          if (!uuid) throw new Error("Missing actually offered Claude prompt UUID");
          return claudeSdkFrame({ ...frame, user_message_uuid: uuid });
        };

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: firstAttempt,
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* awaitUntil(() => harness.offeredMessages.length === 1, "first prompt offered");
        promptUuids.set(firstAttempt, harness.offeredMessages[0]!.uuid!);
        yield* Queue.offer(harness.sdkMessages, stamp(wakeTaskStarted, firstAttempt));
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000770", result: "STARTED" }),
            firstAttempt,
          ),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");

        // While the user's prompt is queued, the wake turn launches a
        // subagent; its lifecycle and child frames follow the wake turn.
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: userAttempt,
            text: "Reply with exactly: USER_REPLY",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );
        yield* awaitUntil(() => harness.offeredMessages.length === 2, "user prompt offered");
        promptUuids.set(userAttempt, harness.offeredMessages[1]!.uuid!);
        const wakeFrames = [
          wakeNotification,
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_wake_agent",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: TOOL_USE_ID,
                  name: "Agent",
                  input: { description: "Audit recent commits", prompt: "Audit them." },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000771",
            session_id: WAKE_NATIVE_SESSION,
          }),
          makeSubagentTaskStartedFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000772",
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000773",
            text: "AUDIT_DONE",
          }),
          makeSubagentNotificationFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            summary: "AUDIT_DONE",
            uuid: "00000000-0000-4000-8000-000000000774",
          }),
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: TOOL_USE_ID, content: "AUDIT_DONE" }],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000775",
            session_id: WAKE_NATIVE_SESSION,
          }),
          wakeResult,
          stamp(
            makeAssistantTextFrame({
              uuid: "00000000-0000-4000-8000-000000000776",
              text: "USER_REPLY",
            }),
            userAttempt,
          ),
          stamp(
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000777", result: "USER_REPLY" }),
            userAttempt,
          ),
        ];
        for (const frame of wakeFrames) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "user turn terminal");

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: continuationAttempt,
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 3,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 3, "continuation terminal");

        const subagentRuns = harness.events.flatMap((event) =>
          event.type === "subagent.updated" && event.subagent.nativeTaskRef?.nativeId === TASK_ID
            ? [event.subagent.runId]
            : [],
        );
        assert.isNotEmpty(subagentRuns);
        assert.isTrue(subagentRuns.every((runId) => runId === runOf(continuationAttempt)));
        const finalSubagent = harness.events.findLast(
          (event) =>
            event.type === "subagent.updated" && event.subagent.nativeTaskRef?.nativeId === TASK_ID,
        );
        assert.equal(
          finalSubagent?.type === "subagent.updated" && finalSubagent.subagent.status,
          "completed",
        );
        const userRunItems = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.runId === runOf(userAttempt)
            ? [event.turnItem.type]
            : [],
        );
        assert.deepEqual([...new Set(userRunItems)], ["assistant_message"]);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("routes a subagent that starts while the root turn is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const TASK_ID = "task-idle-subagent";
        const TOOL_USE_ID = "toolu-idle-subagent";
        const FINAL_REPORT = "Idle auditor done.";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-idle-subagent-1"),
            text: "Wait for background work.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000331",
            result: "Waiting in the background.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");

        // A native wake turn launches a new subagent while T3 has no turn.
        const idleFrames = [
          makeSubagentTaskStartedFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000332",
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000333",
            text: "Idle auditor working.",
            bashToolUseId: "toolu-idle-bash",
          }),
          makeSubagentToolResultFrame({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000334",
            toolUseId: "toolu-idle-bash",
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000335",
            text: FINAL_REPORT,
          }),
          makeSubagentNotificationFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            summary: FINAL_REPORT,
            uuid: "00000000-0000-4000-8000-000000000336",
          }),
        ];
        for (const frame of idleFrames) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000337",
            result: "The idle auditor finished.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-idle-subagent-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");

        const routing = subagentRouting(harness.events, ["toolu-idle-bash"]);
        assert.isDefined(routing.childThreadId);
        assert.deepEqual(
          [...(routing.toolThreadIds.get("toolu-idle-bash") ?? [])],
          [routing.childThreadId],
        );
        assert.deepEqual(routing.assistantTexts(routing.childThreadId), [
          "Idle auditor working.",
          FINAL_REPORT,
        ]);
        assert.deepEqual(routing.assistantTexts(harness.threadId), [
          "Waiting in the background.",
          "The idle auditor finished.",
        ]);
        const finalSubagent = harness.events.findLast((event) => event.type === "subagent.updated");
        assert.equal(
          finalSubagent?.type === "subagent.updated" && finalSubagent.subagent.status,
          "completed",
        );
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("releases held frames before the notification that first names the tool use", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const TASK_ID = "task-late-tool-use";
        const TOOL_USE_ID = "toolu-late-tool-use";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-late-tool-use"),
            text: "Run an auditor.",
            attachments: [],
          }),
        );
        const frames = [
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: TASK_ID,
            description: "Audit recent commits",
            task_type: "local_agent",
            prompt: "Audit the last five commits.",
            uuid: "00000000-0000-4000-8000-000000000341",
            session_id: WAKE_NATIVE_SESSION,
          }),
          // task_started carried no tool_use_id, so these frames are held
          // until the notification pairs the task with its tool use. The SDK
          // types tool_use_id as optional; no recorded or logged task_started
          // has omitted it, so this guards the typed contract only.
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000342",
            text: "Working.",
          }),
          // The final answer arrives as one snapshot per text block.
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000344",
            messageId: "msg_late_final",
            text: "Part one.",
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000345",
            messageId: "msg_late_final",
            text: "Part two.",
          }),
          makeSubagentNotificationFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            summary: "Part one.\n\nPart two.",
            uuid: "00000000-0000-4000-8000-000000000346",
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000347",
            result: "The auditor finished.",
          }),
        ];
        for (const frame of frames) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "turn terminal");

        const routing = subagentRouting(harness.events, []);
        assert.deepEqual(routing.assistantTexts(routing.childThreadId), [
          "Working.",
          "Part one.",
          "Part two.",
        ]);
        assert.deepEqual(routing.assistantTexts(harness.threadId), ["The auditor finished."]);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("does not resolve a newer API retry when replaying a held subagent frame", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const TOOL_USE_ID = "toolu-retry-subagent";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-retry-subagent"),
            text: "Run an auditor.",
            attachments: [],
          }),
        );
        const frames = [
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000351",
            text: "Held before registration.",
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "api_retry",
            attempt: 2,
            max_retries: 10,
            retry_delay_ms: 1_500,
            error_status: 529,
            error: "overloaded",
            uuid: "00000000-0000-4000-8000-000000000352",
            session_id: WAKE_NATIVE_SESSION,
          }),
          makeSubagentTaskStartedFrame({
            taskId: "task-retry-subagent",
            toolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000353",
          }),
        ];
        for (const frame of frames) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        const childTexts = () => {
          const routing = subagentRouting(harness.events, []);
          return routing.childThreadId === undefined
            ? []
            : routing.assistantTexts(routing.childThreadId);
        };
        yield* awaitUntil(() => childTexts().length === 1, "replayed subagent text");
        const retryStatuses = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.retry !== undefined
            ? [event.turnItem.status]
            : [],
        );
        assert.deepEqual(retryStatuses, ["running"]);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );
});
