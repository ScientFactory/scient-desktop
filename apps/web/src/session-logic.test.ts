import {
  MessageId,
  RuntimeRequestId,
  CheckpointId,
  CheckpointScopeId,
  NodeId,
  PlanId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/shell";
import { deriveMessagesTimelineRows } from "./components/chat/MessagesTimeline.logic";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { resolveWorkEntryToolPresentation } from "@t3tools/client-runtime/work-log/presentation";
import { buildPendingUserInputAnswers } from "./pendingUserInput";

import {
  deriveActiveWorkStartedAt,
  deriveTimelineEntries,
  deriveTimelineEntriesWithState,
  deriveActivePlanState,
  deriveCanInterruptRunningThread,
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  deriveRevertTurnCountByUserMessageId,
  derivePhase,
  findLatestProposedPlan,
  isLatestRunSettled,
  selectHandoffImageResources,
  selectMessageImageResources,
  workEntryIndicatesToolNeutralStatus,
  workEntrySignalsSevereFailure,
  createMessageAttachmentPreviewProjector,
  providerErrorPresentation,
  type TimelineEntry,
  workEntryIndicatesToolFailure,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
} from "./session-logic";
import { makeStreamingTimelineFixture, makeThreadProjectionFixture } from "./test-fixtures";
import type { ChatMessage } from "./types";

describe("V2 session presentation", () => {
  it("uses run status as the settlement boundary", () => {
    const runId = RunId.make("run-1");
    expect(
      isLatestRunSettled(
        {
          runId,
          status: "completed",
          startedAt: "2026-06-20T00:00:00.000Z",
          completedAt: "2026-06-20T00:01:00.000Z",
        },
        null,
      ),
    ).toBe(true);
    expect(
      isLatestRunSettled(
        { runId, status: "running", startedAt: null, completedAt: null },
        { status: "running", activeRunId: runId },
      ),
    ).toBe(false);
    expect(
      isLatestRunSettled(
        { runId, status: "queued", startedAt: null, completedAt: null },
        { status: "running", activeRunId: RunId.make("run-active") },
      ),
    ).toBe(false);
  });

  it("offers Stop while a run is preparing/starting, not just once it's running (#13392)", () => {
    const runtimeWithStatus = (
      status: ThreadRuntimeSummary["status"],
      activeRunId: RunId | null = null,
    ): ThreadRuntimeSummary => ({
      status,
      activeRunId,
      providerInstanceId: ProviderInstanceId.make("claude-default"),
      providerName: null,
      lastError: null,
      updatedAt: "2026-09-29T00:00:00.000Z",
    });
    const runId = RunId.make("run-stop-while-starting");

    for (const status of ["preparing", "starting", "running"] as const) {
      const runtime = runtimeWithStatus(status, runId);
      expect(deriveCanInterruptRunningThread(true, runtime)).toBe(true);
    }

    // No active thread: never offer Stop, regardless of run status.
    expect(deriveCanInterruptRunningThread(false, runtimeWithStatus("running", runId))).toBe(false);

    // Queued with nothing interruptible: the server rejects interrupting a
    // queued run, so Stop stays hidden.
    expect(derivePhase(runtimeWithStatus("queued"))).toBe("connecting");
    expect(deriveCanInterruptRunningThread(true, runtimeWithStatus("queued"))).toBe(false);
    // Queued behind a run that is still interruptible: Stop targets that run.
    expect(deriveCanInterruptRunningThread(true, runtimeWithStatus("queued", runId))).toBe(true);

    // Waiting (e.g. on a subagent) is treated as "running" by derivePhase and
    // keeps offering Stop, unchanged from before.
    expect(derivePhase(runtimeWithStatus("waiting"))).toBe("running");
    expect(deriveCanInterruptRunningThread(true, runtimeWithStatus("waiting"))).toBe(true);

    // No runtime at all: nothing to interrupt.
    expect(deriveCanInterruptRunningThread(true, null)).toBe(false);
  });

  it("labels provider retry progress, delay, recovery, and exhaustion", () => {
    const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
    const retryItem = {
      id: TurnItemId.make("item-provider-retry"),
      threadId: ThreadId.make("thread-provider-retry"),
      runId: RunId.make("run-provider-retry"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running" as const,
      title: "Provider retry",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "error" as const,
      failure: {
        class: "provider_error" as const,
        message: "Claude API overloaded.",
        code: "api_error_529",
        retryable: true,
      },
      retry: {
        attempt: 2,
        maxAttempts: 10,
        retryDelayMs: 1_500,
      },
    } satisfies Extract<OrchestrationV2TurnItem, { readonly type: "error" }>;

    expect(
      providerErrorPresentation({
        ...retryItem,
        status: "failed",
        failure: { ...retryItem.failure, class: "usage_limit" },
      }),
    ).toMatchObject({ label: "Usage limit reached after 2/10 retries" });
    const recoveredLimit = {
      ...retryItem,
      status: "completed" as const,
      completedAt: now,
      failure: { ...retryItem.failure, class: "usage_limit" as const },
    };
    const [recoveredEntry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          item: recoveredLimit,
          position: 0,
          visibility: "local",
          sourceThreadId: recoveredLimit.threadId,
          sourceItemId: recoveredLimit.id,
        },
      ],
      optimisticMessages: [],
    });
    if (recoveredEntry?.kind !== "work") throw new Error("Expected recovered provider work");
    expect(recoveredEntry.entry.label).toBe("Provider recovered (2/10 retries)");
    expect(recoveredEntry.entry.sourceActivityKind).not.toBe("runtime.warning");
    expect(workEntryDisplayIndicatesToolFailure(recoveredEntry.entry)).toBe(false);
    expect(providerErrorPresentation(retryItem)).toEqual({
      label: "Retrying provider (2/10)",
      detail: "Claude API overloaded. Retrying in 1.5s.",
    });
    expect(
      providerErrorPresentation({
        ...retryItem,
        status: "completed",
        completedAt: now,
      }),
    ).toMatchObject({ label: "Provider recovered (2/10 retries)" });
    expect(
      providerErrorPresentation({
        ...retryItem,
        status: "failed",
        retry: { ...retryItem.retry, attempt: 10 },
        completedAt: now,
      }),
    ).toMatchObject({ label: "Provider error after 10/10 retries" });
  });

  it("selects the latest proposed plan for a run", () => {
    const runId = RunId.make("run-1");
    const planId = PlanId.make("plan-1");
    const nodeId = NodeId.make("node-plan");
    const now = DateTime.makeUnsafe("2026-06-20T00:00:01.000Z");
    const baseProjection = makeThreadProjectionFixture();
    const plan = findLatestProposedPlan(
      {
        ...baseProjection,
        plans: [
          {
            id: planId,
            threadId: baseProjection.thread.id,
            nodeId,
            kind: "proposed_plan" as const,
            markdown: "Plan",
            status: "active" as const,
            runId,
          },
        ],
        turnItems: [
          {
            id: TurnItemId.make("item-plan"),
            threadId: baseProjection.thread.id,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed" as const,
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "proposed_plan" as const,
            planId,
            markdown: "Plan",
            streaming: false,
            runId,
          },
        ],
        updatedAt: now,
      },
      runId,
    );
    expect(plan?.planMarkdown).toBe("Plan");
  });

  it("assigns run rollback to the turn-start message instead of a later steer", () => {
    const runId = RunId.make("run-steered");
    const turnStartMessageId = MessageId.make("message-turn-start");
    const steerMessageId = MessageId.make("message-steer");
    const assistantMessageId = MessageId.make("message-assistant");
    const messages: ChatMessage[] = [
      {
        id: turnStartMessageId,
        role: "user",
        text: "Start",
        runId,
        inputIntent: "turn_start",
        streaming: false,
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
      },
      {
        id: steerMessageId,
        role: "user",
        text: "Steer",
        runId,
        inputIntent: "steer",
        streaming: false,
        createdAt: "2026-06-20T00:00:01.000Z",
        updatedAt: "2026-06-20T00:00:01.000Z",
      },
      {
        id: assistantMessageId,
        role: "assistant",
        text: "Done",
        runId,
        streaming: false,
        createdAt: "2026-06-20T00:00:02.000Z",
        updatedAt: "2026-06-20T00:00:02.000Z",
      },
    ];
    const timelineEntries: TimelineEntry[] = messages.map((message): TimelineEntry => ({
      id: message.id,
      kind: "message",
      createdAt: message.createdAt,
      message,
    }));

    const targets = deriveRevertTurnCountByUserMessageId({
      timelineEntries,
      checkpoints: [
        {
          runId,
          checkpointTurnCount: 1,
          checkpointRef: "checkpoint-run-1" as never,
          status: "ready",
          files: [],
          assistantMessageId,
          completedAt: "2026-06-20T00:00:03.000Z",
        },
      ],
    });

    expect([...targets]).toEqual([[turnStartMessageId, 0]]);
    expect(targets.has(steerMessageId)).toBe(false);
  });

  it("uses visible turn item order and keeps provider errors in the work log", () => {
    const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
    const threadId = ThreadId.make("thread-visible");
    const runId = RunId.make("run-visible");
    const base = (id: string, ordinal: number) => ({
      id: TurnItemId.make(id),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
    const userItem = {
      ...base("item-user", 0),
      type: "user_message" as const,
      messageId: MessageId.make("message-user"),
      inputIntent: "turn_start" as const,
      text: "Start",
      attachments: [],
      createdBy: "user" as const,
      creationSource: "web" as const,
    } satisfies OrchestrationV2TurnItem;
    const requestItem = {
      ...base("item-interrupt-request", 1),
      type: "run_interrupt_request" as const,
      message: "Stopping",
    } satisfies OrchestrationV2TurnItem;
    const commandItem = {
      ...base("item-command", 2),
      type: "command_execution" as const,
      input: "sleep 1",
      output: "done",
      exitCode: 0,
    } satisfies OrchestrationV2TurnItem;
    const resultItem = {
      ...base("item-interrupt-result", 3),
      type: "run_interrupt_result" as const,
      message: "Stopped",
    } satisfies OrchestrationV2TurnItem;
    const todoItem = {
      ...base("item-todo", 4),
      type: "todo_list" as const,
      planId: PlanId.make("plan-visible"),
      explanation: "Keep task detail in the Tasks panel",
      steps: [
        { id: "step-1", text: "First", status: "completed" as const },
        { id: "step-2", text: "Second", status: "pending" as const },
      ],
    } satisfies OrchestrationV2TurnItem;
    const errorItem = {
      ...base("item-error", 5),
      status: "failed" as const,
      type: "error" as const,
      failure: {
        class: "validation_error" as const,
        message: "Invalid reasoning effort.",
        code: "invalid_request",
        retryable: false,
      },
    } satisfies OrchestrationV2TurnItem;
    const threadCreatedItem = {
      ...base("item-thread-created", 6),
      type: "thread_created" as const,
      title: "Follow-up thread",
      targetThreadId: ThreadId.make("thread-follow-up"),
      targetRunId: RunId.make("run-follow-up"),
      targetProviderInstanceId: ProviderInstanceId.make("claude-default"),
      targetModel: "claude-sonnet-4-6",
    } satisfies OrchestrationV2TurnItem;
    const workspacePreparationItem = {
      ...base("item-workspace-preparation", 7),
      type: "command_execution" as const,
      title: "Workspace ready",
      input: "Preparing workspace",
      output: "Workspace preparation completed.",
      exitCode: 0,
    } satisfies OrchestrationV2TurnItem;
    const visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [
      userItem,
      requestItem,
      commandItem,
      resultItem,
      todoItem,
      errorItem,
      threadCreatedItem,
      workspacePreparationItem,
    ].map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    }));

    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems,
      optimisticMessages: [],
    });

    expect(entries.map((entry) => [entry.kind, entry.id])).toEqual([
      ["message", userItem.messageId],
      ["event", requestItem.id],
      ["work", commandItem.id],
      ["event", resultItem.id],
      ["work", errorItem.id],
      ["work", threadCreatedItem.id],
    ]);
    const commandEntry = entries[2];
    const userEntry = entries[0];
    expect(userEntry?.kind).toBe("message");
    if (userEntry?.kind === "message") {
      expect(userEntry.projectedItem).toBe(visibleTurnItems[0]);
      expect(userEntry.message.inputIntent).toBe("turn_start");
      expect(userEntry.message.createdBy).toBe("user");
      expect(userEntry.message.creationSource).toBe("web");
    }
    expect(commandEntry?.kind).toBe("work");
    if (commandEntry?.kind === "work") {
      expect(commandEntry.entry.projectedItem).toBe(visibleTurnItems[2]);
      expect(commandEntry.entry.structuredPayload).toBe(commandItem);
      expect(commandEntry.entry.command).toBe(commandItem.input);
      expect(commandEntry.entry.detail).toBeUndefined();
    }
    const errorEntry = entries[4];
    expect(errorEntry?.kind).toBe("work");
    if (errorEntry?.kind === "work") {
      expect(errorEntry.entry.projectedItem).toBe(visibleTurnItems[5]);
      expect(errorEntry.entry.label).toBe("Provider error");
      expect(errorEntry.entry.detail).toBe("Invalid reasoning effort.");
      expect(errorEntry.entry.tone).toBe("info");
      expect(errorEntry.entry.toolLifecycleStatus).toBe("failed");
    }
    const threadCreatedEntry = entries[5];
    expect(threadCreatedEntry?.kind).toBe("work");
    if (threadCreatedEntry?.kind === "work") {
      expect(threadCreatedEntry.entry.projectedItem?.item.type).toBe("thread_created");
    }
  });

  it.each(["pending", "running", "completed"] as const)(
    "keeps %s task progress available to the composer and out of the timeline",
    (stepStatus) => {
      const projection = makeThreadProjectionFixture();
      const now = DateTime.makeUnsafe("2026-09-04T00:00:00.000Z");
      const runId = RunId.make("run-tasks");
      const nodeId = NodeId.make("node-tasks");
      const planId = PlanId.make("plan-tasks");
      const steps = [{ id: "step-1", text: "Verify the change", status: stepStatus }];
      const item = {
        id: TurnItemId.make("item-tasks"),
        threadId: projection.thread.id,
        runId,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "todo_list" as const,
        planId,
        steps,
      } satisfies OrchestrationV2TurnItem;
      const plans = [
        {
          id: planId,
          threadId: projection.thread.id,
          runId,
          nodeId,
          kind: "todo_list" as const,
          status: "active" as const,
          steps,
        },
      ];

      expect(
        deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: [
            {
              position: 0,
              visibility: "local",
              sourceThreadId: projection.thread.id,
              sourceItemId: item.id,
              item,
            },
          ],
          optimisticMessages: [],
          plans,
        }),
      ).toEqual([]);
      expect(
        deriveActivePlanState({ ...projection, plans, turnItems: [item] }, runId),
      ).toMatchObject({
        runId,
        steps: [
          {
            step: "Verify the change",
            status: stepStatus === "running" ? "inProgress" : stepStatus,
          },
        ],
      });
    },
  );

  it("preserves independently derived durations for repeated plan-step labels", () => {
    const projection = makeThreadProjectionFixture();
    const runId = RunId.make("run-timed-tasks");
    const planId = PlanId.make("plan-timed-tasks");
    const plan = {
      id: planId,
      threadId: projection.thread.id,
      runId,
      nodeId: NodeId.make("node-timed-tasks"),
      kind: "todo_list" as const,
      status: "active" as const,
      steps: [
        { id: "verify-a", text: "Verify", status: "completed" as const, durationMs: 3_000 },
        { id: "verify-b", text: "Verify", status: "completed" as const, durationMs: 4_000 },
        { id: "report", text: "Report", status: "pending" as const },
      ],
    };

    expect(deriveActivePlanState({ ...projection, plans: [plan] }, runId)?.steps).toEqual([
      { step: "Verify", status: "completed", durationMs: 3_000 },
      { step: "Verify", status: "completed", durationMs: 4_000 },
      { step: "Report", status: "pending" },
    ]);
  });

  it("keeps failed tool items tool-toned so groups still summarize", () => {
    const failedCommand = {
      id: TurnItemId.make("item-failed-command"),
      threadId: ThreadId.make("thread-1"),
      runId: RunId.make("run-1"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "failed" as const,
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.nowUnsafe(),
      type: "command_execution" as const,
      input: "ssh host true",
      output: "connection refused",
      exitCode: 255,
    } satisfies OrchestrationV2TurnItem;
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local" as const,
          sourceThreadId: ThreadId.make("thread-1"),
          sourceItemId: failedCommand.id,
          item: failedCommand,
        } as never,
      ],
      optimisticMessages: [],
    });
    const entry = entries[0];
    expect(entry?.kind).toBe("work");
    if (entry?.kind === "work") {
      // An exit-code failure is still an ordinary tool row: the failed
      // lifecycle status carries the marker, and an "error" tone here would
      // knock the whole group out of the "Ran N commands" summary.
      expect(entry.entry.tone).toBe("tool");
      expect(entry.entry.toolLifecycleStatus).toBe("failed");
    }
  });

  it("waits for a dispatched turn item before adding queued input to the timeline", () => {
    const projection = makeThreadProjectionFixture();
    const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
    const runId = RunId.make("run-dispatched-queued");
    const messageId = MessageId.make("message-dispatched-queued");
    const optimisticMessage = {
      id: messageId,
      role: "user" as const,
      text: "Queued input",
      runId: null,
      inputIntent: "queued_turn" as const,
      streaming: false,
      createdAt: DateTime.formatIso(now),
      updatedAt: DateTime.formatIso(now),
    };

    expect(
      deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [],
        optimisticMessages: [optimisticMessage],
      }),
    ).toEqual([]);

    const dispatchedItem = {
      id: TurnItemId.make("item-dispatched-queued"),
      threadId: projection.thread.id,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 200,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "user_message" as const,
      messageId,
      inputIntent: "turn_start" as const,
      text: "Queued input",
      attachments: [],
      createdBy: "agent" as const,
      creationSource: "mcp" as const,
      scheduledTaskId: ScheduledTaskId.make("task-queued"),
      senderThreadId: ThreadId.make("thread-agent-sender"),
    } satisfies OrchestrationV2TurnItem;
    const promotedEntries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: projection.thread.id,
          sourceItemId: dispatchedItem.id,
          item: dispatchedItem,
        },
      ],
      optimisticMessages: [optimisticMessage],
    });
    expect(promotedEntries.map((entry) => entry.id)).toEqual([messageId]);
    expect(promotedEntries[0]?.kind).toBe("message");
    if (promotedEntries[0]?.kind === "message") {
      expect(promotedEntries[0].message.inputIntent).toBe("turn_start");
      expect(promotedEntries[0].message.scheduledTaskId).toBe("task-queued");
      expect(promotedEntries[0].message.senderThreadId).toBe("thread-agent-sender");
    }
  });

  it("anchors feedback before later committed turns without reordering canonical history", () => {
    const threadId = ThreadId.make("thread-feedback-order");
    const messageItem = (input: {
      readonly id: string;
      readonly role: "user" | "assistant";
      readonly createdAt: string;
      readonly ordinal: number;
    }): OrchestrationV2TurnItem => {
      const timestamp = DateTime.makeUnsafe(input.createdAt);
      const common = {
        id: TurnItemId.make(`item-${input.id}`),
        threadId,
        runId: RunId.make(`run-${input.ordinal}`),
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: input.ordinal,
        status: "completed" as const,
        title: null,
        startedAt: timestamp,
        completedAt: timestamp,
        updatedAt: timestamp,
        messageId: MessageId.make(input.id),
        text: input.id,
      };
      return input.role === "user"
        ? {
            ...common,
            type: "user_message",
            inputIntent: "turn_start",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          }
        : { ...common, type: "assistant_message", streaming: false };
    };
    const canonicalItems = [
      messageItem({ id: "old-user", role: "user", createdAt: "2026-08-29T00:00:01Z", ordinal: 1 }),
      messageItem({
        id: "old-assistant",
        role: "assistant",
        createdAt: "2026-08-29T00:00:02Z",
        ordinal: 2,
      }),
      messageItem({
        id: "later-user",
        role: "user",
        createdAt: "2026-08-29T00:00:05Z",
        ordinal: 3,
      }),
      messageItem({
        id: "later-assistant",
        role: "assistant",
        createdAt: "2026-08-29T00:00:04Z",
        ordinal: 4,
      }),
    ];
    const visibleTurnItems = canonicalItems.map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    }));
    const feedback = (id: string, role: "user" | "assistant"): ChatMessage => ({
      id: MessageId.make(id),
      role,
      text: id,
      runId: null,
      streaming: false,
      createdAt: "2026-08-29T00:00:03Z",
      updatedAt: "2026-08-29T00:00:03Z",
    });
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems,
      anchoredMessages: [
        feedback("feedback-user", "user"),
        feedback("feedback-assistant", "assistant"),
        feedback("later-user", "user"),
      ],
      optimisticMessages: [
        { ...feedback("optimistic-user", "user"), createdAt: "2026-08-29T00:00:00Z" },
      ],
    });

    expect(entries.map((entry) => entry.id)).toEqual([
      "old-user",
      "old-assistant",
      "feedback-user",
      "feedback-assistant",
      "later-user",
      "later-assistant",
      "optimistic-user",
    ]);
    expect(
      entries
        .filter((entry) => entry.id.startsWith("feedback-"))
        .every((entry) => entry.kind === "message" && entry.projectedItem === undefined),
    ).toBe(true);
  });

  it("uses projected plan status and file contents in timeline entries", () => {
    const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
    const threadId = ThreadId.make("thread-timeline-artifacts");
    const runId = RunId.make("run-timeline-artifacts");
    const nodeId = NodeId.make("node-timeline-artifacts");
    const planId = PlanId.make("plan-timeline-artifacts");
    const base = {
      threadId,
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const planItem = {
      ...base,
      id: TurnItemId.make("item-proposed-plan"),
      ordinal: 0,
      type: "proposed_plan" as const,
      planId,
      markdown: "Finished plan",
      streaming: false,
    } satisfies OrchestrationV2TurnItem;
    const fileItem = {
      ...base,
      id: TurnItemId.make("item-file-change"),
      ordinal: 1,
      type: "file_change" as const,
      fileName: "src/example.ts",
      newStr: "export const answer = 42;\n",
    } satisfies OrchestrationV2TurnItem;
    const visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [
      planItem,
      fileItem,
    ].map((item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    }));

    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems,
      optimisticMessages: [],
      plans: [
        {
          id: planId,
          threadId,
          runId,
          nodeId,
          kind: "proposed_plan",
          markdown: "",
          status: "completed",
          detailInTurnItem: true,
        },
      ],
    });

    expect(entries[0]?.kind).toBe("proposed-plan");
    if (entries[0]?.kind === "proposed-plan") {
      expect(entries[0].proposedPlan.status).toBe("completed");
      expect(entries[0].proposedPlan.planMarkdown).toBe("Finished plan");
    }
    expect(entries[1]?.kind).toBe("work");
    if (entries[1]?.kind === "work") {
      expect(entries[1].entry.detail).toBeUndefined();
      expect(entries[1].entry.changedFiles).toEqual([fileItem.fileName]);
    }
  });

  it("resolves attempt identity through V2 execution nodes", () => {
    const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
    const threadId = ThreadId.make("thread-attempts");
    const runId = RunId.make("run-steered");
    const supersededRootNodeId = NodeId.make("node-attempt-1-root");
    const supersededChildNodeId = NodeId.make("node-attempt-1-child");
    const activeRootNodeId = NodeId.make("node-attempt-2-root");
    const supersededAttemptId = RunAttemptId.make("attempt-1");
    const activeAttemptId = RunAttemptId.make("attempt-2");
    const providerInstanceId = ProviderInstanceId.make("codex-default");
    const providerThreadId = ProviderThreadId.make("provider-thread-attempts");
    const attempts: ReadonlyArray<OrchestrationV2RunAttempt> = [
      {
        id: supersededAttemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: supersededRootNodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "superseded",
        startedAt: now,
        completedAt: now,
      },
      {
        id: activeAttemptId,
        runId,
        attemptOrdinal: 2,
        rootNodeId: activeRootNodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "steering_restart",
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    ];
    const node = (
      id: OrchestrationV2ExecutionNode["id"],
      rootNodeId: OrchestrationV2ExecutionNode["rootNodeId"],
      parentNodeId: OrchestrationV2ExecutionNode["parentNodeId"],
    ): OrchestrationV2ExecutionNode => ({
      id,
      threadId,
      runId,
      parentNodeId,
      rootNodeId,
      kind: id === rootNodeId ? "root_turn" : "assistant_message",
      status: "running",
      countsForRun: true,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    });
    const nodes = [
      node(supersededRootNodeId, supersededRootNodeId, null),
      node(supersededChildNodeId, supersededRootNodeId, supersededRootNodeId),
      node(activeRootNodeId, activeRootNodeId, null),
    ];
    const assistantItem = (
      id: string,
      messageId: string,
      nodeId: NodeId,
      text: string,
      ordinal: number,
    ): OrchestrationV2TurnItem => ({
      id: TurnItemId.make(id),
      threadId,
      runId,
      nodeId,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "running",
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "assistant_message",
      messageId: MessageId.make(messageId),
      text,
      streaming: true,
    });
    const items = [
      assistantItem(
        "item-superseded",
        "message-superseded",
        supersededChildNodeId,
        "Partial old response",
        0,
      ),
      assistantItem("item-active", "message-active", activeRootNodeId, "Current response", 1),
    ];
    const visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = items.map(
      (item, position) => ({
        position,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      }),
    );

    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems,
      optimisticMessages: [],
      attempts,
      nodes,
    });

    expect(entries.map((entry) => [entry.attempt?.id, entry.attempt?.status])).toEqual([
      [supersededAttemptId, "superseded"],
      [activeAttemptId, "running"],
    ]);
    const input = { visibleTurnItems, optimisticMessages: [], attempts, nodes };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const nextInput = {
      ...input,
      attempts: attempts.map((attempt) =>
        attempt.id === activeAttemptId ? { ...attempt, status: "superseded" as const } : attempt,
      ),
    };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    expect(next.entries.at(-1)?.attempt?.status).toBe("superseded");
    expect(previous.entries.at(-1)?.attempt?.status).toBe("running");
  });
});

