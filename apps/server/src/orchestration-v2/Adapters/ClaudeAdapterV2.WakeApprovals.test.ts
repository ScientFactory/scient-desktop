import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId, RunId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  makeWakeHarness,
  claudeSdkFrame,
  WAKE_NATIVE_SESSION,
  wakeTaskStarted,
  makeResultFrame,
  awaitUntil,
  wakeNotification,
  wakeResult,
  makeAssistantTextFrame,
  staleTaskNotificationResult,
  STALE_TASK_NOTIFICATION_RESULT_TEXT,
  makeWakeHarnessWithOptions,
} from "./ClaudeAdapterV2.wake.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeAdapterV2.fixture.ts";
describe("ClaudeAdapterV2 background wake turns", () => {
  it.effect.each(["full-access", "approval-required"] as const)(
    "keeps a queued wake turn's tool callback with its continuation in %s mode",
    (runtimeMode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
            runtimeMode,
            interactionMode: "default",
            cwd: "/workspace",
          });
          const firstAttempt = RunAttemptId.make("attempt-claude-wake-callback-1");
          const userAttempt = RunAttemptId.make("attempt-claude-wake-callback-2");
          const continuationAttempt = RunAttemptId.make("attempt-claude-wake-callback-3");
          const planToolUseId = "toolu_01WakePlanExitPlanMode";
          const planMarkdown = "# Wake plan\n\n1. Report the background result.";
          const stamp = (frame: SDKMessage, attemptId: RunAttemptId) =>
            claudeSdkFrame({
              ...frame,
              user_message_uuid: ClaudeAdapterV2.claudePromptUuid(attemptId),
            });
          const runOf = (attemptId: RunAttemptId) => RunId.make(`run-${attemptId}`);
          const planToolUse = claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_wake_plan",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: planToolUseId,
                  name: "ExitPlanMode",
                  input: { plan: planMarkdown },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000741",
            session_id: WAKE_NATIVE_SESSION,
          });
          const planToolResult = claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: planToolUseId,
                  content:
                    "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
                  is_error: true,
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000742",
            session_id: WAKE_NATIVE_SESSION,
          });

          // Turn 1 launches background work and echoes its prompt early.
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: firstAttempt,
              text: "Run the build in the background.",
              attachments: [],
              runtimePolicy,
            }),
          );
          yield* Queue.offer(harness.sdkMessages, stamp(wakeTaskStarted, firstAttempt));
          yield* Queue.offer(
            harness.sdkMessages,
            stamp(
              makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000740", result: "STARTED" }),
              firstAttempt,
            ),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");

          // The task finishes while the user's next prompt is queued, and the
          // CLI runs the wake turn first. That wake turn calls ExitPlanMode,
          // whose permission callback fires between its tool_use and result.
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: userAttempt,
              text: "Reply with exactly: USER_REPLY",
              attachments: [],
              runtimePolicy,
              providerTurnOrdinal: 2,
            }),
          );
          yield* Queue.offer(harness.sdkMessages, wakeNotification);
          yield* Queue.offer(harness.sdkMessages, planToolUse);
          // The SDK asks for permission only after streaming the tool_use.
          yield* awaitUntil(
            () => Queue.sizeUnsafe(harness.sdkMessages) === 0,
            "the tool_use frame to be consumed",
          );
          let settleYields = 0;
          yield* awaitUntil(() => settleYields++ >= 50, "the tool_use frame to be handled");
          const canUseTool = harness.getOpenedOptions()?.canUseTool;
          assert.isFunction(canUseTool);
          const callback = yield* Effect.promise(() =>
            canUseTool!(
              "ExitPlanMode",
              { plan: planMarkdown },
              {
                signal: new AbortController().signal,
                toolUseID: planToolUseId,
                requestId: "request-wake-plan",
              },
            ),
          );
          assert.equal(callback?.behavior, "deny");
          assert.include(
            callback?.behavior === "deny" ? callback.message : "",
            "The client captured your proposed plan",
          );
          yield* Queue.offer(harness.sdkMessages, planToolResult);
          yield* Queue.offer(harness.sdkMessages, wakeResult);
          yield* awaitUntil(
            () => harness.continuationRequests.length === 1,
            "continuation request",
          );

          // The prompt's own turn follows and echoes its uuid.
          yield* Queue.offer(
            harness.sdkMessages,
            stamp(
              makeAssistantTextFrame({
                uuid: "00000000-0000-4000-8000-000000000743",
                text: "USER_REPLY",
              }),
              userAttempt,
            ),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            stamp(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000000744",
                result: "USER_REPLY",
              }),
              userAttempt,
            ),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 2, "user turn terminal");

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: continuationAttempt,
              text: "Background task completed.",
              attachments: [],
              runtimePolicy,
              providerTurnOrdinal: 3,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 3, "continuation terminal");

          const latestItems = new Map(
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated"
                ? [[String(event.turnItem.id), event.turnItem]]
                : [],
            ),
          );
          const planTool = [...latestItems.values()].find(
            (item) =>
              item.type === "dynamic_tool" && item.nativeItemRef?.nativeId === planToolUseId,
          );
          const proposedPlans = [...latestItems.values()].filter(
            (item) => item.type === "proposed_plan",
          );
          const plans = harness.events.flatMap((event) =>
            event.type === "plan.updated" && event.plan.kind === "proposed_plan"
              ? [event.plan]
              : [],
          );
          // Every update of the tool, from start to its (denied) result, is in
          // the continuation run; the user's turn never starts or fails it.
          const planToolRuns = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === planToolUseId &&
            event.turnItem.type === "dynamic_tool"
              ? [event.turnItem.runId]
              : [],
          );
          assert.isNotEmpty(planToolRuns);
          assert.isTrue(planToolRuns.every((runId) => runId === runOf(continuationAttempt)));
          assert.equal(planTool?.runId, runOf(continuationAttempt));
          // Claude was told the plan was captured, so it must be projected.
          assert.lengthOf(proposedPlans, 1);
          assert.equal(proposedPlans[0]?.runId, runOf(continuationAttempt));
          assert.isTrue(plans.length > 0);
          assert.isTrue(plans.every((plan) => plan.runId === runOf(continuationAttempt)));
          // Nothing from the wake turn reached the user's run.
          const userRunItems = [...latestItems.values()].filter(
            (item) => item.runId === runOf(userAttempt),
          );
          assert.deepEqual(
            userRunItems.map((item) => item.type),
            ["assistant_message"],
          );
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
  );

  it.effect("answers an approval a held wake turn raises without waiting for the echo", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const approvalPolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const firstAttempt = RunAttemptId.make("attempt-claude-wake-approval-1");
        const userAttempt = RunAttemptId.make("attempt-claude-wake-approval-2");
        const bashToolUseId = "toolu_01WakeApprovalBash";
        const stamp = (frame: SDKMessage, attemptId: RunAttemptId) =>
          claudeSdkFrame({
            ...frame,
            user_message_uuid: ClaudeAdapterV2.claudePromptUuid(attemptId),
          });

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: firstAttempt,
            text: "First.",
            attachments: [],
            runtimePolicy: approvalPolicy,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000780", text: "One." }),
            firstAttempt,
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000781", result: "One." }),
            firstAttempt,
          ),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: userAttempt,
            text: "Second.",
            attachments: [],
            providerTurnOrdinal: 2,
            runtimePolicy: approvalPolicy,
          }),
        );
        // A queued wake turn asks to run Bash while its output is held.
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_wake_bash",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: bashToolUseId,
                  name: "Bash",
                  input: { command: "git status" },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000782",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () => Queue.sizeUnsafe(harness.sdkMessages) === 0,
          "the tool_use frame to be consumed",
        );
        let settleYields = 0;
        yield* awaitUntil(() => settleYields++ >= 50, "the tool_use frame to be held");
        const permission = yield* Effect.promise(() =>
          harness.getOpenedOptions()!.canUseTool!(
            "Bash",
            { command: "git status" },
            {
              signal: new AbortController().signal,
              toolUseID: bashToolUseId,
              requestId: "request-wake-bash",
            },
          ),
        ).pipe(Effect.forkScoped);

        // The request is raised at once, releasing the held output to the
        // pending prompt turn (where it went before output was held), so the
        // user can answer it and the SDK is not left waiting on the echo.
        yield* awaitUntil(
          () => harness.events.some((event) => event.type === "runtime_request.updated"),
          "the approval request",
        );
        const request = harness.events.findLast(
          (event) => event.type === "runtime_request.updated",
        );
        const bashItems = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === bashToolUseId
            ? [event.turnItem.runId]
            : [],
        );
        assert.isNotEmpty(bashItems);
        assert.isTrue(bashItems.every((runId) => runId === RunId.make(`run-${userAttempt}`)));
        if (request?.type !== "runtime_request.updated") return;
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: request.runtimeRequest.id,
          decision: "accept",
        });
        const result = yield* Fiber.join(permission);
        assert.equal(result?.behavior, "allow");
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("drops a zero-turn task-notification result while awaiting a prompt echo", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const firstAttempt = RunAttemptId.make("attempt-claude-echo-debris-1");
        const secondAttempt = RunAttemptId.make("attempt-claude-echo-debris-2");
        const stamp = (frame: SDKMessage, attemptId: RunAttemptId) =>
          claudeSdkFrame({
            ...frame,
            user_message_uuid: ClaudeAdapterV2.claudePromptUuid(attemptId),
          });

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: firstAttempt,
            text: "First.",
            attachments: [],
          }),
        );
        // The first turn echoes on its first frame: this process echoes early.
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000760", text: "One." }),
            firstAttempt,
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000761", result: "One." }),
            firstAttempt,
          ),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: secondAttempt,
            text: "Second.",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );
        // Lifecycle debris ahead of the prompt's own turn: a stale wake's
        // unstamped output, then its zero-turn result.
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000764", text: "Stale." }),
        );
        yield* Queue.offer(harness.sdkMessages, staleTaskNotificationResult);
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000762", text: "Two." }),
            secondAttempt,
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000763", result: "Two." }),
            secondAttempt,
          ),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "second turn terminal");
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.lengthOf(harness.continuationRequests, 0);
        // The debris' held output is released to the prompt's turn with its
        // echo, as it streamed before the gate existed.
        assert.deepEqual(
          harness.events.flatMap((event) =>
            event.type === "message.updated" && event.message.role === "assistant"
              ? [event.message.text]
              : [],
          ),
          ["One.", "Stale.", "Two."],
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "message.updated" &&
              event.message.text === STALE_TASK_NOTIFICATION_RESULT_TEXT,
          ),
        );
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("releases output held for a prompt echo when the stream ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({
          close: (sdkMessages) => Queue.shutdown(sdkMessages),
        });
        const now = yield* DateTime.now;
        const firstAttempt = RunAttemptId.make("attempt-claude-echo-1");
        const secondAttempt = RunAttemptId.make("attempt-claude-echo-2");
        const stamp = (frame: SDKMessage, attemptId: RunAttemptId) =>
          claudeSdkFrame({
            ...frame,
            user_message_uuid: ClaudeAdapterV2.claudePromptUuid(attemptId),
          });
        const assistantTexts = () =>
          harness.events.flatMap((event) =>
            event.type === "message.updated" && event.message.role === "assistant"
              ? [event.message.text]
              : [],
          );

        // The first turn echoes its prompt uuid on its first frame, so this
        // CLI process is known to echo early.
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: firstAttempt,
            text: "First.",
            attachments: [],
          }),
        );
        assert.equal(
          harness.offeredMessages[0]?.uuid,
          ClaudeAdapterV2.claudePromptUuid(firstAttempt),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000701", text: "One." }),
            firstAttempt,
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000702", result: "One." }),
            firstAttempt,
          ),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");

        // The second turn's first frame carries no echo, so it is held; the
        // stream then dies before any result.
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: secondAttempt,
            text: "Second.",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000703", text: "Two." }),
        );
        let heldYields = 0;
        yield* awaitUntil(() => heldYields++ >= 50, "unechoed frame to be held");
        assert.deepEqual(assistantTexts(), ["One."]);

        yield* Queue.shutdown(harness.sdkMessages);
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "second turn terminal");
        assert.deepEqual(assistantTexts(), ["One.", "Two."]);
        assert.equal(harness.terminalEvents()[1]?.status, "failed");
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );
});
