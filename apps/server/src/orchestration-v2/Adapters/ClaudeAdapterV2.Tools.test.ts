import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as IdAllocator from "../IdAllocator.ts";
import {
  makeWakeHarness,
  claudeSdkFrame,
  WAKE_NATIVE_SESSION,
  makeResultFrame,
  wakeTaskStarted,
  turnOneResult,
  awaitUntil,
  providerThreadRosterEvents,
  WAKE_TASK_ID,
} from "./ClaudeAdapterV2.wake.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeAdapterV2.fixture.ts";
describe("ClaudeAdapterV2 background wake turns", () => {
  it.effect("retains image preview paths on Claude Read tool completion", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-read-images"),
          text: "Read the files",
          attachments: [],
        }),
      );
      const tools = [
        { id: "image", name: "Read", input: { file_path: " /workspace/reference.png " } },
        { id: "text", name: "Read", input: { file_path: "/workspace/README.md" } },
        { id: "search", name: "Grep", input: { pattern: "TODO", path: "/workspace/src" } },
        {
          id: "write",
          name: "Write",
          input: { file_path: "/workspace/output.png", content: "text" },
        },
      ];
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "assistant",
          uuid: "00000000-0000-4000-8000-000000000601",
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          message: {
            id: "msg_image_reads",
            model: "claude-sonnet-4-6",
            type: "message",
            role: "assistant",
            content: tools.map((tool) => ({ type: "tool_use", ...tool })),
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "user",
          uuid: "00000000-0000-4000-8000-000000000602",
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: tools.map((tool) => ({
              type: "tool_result",
              tool_use_id: tool.id,
              content: "ok",
            })),
          },
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000603", result: "Read files" }),
      );
      yield* Queue.take(harness.terminalReceipts);
      const items = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.status === "completed"
          ? [event.turnItem]
          : [],
      );
      const image = items.find((item) => item.nativeItemRef?.nativeId === "image");
      assert.equal(image?.type, "dynamic_tool");
      if (image?.type === "dynamic_tool")
        assert.equal(image.viewedImagePath, "/workspace/reference.png");
      assert.equal(image?.title, "Read /workspace/reference.png");
      assert.equal(
        items.find((item) => item.nativeItemRef?.nativeId === "text")?.title,
        "Read /workspace/README.md",
      );
      assert.equal(
        items.find((item) => item.nativeItemRef?.nativeId === "search")?.title,
        "Searched TODO in src",
      );
      for (const item of items.filter((item) => item.nativeItemRef?.nativeId !== "image"))
        assert.notProperty(item, "viewedImagePath");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  );

  it.effect("preserves typed Claude plans and todos through generic tool completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const assistantTools = (
          uuid: string,
          tools: ReadonlyArray<Record<string, unknown>>,
          parentToolUseId: string | null = null,
        ) =>
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: `msg_${uuid}`,
              type: "message",
              role: "assistant",
              content: tools.map((tool) => ({ type: "tool_use", ...tool })),
              stop_reason: "tool_use",
              stop_sequence: null,
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            },
            parent_tool_use_id: parentToolUseId,
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          });
        const toolResults = (uuid: string, toolUseIds: ReadonlyArray<string>) =>
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: toolUseIds.map((toolUseId) => ({
                type: "tool_result",
                tool_use_id: toolUseId,
                content: "ok",
              })),
            },
            parent_tool_use_id: null,
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          });

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-plan-lifecycle-1"),
            text: "Plan the work.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          assistantTools("00000000-0000-4000-8000-000000000501", [
            {
              id: "tool-todo-1",
              name: "TodoWrite",
              input: { todos: [{ content: "Inspect", status: "in_progress" }] },
            },
          ]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          assistantTools("00000000-0000-4000-8000-000000000501", [
            {
              id: "tool-todo-1",
              name: "TodoWrite",
              input: { todos: [{ content: "Inspect", status: "in_progress" }] },
            },
          ]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          toolResults("00000000-0000-4000-8000-000000000502", ["tool-todo-1"]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000503",
            result: "Todo recorded.",
          }),
        );
        yield* Queue.take(harness.terminalReceipts);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-plan-lifecycle-2"),
            providerTurnOrdinal: 2,
            text: "Finish the plan.",
            attachments: [],
          }),
        );
        const canUseTool = harness.getOpenedOptions()?.canUseTool;
        assert.isFunction(canUseTool);
        const planMarkdown = "# Ready to implement\n\n1. Ship it.";
        yield* Effect.promise(() =>
          canUseTool!(
            "ExitPlanMode",
            { plan: planMarkdown },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-exit-plan-1",
              requestId: "request-exit-plan-1",
            },
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          assistantTools("00000000-0000-4000-8000-000000000504", [
            {
              id: "tool-todo-2",
              name: "TodoWrite",
              input: { todos: [{ content: "Inspect", status: "completed" }] },
            },
            { id: "tool-exit-plan-1", name: "ExitPlanMode", input: { plan: planMarkdown } },
          ]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          assistantTools(
            "00000000-0000-4000-8000-000000000507",
            [
              {
                id: "tool-subagent-todo",
                name: "TodoWrite",
                input: { todos: [{ content: "Child-only work", status: "in_progress" }] },
              },
            ],
            "tool-parent-agent",
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          toolResults("00000000-0000-4000-8000-000000000505", ["tool-todo-2", "tool-exit-plan-1"]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000506",
            result: "Plan captured.",
          }),
        );
        yield* Queue.take(harness.terminalReceipts);

        const items = new Map(
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" ? [[String(event.turnItem.id), event.turnItem]] : [],
          ),
        );
        const plans = new Map(
          harness.events.flatMap((event) =>
            event.type === "plan.updated" ? [[String(event.plan.id), event.plan]] : [],
          ),
        );
        const todoItems = [...items.values()].filter((item) => item.type === "todo_list");
        const proposedItems = [...items.values()].filter((item) => item.type === "proposed_plan");
        assert.lengthOf(todoItems, 2);
        assert.lengthOf(proposedItems, 1);
        assert.equal(
          proposedItems[0]?.type === "proposed_plan" && proposedItems[0].markdown,
          planMarkdown,
        );
        assert.isTrue(
          [...items.values()].some(
            (item) =>
              item.type === "dynamic_tool" && item.nativeItemRef?.nativeId === "tool-todo-2",
          ),
        );
        assert.isTrue(
          [...items.values()].some(
            (item) =>
              item.type === "dynamic_tool" && item.nativeItemRef?.nativeId === "tool-exit-plan-1",
          ),
        );
        assert.deepEqual(
          [...plans.values()]
            .filter((plan) => plan.kind === "todo_list")
            .map((plan) => plan.status),
          ["superseded", "completed"],
        );
        const proposedPlan = [...plans.values()].find((plan) => plan.kind === "proposed_plan");
        assert.equal(proposedPlan?.status, "active");
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect(
    "uses task_started as an incremental roster fallback and clears on empty snapshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const emptyRoster = claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [],
            uuid: "00000000-0000-4000-8000-000000000202",
            session_id: WAKE_NATIVE_SESSION,
          });

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-roster-fallback"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
          yield* Queue.offer(harness.sdkMessages, turnOneResult);
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");

          const afterStart = providerThreadRosterEvents(harness.events).filter(
            (event) => (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
          );
          assert.isAtLeast(afterStart.length, 1);
          assert.equal(
            (afterStart.at(-1)?.providerThread.pendingBackgroundTasks ?? [])[0]?.taskId,
            WAKE_TASK_ID,
          );

          yield* Queue.offer(harness.sdkMessages, emptyRoster);
          yield* awaitUntil(
            () =>
              providerThreadRosterEvents(harness.events).some(
                (event) =>
                  event.providerThread.status === "idle" &&
                  (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0,
              ),
            "empty roster clear",
          );
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
  );

  // Frame shapes follow the claude_background_monitor_wake recording: Claude
  // runs a Monitor as a local_bash task, linked to its call by tool_use_id.
  it.effect("keeps a running Claude monitor typed after many newer monitors end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        let frameNumber = 0;
        const nextUuid = () => `00000000-0000-4000-8000-${String(++frameNumber).padStart(12, "0")}`;
        const monitorFrames = (index: number) => {
          const taskId = `monitor-task-${index}`;
          const toolUseId = `toolu_monitor_${index}`;
          const description = `Monitor ${index}`;
          return {
            taskId,
            start: [
              claudeSdkFrame({
                type: "assistant",
                message: {
                  model: "claude-sonnet-4-6",
                  id: `msg_monitor_${index}`,
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use",
                      id: toolUseId,
                      name: "Monitor",
                      input: { description, command: "sleep 8 && echo MONITOR_DONE" },
                    },
                  ],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
                parent_tool_use_id: null,
                uuid: nextUuid(),
                session_id: WAKE_NATIVE_SESSION,
              }),
              claudeSdkFrame({
                type: "system",
                subtype: "task_started",
                task_id: taskId,
                tool_use_id: toolUseId,
                description,
                is_backgrounded: true,
                task_type: "local_bash",
                uuid: nextUuid(),
                session_id: WAKE_NATIVE_SESSION,
              }),
              claudeSdkFrame({
                type: "user",
                message: {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: toolUseId,
                      content: `Monitor started (task ${taskId}).`,
                    },
                  ],
                },
                parent_tool_use_id: null,
                uuid: nextUuid(),
                session_id: WAKE_NATIVE_SESSION,
                tool_use_result: { taskId, persistent: false },
              }),
            ],
            end: claudeSdkFrame({
              type: "system",
              subtype: "task_notification",
              task_id: taskId,
              tool_use_id: toolUseId,
              status: "completed",
              output_file: `/tmp/claude-replay/tasks/${taskId}.output`,
              summary: `Monitor "${description}" stream ended`,
              uuid: nextUuid(),
              session_id: WAKE_NATIVE_SESSION,
            }),
          };
        };

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-many-monitors"),
            text: "Watch the deploy, then re-arm short watches.",
            attachments: [],
          }),
        );
        const longRunning = monitorFrames(0);
        for (const frame of longRunning.start) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        // More newer monitors start and end than any fixed id cap would hold.
        for (let index = 1; index <= 65; index++) {
          const monitor = monitorFrames(index);
          for (const frame of monitor.start) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* Queue.offer(harness.sdkMessages, monitor.end);
        }
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [
              {
                task_id: longRunning.taskId,
                task_type: "local_bash",
                description: "Monitor 0",
              },
            ],
            uuid: nextUuid(),
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: nextUuid(), result: "Watching." }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "turn terminal");

        const roster = providerThreadRosterEvents(harness.events).at(-1)?.providerThread
          .pendingBackgroundTasks;
        assert.deepEqual(roster, [
          { taskId: longRunning.taskId, kind: "monitor", description: "Monitor 0" },
        ]);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );
});