describe("native provider presentation in the v2 timeline", () => {
  const timestamp = DateTime.makeUnsafe("2026-09-04T12:00:00.000Z");
  const base = {
    id: TurnItemId.make("native-item"),
    threadId: ThreadId.make("native-thread"),
    runId: RunId.make("native-run"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
  const visible = (item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem => ({
    position: 0,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  });

  it.each([
    "scient_skill_load",
    "mcp__scient__scient_skill_load",
    "mcp__t3_code__scient_skill_load",
    "mcp__t3-code__scient_skill_load",
    "t3-code.scient_skill_load",
  ])("labels a completed native skill load from its input: %s", (toolName) => {
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      toolName,
      title: "Generic provider title",
      input: { name: "latex-authoring" },
      output: { content: "Skill instructions" },
    } satisfies OrchestrationV2TurnItem;
    const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(item)],
      optimisticMessages: [],
    });
    expect(entry).toMatchObject({
      kind: "work",
      entry: {
        label: "Used Latex Authoring",
        toolTitle: "Used Latex Authoring",
        toolLifecycleStatus: "completed",
        toolData: { input: item.input, output: item.output },
      },
    });
  });

  it.each([
    ["running", "Loading Latex Authoring"],
    ["pending", "Loading Latex Authoring"],
    ["waiting", "Loading Latex Authoring"],
    ["failed", "Couldn't load Latex Authoring"],
    ["cancelled", "Didn't load Latex Authoring"],
    ["interrupted", "Didn't load Latex Authoring"],
  ] as const)("reflects the durable skill load status: %s", (status, label) => {
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      toolName: "scient_skill_load",
      status,
      input: { releaseKey: "scient.latex-authoring@immutable-release" },
    } satisfies OrchestrationV2TurnItem;
    const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(item)],
      optimisticMessages: [],
    });
    expect(entry).toMatchObject({ kind: "work", entry: { label, toolTitle: label } });
  });

  it.each(["mcp__foreign__scient_skill_load", "scient_skill_load_extra"])(
    "keeps a different tool's native label: %s",
    (toolName) => {
      const item = {
        ...base,
        type: "dynamic_tool" as const,
        toolName,
        input: { name: "latex-authoring" },
      } satisfies OrchestrationV2TurnItem;
      const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [visible(item)],
        optimisticMessages: [],
      });
      expect(entry).toMatchObject({ kind: "work", entry: { label: toolName } });
    },
  );

  it.each([
    ["running", "Clicking in the preview browser"],
    ["completed", "Clicked in the preview browser"],
    ["failed", "Failed to click in the preview browser"],
  ] as const)(
    "preserves Claude MCP identity behind generic titles while %s",
    (status, displayName) => {
      const item = {
        ...base,
        type: "dynamic_tool" as const,
        status,
        title: "MCP tool call",
        toolName: "mcp__t3_code__preview_click",
        input: { selector: "#submit" },
        ...(status === "running" ? {} : { output: "Result" }),
      } satisfies OrchestrationV2TurnItem;
      const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [visible(item)],
        optimisticMessages: [],
      });
      if (entry?.kind !== "work") throw new Error("Expected a tool work entry");

      expect(entry.entry.toolTitle).toBe("MCP tool call");
      expect(resolveWorkEntryToolPresentation(entry.entry)).toEqual({
        displayName,
        icon: "browser",
      });
    },
  );

  it("keeps context compaction as a normal work-log entry", () => {
    const item = {
      ...base,
      type: "compaction" as const,
      driver: null,
    } satisfies OrchestrationV2TurnItem;
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(item)],
      optimisticMessages: [],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "work", entry: { label: "Context compacted" } });
  });

  it("shows a concise, severe provider failure and leaves the technical detail inspectable", () => {
    const failure = {
      ...base,
      status: "failed" as const,
      type: "error" as const,
      failure: {
        class: "provider_error" as const,
        message: "technical detail",
        code: "turn_start_failed",
        retryable: false,
      },
    } satisfies OrchestrationV2TurnItem;
    const notice = {
      ...base,
      id: TurnItemId.make("native-notice"),
      type: "system_notice" as const,
      message: "Provider reported a warning",
    } satisfies OrchestrationV2TurnItem;
    const [failureEntry, noticeEntry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(failure), { ...visible(notice), position: 1 }],
      optimisticMessages: [],
    });
    if (failureEntry?.kind !== "work" || noticeEntry?.kind !== "work") {
      throw new Error("Expected work entries");
    }

    expect(failureEntry.entry.detail).toBe("technical detail");
    expect(failureEntry.entry.label).not.toBe("technical detail");
    expect(workEntrySignalsSevereFailure(failureEntry.entry)).toBe(true);
    expect(workEntrySignalsSevereFailure(noticeEntry.entry)).toBe(false);
  });

  it("keeps async answers in the question row, including incrementally appended replies", () => {
    const requestId = RuntimeRequestId.make("question");
    const question: OrchestrationV2TurnItem = {
      ...base,
      type: "user_input_request",
      requestId,
      questions: [],
      questionAnswer: { requestId, answers: { color: "Blue" }, attachmentsByQuestionId: {} },
    };
    const reply: OrchestrationV2TurnItem = {
      ...base,
      id: TurnItemId.make("answer"),
      type: "user_message",
      messageId: MessageId.make(`async-answer:${requestId}`),
      inputIntent: "steer",
      text: "Which color?\nBlue",
      createdBy: "user",
      creationSource: "server",
      attachments: [],
    };
    const input = { visibleTurnItems: [visible(question)], optimisticMessages: [] };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const nextInput = { ...input, visibleTurnItems: [...input.visibleTurnItems, visible(reply)] };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    expect(next.entries).toHaveLength(1);
    const replyFirst = { ...input, visibleTurnItems: [visible(reply)] };
    const replyProjection = deriveTimelineEntriesFromVisibleTurnItemsWithState(replyFirst);
    const questionAfterReply = {
      ...input,
      visibleTurnItems: [...replyFirst.visibleTurnItems, visible(question)],
    };
    expect(
      deriveTimelineEntriesFromVisibleTurnItemsWithState(questionAfterReply, replyProjection)
        .entries,
    ).toEqual(deriveTimelineEntriesFromVisibleTurnItems(questionAfterReply));

    expect(next.entries[0]).toMatchObject({
      kind: "work",
      entry: { questionAnswer: question.questionAnswer },
    });
    // A separately paged reply stays visible until its question history is available.
    expect(
      deriveTimelineEntriesFromVisibleTurnItems({ ...input, visibleTurnItems: [visible(reply)] })[0]
        ?.kind,
    ).toBe("message");
  });

  it("excludes checkpoint-only work from the timeline", () => {
    const message: OrchestrationV2TurnItem = {
      ...base,
      type: "assistant_message",
      messageId: MessageId.make("done"),
      text: "Done",
      streaming: false,
    };
    const checkpoint: OrchestrationV2TurnItem = {
      ...base,
      id: TurnItemId.make("checkpoint"),
      type: "checkpoint",
      checkpointId: CheckpointId.make("checkpoint"),
      scopeId: CheckpointScopeId.make("scope"),
      files: [],
    };
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(message), visible(checkpoint)],
      optimisticMessages: [],
    });
    expect(entries.map((entry) => entry.kind)).toEqual(["message"]);
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      latestRun: {
        runId: base.runId,
        status: "completed",
        startedAt: DateTime.formatIso(timestamp),
        completedAt: DateTime.formatIso(timestamp),
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.map((row) => row.kind)).toEqual(["message"]);
  });

  it.each([
    { outputIndicatesFailure: true },
    { exitCode: 2 },
    { output: "bash: foo: command not found" },
  ])("keeps completed command failures visible without exposing output: %j", (result) => {
    const item = {
      ...base,
      type: "command_execution" as const,
      input: "foo",
      ...result,
    } satisfies OrchestrationV2TurnItem;
    const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(item)],
      optimisticMessages: [],
    });
    if (entry?.kind !== "work") throw new Error("Expected a command work entry");

    expect(entry.entry.detail).toBeUndefined();
    expect(entry.entry.command).toBe("foo");
    expect(entry.entry.toolLifecycleStatus).toBe("completed");
    expect(workEntryDisplayIndicatesToolFailure(entry.entry)).toBe(true);
    expect(workEntryIndicatesToolSuccess(entry.entry)).toBe(false);
  });

  it("retains Claude Read image previews without tool output", () => {
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      toolName: "Read",
      input: { file_path: "/workspace/reference.png" },
      viewedImagePath: "/workspace/reference.png",
    } satisfies OrchestrationV2TurnItem;
    const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(item)],
      optimisticMessages: [],
    });
    expect(entry).toMatchObject({
      kind: "work",
      entry: { viewedImagePath: "/workspace/reference.png" },
    });
  });

  it("labels a read of a bare filename from its structured input", () => {
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      toolName: "Read",
      input: { file_path: "README" },
      output: "project notes",
    } satisfies OrchestrationV2TurnItem;
    const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(item)],
      optimisticMessages: [],
    });
    expect(entry).toMatchObject({ kind: "work", entry: { label: "Read README" } });
  });

  it("keeps browser identity and its source on a completed tool row", () => {
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      toolName: "browser_snapshot",
      input: {},
      output: {},
      toolSurface: "browser" as const,
      toolIcon: { _tag: "website" as const, pageUrl: "https://example.com/checkout" },
      toolSource: { key: "browser-use:browser", name: "Chrome", kind: "browser" as const },
    } satisfies OrchestrationV2TurnItem;
    const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(item)],
      optimisticMessages: [],
    });
    expect(entry).toMatchObject({
      kind: "work",
      entry: {
        toolSurface: "browser",
        toolIcon: item.toolIcon,
        toolSource: item.toolSource,
        toolLifecycleStatus: "completed",
      },
    });
  });

  it("shows provider-returned images on an assistant message using the environment asset URL", () => {
    const attachment = {
      type: "image" as const,
      id: "assistant-image",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 512,
    };
    const item = {
      ...base,
      type: "assistant_message" as const,
      messageId: MessageId.make("assistant-native-image"),
      text: "Here is the screenshot.",
      streaming: false,
      attachments: [attachment],
    } satisfies OrchestrationV2TurnItem;
    const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(item)],
      optimisticMessages: [],
      attachmentUrlById: new Map([[attachment.id, "https://remote.example/api/assets/screenshot"]]),
    });
    expect(entry).toMatchObject({
      kind: "message",
      message: {
        role: "assistant",
        attachments: [
          { ...attachment, previewUrl: "https://remote.example/api/assets/screenshot" },
        ],
      },
    });
  });

  it("keeps an idle provider task neutral without a completion mark", () => {
    const entry = {
      id: "idle-tool",
      createdAt: DateTime.formatIso(timestamp),
      label: "Waiting for the next task",
      tone: "tool" as const,
      toolLifecycleStatus: "idle" as const,
    };
    expect(workEntryIndicatesToolSuccess(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });
});

