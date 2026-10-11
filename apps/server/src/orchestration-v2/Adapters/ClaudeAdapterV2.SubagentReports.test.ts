import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { type ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  makeWakeHarness,
  makeSubagentAssistantFrames,
  makeSubagentToolResultFrame,
  makeSubagentTaskStartedFrame,
  claudeSdkFrame,
  WAKE_NATIVE_SESSION,
  makeSubagentNotificationFrame,
  makeResultFrame,
  awaitUntil,
  subagentRouting,
} from "./ClaudeAdapterV2.wake.testkit.ts";
import {
  makeClaudeTestTurnInput,
  CLAUDE_TEST_MODEL_SELECTION,
  encodeJsonString,
} from "./ClaudeAdapterV2.fixture.ts";
describe("ClaudeAdapterV2 background wake turns", () => {
  it.effect("holds subagent frames that precede task_started and shows its result once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const TASK_ID = "task-early-subagent";
        const TOOL_USE_ID = "toolu-early-subagent";
        const FINAL_REPORT = "Early auditor done.";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-early-subagent"),
            text: "Run an auditor.",
            attachments: [],
          }),
        );
        const frames = [
          // The SDK can forward child frames before the task_started that
          // registers their subagent.
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000321",
            text: "Starting early.",
            bashToolUseId: "toolu-early-bash",
          }),
          makeSubagentToolResultFrame({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000322",
            toolUseId: "toolu-early-bash",
          }),
          makeSubagentTaskStartedFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000323",
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000324",
            text: "Still working.",
          }),
          // Progress without a tool_use_id replaces the subagent entry while
          // the per-turn tool-use alias still points at the previous one.
          claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: TASK_ID,
            description: "Checking the diffs",
            uuid: "00000000-0000-4000-8000-000000000325",
            session_id: WAKE_NATIVE_SESSION,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000326",
            text: FINAL_REPORT,
          }),
          makeSubagentNotificationFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            summary: FINAL_REPORT,
            uuid: "00000000-0000-4000-8000-000000000327",
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000328",
            result: "The auditor finished.",
          }),
        ];
        for (const frame of frames) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "turn terminal");

        const routing = subagentRouting(harness.events, ["toolu-early-bash"]);
        assert.isDefined(routing.childThreadId);
        assert.deepEqual(
          [...(routing.toolThreadIds.get("toolu-early-bash") ?? [])],
          [routing.childThreadId],
        );
        assert.deepEqual(routing.assistantTexts(routing.childThreadId), [
          "Starting early.",
          "Still working.",
          FINAL_REPORT,
        ]);
        assert.deepEqual(routing.assistantTexts(harness.threadId), ["The auditor finished."]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );

  it.effect.each(["requested", "observed-before", "observed-after", "inherit", "unknown"] as const)(
    "records the subagent model from %s without inheriting the parent override",
    (source) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const toolUseId = "toolu-subagent-model";
          const parentModel = "claude-opus-4-6";
          const observedModel = "claude-haiku-4-5-20251001";
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-subagent-model"),
              text: "Spawn a Haiku subagent.",
              attachments: [],
              modelSelection: { ...CLAUDE_TEST_MODEL_SELECTION, model: parentModel },
            }),
          );
          const observed = claudeSdkFrame({
            type: "assistant",
            parent_tool_use_id: toolUseId,
            message: {
              model: observedModel,
              id: "msg_subagent_model_observed",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "Solving." }],
            },
            uuid: "00000000-0000-4000-8000-000000000206",
            session_id: WAKE_NATIVE_SESSION,
          });
          if (source === "observed-before") yield* Queue.offer(harness.sdkMessages, observed);
          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "assistant",
              parent_tool_use_id: null,
              message: {
                model: parentModel,
                id: "msg_subagent_model_launch",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: toolUseId,
                    name: "Agent",
                    input: {
                      description: "Haiku puzzle",
                      subagent_type: "general-purpose",
                      ...(source === "unknown"
                        ? {}
                        : { model: source === "inherit" ? "inherit" : "haiku" }),
                      prompt: "Solve the puzzle.",
                    },
                  },
                ],
              },
              uuid: "00000000-0000-4000-8000-000000000209",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: "task-subagent-model",
              tool_use_id: toolUseId,
              description: "Haiku puzzle",
              task_type: "local_agent",
              uuid: "00000000-0000-4000-8000-000000000207",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          if (source === "observed-after") yield* Queue.offer(harness.sdkMessages, observed);
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000208",
              result: "Spawned the subagent.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          const subagents = harness.events.filter((event) => event.type === "subagent.updated");
          const initialModel =
            source === "observed-before"
              ? observedModel
              : source === "inherit"
                ? parentModel
                : source === "unknown"
                  ? null
                  : "haiku";
          assert.equal(subagents[0]?.subagent.model, initialModel);
          assert.equal(
            subagents.at(-1)?.subagent.model,
            source.startsWith("observed") ? observedModel : initialModel,
          );
          const child = harness.events.find((event) => event.type === "app_thread.created");
          assert.equal(child?.appThread.modelSelection?.model, initialModel ?? parentModel);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
  );

  it.effect("extracts text from direct content-block subagent results", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-direct-content-blocks";
        const SUBAGENT_TOOL_USE_ID = "toolu-direct-content-blocks";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const subagentEvents = () =>
          harness.events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
              event.type === "subagent.updated",
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-direct-content-blocks"),
            text: "Delegate this task.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: SUBAGENT_TASK_ID,
            tool_use_id: SUBAGENT_TOOL_USE_ID,
            description: "Delegated task",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Return the result.",
            uuid: "00000000-0000-4000-8000-000000000206",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(() => subagentEvents().length === 1, "subagent node created");

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: SUBAGENT_TOOL_USE_ID,
                  content: [
                    { type: "text", text: "First line." },
                    { type: "text", text: "Second line." },
                  ],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000207",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () => subagentEvents().at(-1)?.subagent.status === "completed",
          "subagent terminal",
        );

        assert.equal(subagentEvents().at(-1)?.subagent.result, "First line.\nSecond line.");

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000208",
            result: "Delegation completed.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "turn terminal");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );

  it.effect("releases the idle pin when a post-settle subagent stops without completing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-wake-subagent-stopped";
        const subagentTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: "toolu-wake-subagent-stopped",
          description: "Long-running research task",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Investigate the flaky test.",
          uuid: "00000000-0000-4000-8000-000000000301",
          session_id: WAKE_NATIVE_SESSION,
        });
        const subagentStoppedNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: "toolu-wake-subagent-stopped",
          status: "stopped",
          output_file: "/tmp/task-wake-subagent-stopped.output",
          summary: "Agent was stopped before finishing.",
          uuid: "00000000-0000-4000-8000-000000000302",
          session_id: WAKE_NATIVE_SESSION,
        });

        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const subagentEvents = () =>
          harness.events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
              event.type === "subagent.updated",
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-7a"),
            text: "Spawn a background subagent and stop.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, subagentTaskStarted);
        yield* awaitUntil(() => subagentEvents().length >= 1, "subagent node created");
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000303",
            result: "Spawned the subagent in the background.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(harness.sdkMessages, subagentStoppedNotification);
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000304",
            result: "The subagent was stopped.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-7b"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");

        assert.equal(subagentEvents().at(-1)?.subagent.status, "cancelled");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );

  it.effect("re-opens a resumed subagent whose task_started races past settle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-resume-postsettle";
        const SUBAGENT_TOOL_USE_ID = "toolu-resume-postsettle";
        const RESUME_TOOL_USE_ID = "toolu-resume-postsettle-sendmessage";
        const FIRST_SUMMARY = "Answered early.";
        const SECOND_SUMMARY = "RESUME_SETTLE_DONE";
        const subagentTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          description: "Sleep then echo done token",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Run the shell command, then return exactly RESUME_SETTLE_DONE.",
          uuid: "00000000-0000-4000-8000-000000000501",
          session_id: WAKE_NATIVE_SESSION,
        });
        const firstNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          status: "completed",
          output_file: "/tmp/task-resume-postsettle.output",
          summary: FIRST_SUMMARY,
          uuid: "00000000-0000-4000-8000-000000000502",
          session_id: WAKE_NATIVE_SESSION,
        });
        const resumeTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: RESUME_TOOL_USE_ID,
          description: "Sleep then echo done token",
          is_backgrounded: true,
          task_type: "local_agent",
          uuid: "00000000-0000-4000-8000-000000000505",
          session_id: WAKE_NATIVE_SESSION,
        });
        // As recorded in claude_background_subagent_lifecycle: the resumed
        // run's notification carries the SendMessage call's tool_use_id.
        const secondNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: RESUME_TOOL_USE_ID,
          status: "completed",
          output_file: "/tmp/task-resume-postsettle.output",
          summary: SECOND_SUMMARY,
          uuid: "00000000-0000-4000-8000-000000000506",
          session_id: WAKE_NATIVE_SESSION,
        });

        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const subagentEvents = () =>
          harness.events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
              event.type === "subagent.updated",
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-9a"),
            text: "Spawn a background subagent and stop.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, subagentTaskStarted);
        yield* awaitUntil(() => subagentEvents().length >= 1, "subagent node created");
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000503",
            result: "Spawned the subagent in the background.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");

        yield* Queue.offer(harness.sdkMessages, firstNotification);
        yield* awaitUntil(
          () => harness.continuationRequests.length === 1,
          "first continuation request",
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000504",
            result: "The subagent answered early.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-9b"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");
        assert.equal(subagentEvents().at(-1)?.subagent.status, "completed");
        assert.equal(subagentEvents().at(-1)?.subagent.result, FIRST_SUMMARY);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        // The resume task_started races past settle: no turn is active, so it
        // must re-open the session registry entry (pinning idle again) and
        // buffer for replay. Its notification then counts as wake evidence
        // and carries the new summary as the continuation detail. The resume
        // rides on a SendMessage tool call whose frames race past settle too;
        // on drain replay the SendMessage tool_result is a delivery ACK and
        // must not terminalize the re-opened subagent.
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_resume_postsettle_sendmessage",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: RESUME_TOOL_USE_ID,
                  name: "SendMessage",
                  input: {
                    to: SUBAGENT_TASK_ID,
                    summary: "Resume the subagent",
                    message: "Continue and return the token.",
                  },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000508",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(harness.sdkMessages, resumeTaskStarted);
        // Shaped like the recorded SendMessage ACK in
        // claude_background_subagent_lifecycle: the text block is the JSON of
        // tool_use_result, and "message" names the agent's short id.
        const resumeAck = {
          success: true,
          message: `Resuming agent ${SUBAGENT_TASK_ID.slice(0, 7)}`,
          resumedAgentId: SUBAGENT_TASK_ID,
          pin: { id: SUBAGENT_TASK_ID, name: SUBAGENT_TASK_ID, ref: "42ab31" },
        };
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  tool_use_id: RESUME_TOOL_USE_ID,
                  type: "tool_result",
                  content: [
                    {
                      type: "text",
                      text: encodeJsonString(resumeAck),
                    },
                  ],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000509",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: resumeAck,
          }),
        );
        yield* Queue.offer(harness.sdkMessages, secondNotification);
        yield* awaitUntil(
          () => harness.continuationRequests.length === 2,
          "second continuation request",
        );
        assert.equal(harness.continuationRequests[1]?.detail, SECOND_SUMMARY);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000507",
            result: "The subagent finished with RESUME_SETTLE_DONE.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-9c"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 3,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(
          () => harness.terminalEvents().length === 3,
          "resume continuation terminal",
        );

        // The drained replay re-opens the row (running, stale result cleared)
        // before the second notification terminalizes it again.
        const statuses = subagentEvents().map((event) => event.subagent.status);
        const firstCompleted = statuses.indexOf("completed");
        const reopenedIndex = statuses.lastIndexOf("running");
        assert.isAbove(reopenedIndex, firstCompleted);
        assert.isNull(subagentEvents()[reopenedIndex]?.subagent.result);
        // The drain-replayed reopen re-attributes the subagent to the
        // continuation run performing the replay, so that run's ingestion
        // fiber routes the resumed lifecycle and lingers past settle until
        // the resumed task completes.
        assert.equal(subagentEvents()[reopenedIndex]?.subagent.runId, "run-attempt-claude-wake-9c");
        // The execution node re-opens too, even though the registry entry was
        // already pre-opened by the wake buffer before the drain replay.
        const nodeStatuses = harness.events
          .filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "node.updated" }> =>
              event.type === "node.updated" &&
              event.node.kind === "subagent" &&
              event.node.nativeItemRef?.nativeId === SUBAGENT_TASK_ID,
          )
          .map((event) => event.node.status);
        assert.isAbove(nodeStatuses.lastIndexOf("running"), nodeStatuses.indexOf("completed"));
        const finalSubagent = subagentEvents().at(-1)?.subagent;
        assert.equal(finalSubagent?.status, "completed");
        assert.equal(finalSubagent?.result, SECOND_SUMMARY);
        // The completion keeps the resuming run's attribution.
        assert.equal(finalSubagent?.runId, "run-attempt-claude-wake-9c");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );
});