describe("work-log failure policy (#7999/#7893)", () => {
  const toolEntry = (overrides: Record<string, unknown>) =>
    ({
      id: "entry-1",
      createdAt: "2026-08-27T00:00:00.000Z",
      label: "Ran command",
      tone: "tool",
      ...overrides,
    }) as never;

  it("flags success-status rows whose output text reports a failure", () => {
    expect(
      workEntryIndicatesToolFailure(
        toolEntry({ toolLifecycleStatus: "completed", detail: "bash: foo: command not found" }),
      ),
    ).toBe(true);
    expect(
      workEntryIndicatesToolFailure(
        toolEntry({ toolLifecycleStatus: "completed", detail: "<exited with exit code 2>" }),
      ),
    ).toBe(true);
  });

  it("keeps the rendered row calm when only the command mentions failure text", () => {
    const entry = toolEntry({
      toolLifecycleStatus: "completed",
      command: "rg 'command not found' src/",
    });
    expect(workEntryIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });

  it("does not call a clean completed row failed", () => {
    const entry = toolEntry({ toolLifecycleStatus: "completed", detail: "3 files changed" });
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryIndicatesToolSuccess(entry)).toBe(true);
  });

  it("recovered failure text no longer counts as success", () => {
    const entry = toolEntry({ toolLifecycleStatus: "completed", detail: "ENOENT: no such file" });
    expect(workEntryIndicatesToolSuccess(entry)).toBe(false);
  });
});

describe("incremental v2 timeline entries", () => {
  it("retains history and attachment previews through decoded streaming updates", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const attachment = {
      type: "image" as const,
      id: "stream-image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    const visibleTurnItems = fixture.visibleTurnItems.map((row) =>
      row.item.type === "assistant_message"
        ? { ...row, item: { ...row.item, attachments: [attachment] } }
        : row,
    );
    const input = {
      visibleTurnItems,
      optimisticMessages: [],
      attachmentUrlById: new Map([[attachment.id, "https://server.test/image"]]),
    };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    Object.freeze(previous.entries);
    for (const entry of previous.entries) Object.freeze(entry);
    const last = visibleTurnItems.at(-1)!;
    if (last.item.type !== "assistant_message") throw new Error("Expected assistant fixture");
    const nextItem = {
      ...last,
      item: {
        ...last.item,
        text: "Next token",
        attachments: [{ ...attachment }],
        startedAt: DateTime.makeUnsafe(fixture.time(7)),
        updatedAt: DateTime.makeUnsafe(fixture.time(8)),
      },
    };
    const nextInput = {
      ...input,
      visibleTurnItems: [...visibleTurnItems.slice(0, -1), nextItem],
      attachmentUrlById: new Map(input.attachmentUrlById),
    };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    for (const [index, entry] of previous.entries.slice(0, -1).entries()) {
      expect(next.entries[index]).toBe(entry);
    }
    const beforeMessage = previous.entries.at(-1)!;
    const nextMessage = next.entries.at(-1)!;
    if (beforeMessage.kind !== "message" || nextMessage.kind !== "message") {
      throw new Error("Expected assistant entries");
    }
    expect(nextMessage.message.attachments).toBe(beforeMessage.message.attachments);
    expect(nextMessage.projectedItem).toBe(nextItem);
    expect(nextMessage.message.text).toBe("Next token");
    expect(beforeMessage.message.text).toBe("Partial");

    const renewedInput = {
      ...nextInput,
      attachmentUrlById: new Map([[attachment.id, "https://renewed.test/image"]]),
    };
    const renewed = deriveTimelineEntriesFromVisibleTurnItemsWithState(renewedInput, next);
    expect(renewed.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(renewedInput));
    expect(renewed.entries.at(-1)).toMatchObject({
      message: { attachments: [{ previewUrl: "https://renewed.test/image" }] },
    });
    expect(nextMessage.message.attachments?.[0]).toMatchObject({
      previewUrl: "https://server.test/image",
    });
    const restoredInput = { ...renewedInput, attachmentUrlById: new Map<string, string>() };
    const restored = deriveTimelineEntriesFromVisibleTurnItemsWithState(restoredInput, renewed);
    expect(restored.entries.at(-1)).toMatchObject({ message: { attachments: [attachment] } });
    const restoredMessage = restored.entries.at(-1)!;
    if (restoredMessage.kind !== "message") throw new Error("Expected assistant entry");
    expect(restoredMessage.message.attachments?.[0]).not.toHaveProperty("previewUrl");
  });

  it("appends committed items in canonical order even when their timestamps go backwards", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const input = { visibleTurnItems: fixture.visibleTurnItems, optimisticMessages: [] };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const last = fixture.visibleTurnItems.at(-1)!;
    const appended = {
      ...last,
      position: last.position + 1,
      sourceItemId: TurnItemId.make("late-item"),
      item: {
        ...last.item,
        id: TurnItemId.make("late-item"),
        messageId: MessageId.make("late-message"),
        startedAt: DateTime.makeUnsafe(fixture.time(0)),
      },
    };
    const nextInput = { ...input, visibleTurnItems: [...input.visibleTurnItems, appended] };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    expect(next.entries.at(-1)).toMatchObject({ id: "late-message" });
    for (const [index, entry] of previous.entries.entries())
      expect(next.entries[index]).toBe(entry);
  });

  it.each(["completion", "provenance", "ordering", "attachment", "run"] as const)(
    "rebuilds entries for a %s change instead of retaining stale v2 metadata",
    (change) => {
      const fixture = makeStreamingTimelineFixture("Partial");
      const input = { visibleTurnItems: fixture.visibleTurnItems, optimisticMessages: [] };
      const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
      const last = fixture.visibleTurnItems.at(-1)!;
      if (last.item.type !== "assistant_message") throw new Error("Expected assistant fixture");
      const changed =
        change === "provenance"
          ? { ...last, sourceThreadId: ThreadId.make("inherited-thread") }
          : {
              ...last,
              item:
                change === "completion"
                  ? { ...last.item, streaming: false, status: "completed" as const }
                  : change === "ordering"
                    ? { ...last.item, startedAt: DateTime.makeUnsafe(fixture.time(0)) }
                    : change === "run"
                      ? { ...last.item, runId: fixture.historyRunId }
                      : {
                          ...last.item,
                          attachments: [
                            {
                              type: "image",
                              id: "new-image",
                              name: "new.png",
                              mimeType: "image/png",
                              sizeBytes: 42,
                            },
                          ],
                        },
            };
      const nextInput = {
        ...input,
        visibleTurnItems: [...input.visibleTurnItems.slice(0, -1), changed],
      };
      const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
      expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
      expect(next.entries.at(-1)).not.toBe(previous.entries.at(-1));
    },
  );

  it("updates fallback timestamps when the provider has not supplied a message start time", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const visibleTurnItems = fixture.visibleTurnItems.map((row) =>
      row.item.type === "assistant_message" && row.item.streaming
        ? { ...row, item: { ...row.item, startedAt: null } }
        : row,
    );
    const input = { visibleTurnItems, optimisticMessages: [] };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const nextInput = {
      ...input,
      visibleTurnItems: visibleTurnItems.map((row) =>
        row.item.type === "assistant_message" && row.item.streaming
          ? {
              ...row,
              item: {
                ...row.item,
                text: "Next token",
                updatedAt: DateTime.makeUnsafe(fixture.time(8)),
              },
            }
          : row,
      ),
    };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    expect(next.entries.at(-1)?.createdAt).toBe(fixture.time(8));
  });

  it("keeps unchanged message previews while tool output rebuilds the work log", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const input = { visibleTurnItems: fixture.visibleTurnItems, optimisticMessages: [] };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const nextInput = {
      ...input,
      visibleTurnItems: input.visibleTurnItems.map((row) =>
        row.item.type === "command_execution"
          ? { ...row, item: { ...row.item, output: "Additional output" } }
          : row,
      ),
    };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    for (const [index, entry] of previous.entries.entries()) {
      if (entry.kind === "message") expect(next.entries[index]).toBe(entry);
    }
  });

  it("deduplicates optimistic sends when committed items arrive and retains anchored ordering", () => {
    const fixture = makeStreamingTimelineFixture();
    const input = {
      visibleTurnItems: fixture.visibleTurnItems.slice(0, 3),
      optimisticMessages: [
        {
          id: MessageId.make("live-user"),
          runId: null,
          role: "user" as const,
          text: "Continue",
          streaming: false,
          createdAt: fixture.time(5),
          updatedAt: fixture.time(5),
        },
      ],
      anchoredMessages: [
        {
          id: MessageId.make("feedback"),
          runId: null,
          role: "assistant" as const,
          text: "Feedback received",
          streaming: false,
          createdAt: fixture.time(4),
          updatedAt: fixture.time(4),
        },
      ],
    };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const nextInput = { ...input, visibleTurnItems: fixture.visibleTurnItems };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    expect(next.entries.filter((entry) => entry.id === "live-user")).toHaveLength(1);
    expect(next.entries.map((entry) => entry.id)).toEqual([
      "history-user",
      "history-work",
      "history-assistant",
      "feedback",
      "live-user",
      "live-work",
      "live-assistant",
    ]);
  });
});

describe("image asset requests", () => {
  const image = {
    type: "image" as const,
    id: "image",
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 42,
  };
  const message = {
    id: MessageId.make("image-message"),
    role: "user" as const,
    text: "Inspect these images",
    runId: null,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    streaming: false,
    attachments: [image],
  };

  it("requests the whole row's gallery and crops without signing local preview IDs", () => {
    const attachments = Object.freeze([
      image,
      { ...image, id: "second" },
      { ...image, id: "crop", name: "preview-annotation-1.png" },
      { ...image, id: "local", previewUrl: "blob:local" },
      { ...image, id: "inline", previewUrl: "data:image/png;base64,AA==" },
      { ...image, id: "provided", previewUrl: "https://preview.test/image" },
      { ...image, type: "file" as const, id: "file", mimeType: "application/pdf" },
      { ...image, type: "future", id: "unknown" },
      image,
    ]);

    expect(selectMessageImageResources(attachments)).toEqual([
      { _tag: "attachment", attachmentId: "image" },
      { _tag: "attachment", attachmentId: "second" },
      { _tag: "attachment", attachmentId: "crop" },
      { _tag: "attachment", attachmentId: "provided" },
    ]);
  });

  it("requests offscreen handoffs without signing the rest of the loaded history", () => {
    const history = {
      ...message,
      id: MessageId.make("history"),
      attachments: [{ ...image, id: "history-image" }],
    };
    const offscreen = {
      ...message,
      id: MessageId.make("offscreen"),
      attachments: [image, { ...image, id: "crop", name: "preview-annotation-1.png" }],
    };
    const empty = {
      ...message,
      id: MessageId.make("empty"),
      attachments: [{ ...image, id: "empty" }],
    };
    const assistant = {
      ...message,
      id: MessageId.make("assistant"),
      role: "assistant" as const,
      attachments: [{ ...image, id: "assistant-image" }],
    };
    expect(
      selectHandoffImageResources([history, message, offscreen, empty, assistant], {
        [message.id]: ["blob:message"],
        [offscreen.id]: ["blob:offscreen", "blob:crop"],
        [empty.id]: [],
        [assistant.id]: ["blob:unused"],
      }),
    ).toEqual([
      { _tag: "attachment", attachmentId: "image" },
      { _tag: "attachment", attachmentId: "crop" },
    ]);
  });

  it("does not scan history when no handoff is pending", () => {
    let reads = 0;
    const messages = new Proxy([message], {
      get(target, property, receiver) {
        if (property === "0") reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const empty = selectHandoffImageResources(messages, {});
    expect(reads).toBe(0);
    expect(empty).toHaveLength(0);
    expect(selectHandoffImageResources(undefined, { missing: ["blob:missing"] })).toBe(empty);
    expect(selectMessageImageResources(undefined)).toBe(empty);
  });

  it("hands signed URLs to a mounted row only after the local preview is released", () => {
    const server = createMessageAttachmentPreviewProjector();
    const handoff = createMessageAttachmentPreviewProjector();
    const row = createMessageAttachmentPreviewProjector();
    const pending = handoff(
      server(message, () => undefined),
      () => "blob:pending",
    );
    expect(selectMessageImageResources(pending.attachments)).toEqual([]);
    expect(selectHandoffImageResources([message], { [message.id]: ["blob:pending"] })).toEqual([
      { _tag: "attachment", attachmentId: image.id },
    ]);

    const ready = server(message, () => "https://server.test/image");
    expect(selectMessageImageResources(handoff(ready, () => "blob:pending").attachments)).toEqual(
      [],
    );
    const released = server(message, () => undefined);
    expect(selectMessageImageResources(released.attachments)).toEqual([
      { _tag: "attachment", attachmentId: image.id },
    ]);
    const displayed = row(released, () => "https://server.test/image");
    expect(displayed).toEqual(ready);
    expect(pending.attachments?.[0]).toMatchObject({ previewUrl: "blob:pending" });
    expect(row(released, () => "https://server.test/renewed").attachments?.[0]).toMatchObject({
      previewUrl: "https://server.test/renewed",
    });
    expect(displayed.attachments?.[0]).toMatchObject({ previewUrl: "https://server.test/image" });
    expect(row(released, () => undefined)).toBe(message);
  });
});

describe("deriveTimelineEntries", () => {
  const streamingMessage = {
    id: MessageId.make("streaming-message"),
    role: "assistant" as const,
    text: "",
    runId: RunId.make("streaming-run"),
    createdAt: "2026-02-23T00:00:03.000Z",
    updatedAt: "2026-02-23T00:00:03.000Z",
    streaming: true,
  };

  it("reuses preview objects while preserving URL and attachment metadata changes", () => {
    const image = {
      type: "image" as const,
      id: "image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    const file = {
      type: "file" as const,
      id: "file",
      name: "file.txt",
      mimeType: "text/plain",
      sizeBytes: 8,
    };
    const message = { ...streamingMessage, attachments: Object.freeze([image, file]) };
    const project = createMessageAttachmentPreviewProjector();
    const urls = new Map([[image.id, "https://first.test/image"]]);
    const first = project(message, (attachment) => urls.get(attachment.id));
    Object.freeze(first.attachments);
    expect(project(message, (attachment) => new Map(urls).get(attachment.id))).toBe(first);
    const streamed = project({ ...message, text: "Next" }, (attachment) => urls.get(attachment.id));
    expect(streamed.attachments).toBe(first.attachments);
    expect(streamed.text).toBe("Next");
    expect(first.text).toBe("");
    expect(first.attachments?.[1]).toBe(file);

    urls.set(image.id, "https://second.test/image");
    const renewed = project(message, (attachment) => urls.get(attachment.id));
    expect(renewed.attachments?.[0]).toMatchObject({ previewUrl: "https://second.test/image" });
    expect(first.attachments?.[0]).toMatchObject({ previewUrl: "https://first.test/image" });
    const renamed = project(
      { ...message, attachments: [{ ...image, name: "renamed.png" }, file] },
      (attachment) => urls.get(attachment.id),
    );
    expect(renamed.attachments?.[0]).toMatchObject({
      name: "renamed.png",
      previewUrl: "https://second.test/image",
    });
    expect(project(message, () => undefined)).toBe(message);
  });

  it("keeps pending preview handoffs stable and restores the current server URL", () => {
    const message = {
      ...streamingMessage,
      role: "user" as const,
      streaming: false,
      attachments: [
        {
          type: "image" as const,
          id: "image",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 42,
        },
      ],
    };
    const server = createMessageAttachmentPreviewProjector();
    const handoff = createMessageAttachmentPreviewProjector();
    const first = handoff(
      server(message, () => undefined),
      () => "blob:handoff",
    );
    expect(
      handoff(
        server(message, () => undefined),
        () => "blob:handoff",
      ),
    ).toBe(first);
    const ready = server(message, () => "https://server.test/image");
    expect(handoff(ready, () => "blob:handoff").attachments?.[0]).toMatchObject({
      previewUrl: "blob:handoff",
    });
    expect(handoff(ready, () => undefined)).toBe(ready);
    expect(ready.attachments?.[0]).toMatchObject({ previewUrl: "https://server.test/image" });
    expect(first.attachments?.[0]).toMatchObject({ previewUrl: "blob:handoff" });
  });

  it("reuses ordered history without changing an earlier projection", () => {
    const history = { ...streamingMessage, id: MessageId.make("history"), streaming: false };
    const work = [
      { id: "work", createdAt: history.createdAt, label: "Ran tests", tone: "tool" as const },
    ];
    const first = deriveTimelineEntriesWithState([history, streamingMessage], [], work);
    Object.freeze(first.entries);
    for (const entry of first.entries) Object.freeze(entry);

    const firstMessage = {
      ...streamingMessage,
      text: "First",
      updatedAt: "2026-02-23T00:00:04.000Z",
    };
    const secondMessage = {
      ...streamingMessage,
      text: "Second",
      updatedAt: "2026-02-23T00:00:05.000Z",
    };
    const firstBranch = deriveTimelineEntriesWithState([history, firstMessage], [], work, first);
    const secondBranch = deriveTimelineEntriesWithState([history, secondMessage], [], work, first);

    expect(firstBranch.entries).toEqual(deriveTimelineEntries([history, firstMessage], [], work));
    expect(secondBranch.entries).toEqual(deriveTimelineEntries([history, secondMessage], [], work));
    expect(firstBranch.entries[0]).toBe(first.entries[0]);
    expect(firstBranch.entries[2]).toBe(first.entries[2]);
    expect(first.entries[1]).toMatchObject({ message: { text: "" } });
    expect(firstBranch.entries[1]).toMatchObject({ message: { text: "First" } });
  });

  it("preserves stable source ordering for ties, append, and older pages", () => {
    const plan = {
      id: PlanId.make("plan:thread:run"),
      runId: streamingMessage.runId,
      planMarkdown: "Plan",
      status: "active" as const,
      createdAt: streamingMessage.createdAt,
      updatedAt: streamingMessage.createdAt,
    };
    const firstWork = {
      id: "work-1",
      createdAt: streamingMessage.createdAt,
      label: "Ran tests",
      tone: "tool" as const,
    };
    const first = deriveTimelineEntriesWithState([streamingMessage], [plan], [firstWork]);
    const appendedMessage = { ...streamingMessage, id: MessageId.make("appended") };
    const appendedWork = { ...firstWork, id: "work-2" };
    const messages = [streamingMessage, appendedMessage];
    const work = [firstWork, appendedWork];
    const appended = deriveTimelineEntriesWithState(messages, [plan], work, first);
    expect(appended.entries.map((entry) => entry.id)).toEqual([
      streamingMessage.id,
      appendedMessage.id,
      plan.id,
      firstWork.id,
      appendedWork.id,
    ]);
    expect(appended.entries[0]).toBe(first.entries[0]);

    const older = {
      ...streamingMessage,
      id: MessageId.make("older"),
      createdAt: "2026-02-22T00:00:00.000Z",
    };
    const prepended = deriveTimelineEntriesWithState([older, ...messages], [plan], work, appended);
    expect(prepended.entries).toEqual(deriveTimelineEntries([older, ...messages], [plan], work));
    const corrected = {
      ...streamingMessage,
      createdAt: "2026-02-24T00:00:00.000Z",
      streaming: false,
    };
    expect(
      deriveTimelineEntriesWithState([corrected, appendedMessage], [plan], work, appended).entries,
    ).toEqual(deriveTimelineEntries([corrected, appendedMessage], [plan], work));
  });

  it("keeps Scient task-plan rows during streaming, append, and plan replacement", () => {
    const plan = {
      id: "task-plan",
      createdAt: streamingMessage.createdAt,
      turnId: TurnId.make("streaming-turn"),
      plan: {
        createdAt: streamingMessage.createdAt,
        runId: streamingMessage.runId,
        steps: [{ step: "Review", status: "pending" as const }],
      },
    };
    const first = deriveTimelineEntriesWithState([streamingMessage], [], [], null, [plan]);
    const streamed = {
      ...streamingMessage,
      text: "Reviewing",
      updatedAt: "2026-02-23T00:00:05.000Z",
    };
    const next = deriveTimelineEntriesWithState([streamed], [], [], first, [plan]);
    expect(next.entries).toEqual(deriveTimelineEntries([streamed], [], [], [plan]));
    expect(next.entries.find((entry) => entry.kind === "turn-plan")).toBe(
      first.entries.find((entry) => entry.kind === "turn-plan"),
    );
    const added = { ...plan, id: "another-task-plan" };
    const appended = deriveTimelineEntriesWithState([streamed], [], [], next, [plan, added]);
    expect(appended.entries).toEqual(deriveTimelineEntries([streamed], [], [], [plan, added]));
    const completed = {
      ...plan,
      plan: { ...plan.plan, steps: [{ step: "Review", status: "completed" as const }] },
    };
    const replaced = deriveTimelineEntriesWithState([streamed], [], [], appended, [
      completed,
      added,
    ]);
    expect(replaced.entries).toEqual(deriveTimelineEntries([streamed], [], [], [completed, added]));
    expect(first.entries.find((entry) => entry.kind === "turn-plan")).toMatchObject({
      turnPlan: { plan: { steps: [{ status: "pending" }] } },
    });
  });

  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          runId: null,
          updatedAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: PlanId.make("plan:thread-1:run:run-1"),
          runId: RunId.make("run-1"),
          planMarkdown: "# Ship it",
          status: "active" as const,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran tests",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        id: PlanId.make("plan:thread-1:run:run-1"),
        runId: RunId.make("run-1"),
        planMarkdown: "# Ship it",
      },
    });
  });
});

describe("isLatestRunSettled", () => {
  const latestRun = {
    runId: RunId.make("run-1"),
    status: "completed",
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns false while the same run is still active in a running session", () => {
    expect(
      isLatestRunSettled(latestRun, {
        status: "running",
        activeRunId: RunId.make("run-1"),
      }),
    ).toBe(false);
  });

  it("returns true once the runtime owns a different run than the latest settled one", () => {
    expect(
      isLatestRunSettled(latestRun, {
        status: "running",
        activeRunId: RunId.make("run-2"),
      }),
    ).toBe(true);
  });

  it("returns true once the session is idle and no run is active", () => {
    expect(
      isLatestRunSettled(latestRun, {
        status: "idle",
        activeRunId: null,
      }),
    ).toBe(true);
  });

  it("returns false when the latest run is still in flight by status", () => {
    expect(
      isLatestRunSettled(
        {
          runId: RunId.make("run-1"),
          status: "running",
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: null,
        },
        null,
      ),
    ).toBe(false);
  });

  it("settles on run status alone, ignoring timestamp completeness", () => {
    expect(
      isLatestRunSettled(
        {
          runId: RunId.make("run-1"),
          status: "completed",
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(true);
  });

  it("returns false when there is no latest run at all", () => {
    expect(isLatestRunSettled(null, null)).toBe(false);
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const completedRun = {
    runId: RunId.make("run-1"),
    status: "completed",
    requestedAt: "2026-02-27T21:09:00.000Z",
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("prefers the in-flight run start while the runtime still owns that run", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          runId: RunId.make("run-1"),
          status: "running",
          requestedAt: "2026-02-27T21:09:00.000Z",
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: null,
        },
        {
          status: "running",
          activeRunId: RunId.make("run-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
  });

  it("falls back to the request time when an owned run never reported a start", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          runId: RunId.make("run-1"),
          status: "preparing",
          requestedAt: "2026-02-27T21:09:00.000Z",
          startedAt: null,
          completedAt: null,
        },
        {
          status: "preparing",
          activeRunId: RunId.make("run-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:09:00.000Z");
  });

  it("prefers the runtime activity clock over any run timestamp", () => {
    expect(
      deriveActiveWorkStartedAt(
        completedRun,
        {
          status: "running",
          activeRunId: RunId.make("run-2"),
          activityStartedAt: "2026-02-27T21:12:00.000Z",
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:12:00.000Z");
  });

  it("suppresses the local send clock once the runtime owns an active run", () => {
    expect(
      deriveActiveWorkStartedAt(
        completedRun,
        {
          status: "running",
          activeRunId: RunId.make("run-2"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBeNull();
  });

  it("uses sendStartedAt once no run is active", () => {
    expect(
      deriveActiveWorkStartedAt(
        completedRun,
        {
          status: "idle",
          activeRunId: null,
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("uses sendStartedAt for a fresh send when the thread has no run history", () => {
    expect(deriveActiveWorkStartedAt(null, null, "2026-02-27T21:11:00.000Z")).toBe(
      "2026-02-27T21:11:00.000Z",
    );
  });
});

it("renders automatic completion as a work entry instead of a user bubble", () => {
  const now = DateTime.makeUnsafe("2026-09-09T00:00:00Z");
  const item = {
    id: TurnItemId.make("wake-item"),
    threadId: ThreadId.make("parent"),
    runId: RunId.make("wake-run"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "notification" as const,
    source: { kind: "delegated_task" as const, taskIds: [NodeId.make("task-1")] },
    outcome: "unknown" as const,
    summary: "Delegated task finished",
  };
  const row = {
    item,
    position: 0,
    visibility: "local" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
  };
  const entries = deriveTimelineEntriesFromVisibleTurnItems({
    optimisticMessages: [],
    visibleTurnItems: [row],
  });
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    kind: "work",
    entry: { label: "Delegated task finished", tone: "info", projectedItem: row },
  });
  expect(
    deriveTimelineEntriesFromVisibleTurnItems({
      optimisticMessages: [],
      visibleTurnItems: [
        {
          ...row,
          item: {
            ...item,
            type: "user_message",
            messageId: MessageId.make("wake-message"),
            createdBy: "agent" as const,
            creationSource: "server" as const,
            inputIntent: "turn_start" as const,
            attachments: [],
            text: "Delegated task node:task-1 reached a terminal state. Use task_status with taskId node:task-1 to read the result.",
          },
        },
      ],
    })[0]?.kind,
  ).toBe("message");
});
