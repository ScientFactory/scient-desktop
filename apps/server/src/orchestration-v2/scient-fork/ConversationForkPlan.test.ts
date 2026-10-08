import { assert, it } from "@effect/vitest";
import {
  ComposerContextId,
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  questionAnswerMessageId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HistoricalSystemMessage,
  HISTORICAL_SYSTEM_MESSAGE_TOOL_NAME,
  readHistoricalSystemMessage,
} from "../legacy/HistoricalSystemMessage.ts";
import { emptyProjection } from "../ProjectionStore.ts";
import { planConversationFork } from "./ConversationForkPlan.ts";
import { presentInheritedItem } from "./ForkHistory.ts";
import { historicalMessage } from "../ContextHandoffBudget.ts";

const now = DateTime.makeUnsafe("2026-10-03T00:00:00.000Z");
const decodeHistoricalSystemMessage = Schema.decodeUnknownEffect(HistoricalSystemMessage);
const threadId = ThreadId.make("fork-source");
const targetThreadId = ThreadId.make("fork-destination");
const instanceId = ProviderInstanceId.make("codex-one");
const modelSelection = { instanceId, model: "test-model" };
const completed = RunId.make("completed-source-run");
const running = RunId.make("running-source-run");
const attachment = {
  type: "file" as const,
  id: "fork-source-11111111-1111-1111-1111-111111111111-pdf",
  name: "evidence.pdf",
  mimeType: "application/pdf",
  sizeBytes: 100,
};

function makeProjection() {
  const base = emptyProjection({
    id: EventId.make("created"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      id: threadId,
      createdBy: "user",
      creationSource: "web",
      projectId: ProjectId.make("fork-project"),
      title: "Source",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  const runs: OrchestrationV2Run[] = [completed, running].map((id, index) => ({
    id,
    threadId,
    ordinal: index + 1,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(index === 0 ? "question-one" : "question-two"),
    rootNodeId: NodeId.make(`root-${id}`),
    activeAttemptId: null,
    status: index === 0 ? "completed" : "running",
    requestedAt: now,
    startedAt: now,
    completedAt: index === 0 ? now : null,
    checkpointId: null,
    contextHandoffId: null,
  }));
  const itemBase = {
    threadId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  const turnItems: OrchestrationV2TurnItem[] = [
    {
      ...itemBase,
      id: TurnItemId.make("question-one"),
      runId: completed,
      ordinal: 0,
      status: "completed",
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      inputIntent: "turn_start",
      messageId: MessageId.make("question-one"),
      text: "First question",
      attachments: [attachment],
      context: {
        version: 1,
        records: [
          {
            version: 1,
            contextId: ComposerContextId.make("file-context"),
            label: attachment.name,
            kind: "file",
            attachmentId: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          },
        ],
      },
    },
    {
      ...itemBase,
      id: TurnItemId.make("tool-one"),
      runId: completed,
      ordinal: 1,
      status: "completed",
      type: "command_execution",
      input: "inspect evidence",
      output: "Evidence found",
      exitCode: 0,
    },
    {
      ...itemBase,
      id: TurnItemId.make("answer-one"),
      runId: completed,
      nodeId: runs[0]!.rootNodeId,
      ordinal: 2,
      status: "completed",
      type: "assistant_message",
      messageId: MessageId.make("answer-one"),
      text: "First answer",
      streaming: false,
    },
    {
      ...itemBase,
      id: TurnItemId.make("question-two"),
      runId: running,
      ordinal: 3,
      status: "completed",
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      inputIntent: "turn_start",
      messageId: MessageId.make("question-two"),
      text: "Second question",
      attachments: [],
    },
    {
      ...itemBase,
      id: TurnItemId.make("pending-approval"),
      runId: running,
      ordinal: 4,
      status: "pending",
      type: "approval_request",
      requestId: RuntimeRequestId.make("source-request"),
      requestKind: "command",
      prompt: "Run the command?",
    },
    {
      ...itemBase,
      id: TurnItemId.make("partial-answer"),
      runId: running,
      nodeId: runs[1]!.rootNodeId,
      ordinal: 5,
      status: "running",
      type: "assistant_message",
      messageId: MessageId.make("partial-answer"),
      text: "Working",
      streaming: true,
    },
    {
      ...itemBase,
      id: TurnItemId.make("steer"),
      runId: running,
      ordinal: 6,
      status: "completed",
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      inputIntent: "steer",
      messageId: MessageId.make("steer"),
      text: "Please check again",
      attachments: [],
    },
  ];
  const messages: OrchestrationV2ConversationMessage[] = turnItems.flatMap((item) =>
    item.type === "user_message" || item.type === "assistant_message"
      ? [
          {
            id: item.messageId,
            threadId,
            runId: item.runId,
            nodeId: item.nodeId,
            createdBy: item.type === "user_message" ? ("user" as const) : ("agent" as const),
            creationSource: "web" as const,
            role: item.type === "user_message" ? ("user" as const) : ("assistant" as const),
            text: item.text,
            attachments: item.attachments ?? [],
            streaming: item.type === "assistant_message" && item.streaming,
            createdAt: now,
            updatedAt: now,
            ...(item.type === "user_message" && item.context ? { context: item.context } : {}),
          },
        ]
      : [],
  );
  return {
    ...base,
    runs,
    nodes: runs.map((run): OrchestrationV2ExecutionNode => ({
      id: run.rootNodeId!,
      threadId,
      runId: run.id,
      parentNodeId: null,
      rootNodeId: run.rootNodeId!,
      kind: "root_turn",
      status: run.status === "completed" ? "completed" : "running",
      countsForRun: true,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: run.completedAt,
    })),
    turnItems,
    messages,
    visibleTurnItems: turnItems.map((item, position) => ({
      item,
      position,
      sourceThreadId: threadId,
      sourceItemId: item.id,
      visibility: "local" as const,
    })),
  };
}

/** The fork's history as readers show it: shared items frozen, copies as planned. */
function shown(
  plan: Effect.Success<ReturnType<typeof planConversationFork>>,
  projection: {
    readonly visibleTurnItems: ReadonlyArray<{
      readonly sourceItemId: TurnItemId;
      readonly item: OrchestrationV2TurnItem;
    }>;
  },
): ReadonlyArray<OrchestrationV2TurnItem> {
  const copies = new Map(plan.items.map((item) => [item.id, item]));
  const sources = new Map(projection.visibleTurnItems.map((row) => [row.sourceItemId, row.item]));
  return plan.history.map((entry, position) =>
    entry.sourceThreadId === targetThreadId
      ? copies.get(entry.sourceItemId)!
      : presentInheritedItem(sources.get(entry.sourceItemId)!, position, targetThreadId),
  );
}

it.effect(
  "freezes a completed prefix and shares its attachments and context with the destination",
  () =>
    Effect.gen(function* () {
      const projection = makeProjection();
      const plan = yield* planConversationFork({
        projection,
        targetThreadId,
        source: { kind: "assistant-response", messageId: MessageId.make("answer-one") },
      });
      const history = shown(plan, projection);
      assert.deepEqual(
        history.map((item) => item.type),
        ["user_message", "command_execution", "assistant_message"],
      );
      // Nothing settled is copied: the fork lists the original items in order.
      assert.deepEqual(plan.items, []);
      assert.deepEqual(plan.messages, []);
      assert.deepEqual(
        plan.history.map((entry) => entry.sourceThreadId),
        [threadId, threadId, threadId],
      );
      assert.ok(history.every((item) => item.runId === null && item.nodeId === null));
      // Files are shared, not copied: each retained file maps to itself.
      assert.deepEqual(plan.attachmentCopies, [{ source: attachment, target: attachment }]);
      const user = history[0]!;
      assert.ok(user.type === "user_message");
      assert.equal(user.attachments[0]!.id, attachment.id);
      assert.equal(user.context?.records[0]?.kind, "file");
      assert.deepEqual(user.inheritedFrom, {
        threadId,
        itemId: TurnItemId.make("question-one"),
        runId: completed,
        status: "completed",
      });
    }),
);

it.effect("a user or steering-message fork retains the prefix before its run", () =>
  Effect.gen(function* () {
    for (const id of ["question-two", "steer"]) {
      const plan = yield* planConversationFork({
        projection: makeProjection(),
        targetThreadId,
        source: { kind: "user-message", messageId: MessageId.make(id) },
      });
      assert.deepEqual(
        shown(plan, makeProjection()).map((item) => item.type),
        ["user_message", "command_execution", "assistant_message"],
      );
      assert.deepEqual(plan.messages, []);
    }
  }),
);

it.effect("copies plan identity and completion state into inert destination-owned artifacts", () =>
  Effect.gen(function* () {
    for (const status of ["active", "completed"] as const) {
      let projection = makeProjection();
      const planId = PlanId.make("source-plan");
      const source = projection.turnItems[1]!;
      if (source.type !== "command_execution") return assert.fail("Missing source tool boundary");
      const sourcePlan = {
        ...source,
        id: TurnItemId.make("source-plan-item"),
        type: "proposed_plan" as const,
        planId,
        markdown: "# Read the evidence",
        streaming: false,
      };
      projection.visibleTurnItems.splice(2, 0, {
        item: sourcePlan,
        position: 1.5,
        sourceThreadId: threadId,
        sourceItemId: sourcePlan.id,
        visibility: "local",
      });
      projection = {
        ...projection,
        plans: [
          {
            id: planId,
            threadId,
            runId: completed,
            nodeId: NodeId.make("source-plan-node"),
            status,
            kind: "proposed_plan",
            markdown: sourcePlan.markdown,
          },
        ],
      };
      const frozen = yield* planConversationFork({
        projection,
        targetThreadId,
        source: { kind: "assistant-response", messageId: MessageId.make("answer-one") },
      });
      assert.equal(frozen.plans.length, 1);
      const artifact = frozen.plans[0]!;
      assert.notEqual(artifact.id, planId);
      assert.equal(artifact.status, status);
      assert.equal(artifact.threadId, targetThreadId);
      assert.equal(artifact.runId, null);
      assert.equal(
        frozen.items.find((item) => item.type === "proposed_plan")?.nodeId,
        artifact.nodeId,
      );
      const node = frozen.nodes[0]!;
      assert.equal(node.id, artifact.nodeId);
      assert.equal(node.countsForRun, false);
      assert.equal(node.runId, null);
      assert.equal(node.runtimeRequestId, null);
      assert.equal(node.providerThreadId, null);
      assert.equal(node.status, "completed");
    }
  }),
);

it.effect("a running fork freezes partial text and keeps pending approvals inert", () =>
  Effect.gen(function* () {
    const plan = yield* planConversationFork({
      projection: makeProjection(),
      targetThreadId,
      source: { kind: "running-turn", runId: running },
    });
    const approval = plan.items.find((item) => item.type === "approval_request");
    assert.ok(approval?.type === "approval_request");
    assert.equal(approval.status, "cancelled");
    assert.equal(approval.inheritedFrom?.status, "pending");
    assert.notEqual(approval.requestId, "source-request");
    const partial = plan.items.find(
      (item) => item.type === "assistant_message" && item.text === "Working",
    );
    assert.ok(partial?.type === "assistant_message");
    assert.equal(partial.streaming, false);
    assert.equal(partial.status, "interrupted");
    assert.equal(plan.messages.find((message) => message.text === "Working")?.streaming, false);
  }),
);

it.effect("a running fork's copied answered question keeps its folded answer message", () =>
  Effect.gen(function* () {
    const projection = makeProjection();
    const steer = projection.turnItems.find((item) => item.id === "steer")!;
    // Codex answers a message-mode question by steering `async-answer:<request id>`.
    const question: OrchestrationV2TurnItem = {
      id: TurnItemId.make("running-question"),
      threadId,
      runId: running,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 7,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "user_input_request",
      requestId: RuntimeRequestId.make("running-request"),
      responseMode: "message",
      questions: [{ id: "dataset", header: "Data", question: "Which dataset?", options: [] }],
      questionAnswer: {
        requestId: "running-request",
        answers: { dataset: "B" },
        attachmentsByQuestionId: {},
      },
    };
    const answer: OrchestrationV2TurnItem = {
      ...steer,
      id: TurnItemId.make("running-answer"),
      ordinal: 8,
      messageId: MessageId.make("async-answer:running-request"),
      text: "B",
    } as OrchestrationV2TurnItem;
    const answerMessage = {
      ...projection.messages.find((message) => message.id === "steer")!,
      id: MessageId.make("async-answer:running-request"),
      text: "B",
    };
    const turnItems = [...projection.turnItems, question, answer];
    const plan = yield* planConversationFork({
      projection: {
        ...projection,
        turnItems,
        messages: [...projection.messages, answerMessage],
        visibleTurnItems: turnItems.map((item, position) => ({
          item,
          position,
          sourceThreadId: threadId,
          sourceItemId: item.id,
          visibility: "local" as const,
        })),
      },
      targetThreadId,
      source: { kind: "running-turn", runId: running },
    });
    const copied = plan.items.find((item) => item.type === "user_input_request");
    assert.ok(copied?.type === "user_input_request" && copied.questionAnswer !== undefined);
    assert.notEqual(copied.requestId, "running-request");
    const copiedAnswer = plan.messages.find((message) => message.text === "B");
    assert.ok(copiedAnswer);
    assert.notEqual(copiedAnswer.id, answerMessage.id);
    assert.equal(questionAnswerMessageId(copied.questionAnswer), copiedAnswer.id);
  }),
);

it.effect("a running fork's copies name copied parents by their copies", () =>
  Effect.gen(function* () {
    const projection = makeProjection();
    const turnItems = projection.turnItems.map((item) =>
      item.id === "partial-answer"
        ? { ...item, parentItemId: TurnItemId.make("pending-approval") }
        : item.id === "steer"
          ? { ...item, parentItemId: TurnItemId.make("answer-one") }
          : item,
    );
    const plan = yield* planConversationFork({
      projection: {
        ...projection,
        turnItems,
        visibleTurnItems: turnItems.map((item, position) => ({
          item,
          position,
          sourceThreadId: threadId,
          sourceItemId: item.id,
          visibility: "local" as const,
        })),
      },
      targetThreadId,
      source: { kind: "running-turn", runId: running },
    });
    const approval = plan.items.find((item) => item.type === "approval_request")!;
    const partial = plan.items.find((item) => item.inheritedFrom?.itemId === "partial-answer")!;
    const steer = plan.items.find((item) => item.inheritedFrom?.itemId === "steer")!;
    assert.equal(partial.parentItemId, approval.id);
    assert.notEqual(approval.id, "pending-approval");
    // The completed run's answer is shared, under its own id.
    assert.equal(steer.parentItemId, "answer-one");
  }),
);

it.effect("rejects missing, streaming, and nested response boundaries", () =>
  Effect.gen(function* () {
    const projection = makeProjection();
    for (const id of ["missing", "partial-answer"]) {
      const exit = yield* Effect.exit(
        planConversationFork({
          projection,
          targetThreadId,
          source: { kind: "assistant-response", messageId: MessageId.make(id) },
        }),
      );
      assert.equal(exit._tag, "Failure");
    }
    const answer = projection.turnItems[2]!;
    projection.visibleTurnItems[2] = {
      ...projection.visibleTurnItems[2]!,
      item: { ...answer, nodeId: NodeId.make("nested-task") },
    };
    assert.equal(
      (yield* Effect.exit(
        planConversationFork({
          projection,
          targetThreadId,
          source: { kind: "assistant-response", messageId: MessageId.make("answer-one") },
        }),
      ))._tag,
      "Failure",
    );
  }),
);

it.effect("refuses a running-turn fork after its durable run has settled", () =>
  Effect.gen(function* () {
    for (const status of ["completed", "failed", "interrupted", "cancelled"] as const) {
      const projection = makeProjection();
      projection.runs[1] = { ...projection.runs[1]!, status, completedAt: now };
      const result = yield* Effect.result(
        planConversationFork({
          projection,
          targetThreadId,
          source: { kind: "running-turn", runId: running },
        }),
      );
      assert.equal(result._tag, "Failure", status);
      if (result._tag === "Failure") assert.include(result.failure.message, "no longer active");
    }
  }),
);

it.effect("accepts a direct assistant-message child owned by the response's run", () =>
  Effect.gen(function* () {
    const projection = makeProjection();
    const root = projection.nodes[0]!;
    const child = {
      ...root,
      id: NodeId.make("ordinary-answer-node"),
      parentNodeId: root.id,
      kind: "assistant_message" as const,
      countsForRun: false,
    };
    projection.nodes.push(child);
    projection.visibleTurnItems[2] = {
      ...projection.visibleTurnItems[2]!,
      item: { ...projection.turnItems[2]!, nodeId: child.id },
    };
    projection.messages = projection.messages.map((message) =>
      message.id === "answer-one" ? { ...message, nodeId: child.id } : message,
    );
    const plan = yield* planConversationFork({
      projection,
      targetThreadId,
      source: { kind: "assistant-response", messageId: MessageId.make("answer-one") },
    });
    assert.equal(plan.boundaryRunId, completed);
    const history = shown(plan, projection);
    const last = history.at(-1);
    assert.ok(last?.type === "assistant_message");
    assert.equal(last.text, "First answer");
    assert.ok(history.every((item) => item.runId === null && item.nodeId === null));
  }),
);

it.effect("rejects nested, unknown, and mismatched assistant-node ownership", () =>
  Effect.gen(function* () {
    for (const mismatch of ["nested", "unknown", "run", "thread", "root", "kind"] as const) {
      const projection = makeProjection();
      const root = projection.nodes[0]!;
      const child = {
        ...root,
        id: NodeId.make("untrusted-answer-node"),
        parentNodeId: mismatch === "nested" ? NodeId.make("subagent-parent") : root.id,
        rootNodeId: mismatch === "root" ? NodeId.make("foreign-root") : root.id,
        runId: mismatch === "run" ? running : root.runId,
        threadId: mismatch === "thread" ? targetThreadId : threadId,
        kind: mismatch === "kind" ? ("subagent" as const) : ("assistant_message" as const),
        countsForRun: false,
      };
      if (mismatch === "nested") {
        projection.nodes.push({
          ...root,
          id: child.parentNodeId,
          parentNodeId: root.id,
          kind: "subagent",
        });
      }
      if (mismatch !== "unknown") projection.nodes.push(child);
      projection.visibleTurnItems[2] = {
        ...projection.visibleTurnItems[2]!,
        item: { ...projection.turnItems[2]!, nodeId: child.id },
      };
      const result = yield* Effect.result(
        planConversationFork({
          projection,
          targetThreadId,
          source: { kind: "assistant-response", messageId: MessageId.make("answer-one") },
        }),
      );
      assert.equal(result._tag, "Failure", mismatch);
      if (result._tag === "Failure") {
        assert.include(result.failure.message, "not a nested task");
      }
    }
  }),
);

it.effect(
  "owns inert system history and degrades malformed fields without granting attachment authority",
  () =>
    Effect.gen(function* () {
      const projection = makeProjection();
      const systemAttachment = {
        ...attachment,
        id: "system-source-22222222-2222-2222-2222-222222222222-pdf",
      };
      const context = {
        version: 1 as const,
        records: [
          {
            version: 1 as const,
            kind: "file" as const,
            contextId: ComposerContextId.make("system-file"),
            label: systemAttachment.name,
            attachmentId: systemAttachment.id,
            name: systemAttachment.name,
            mimeType: systemAttachment.mimeType,
            sizeBytes: systemAttachment.sizeBytes,
          },
        ],
      };
      const commandItem = projection.turnItems[1]!;
      assert.ok(commandItem.type === "command_execution");
      const systemItem: Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }> = {
        ...commandItem,
        id: TurnItemId.make("migration:v1:history:system:historical-system"),
        runId: null,
        type: "dynamic_tool",
        toolName: HISTORICAL_SYSTEM_MESSAGE_TOOL_NAME,
        input: {
          messageId: MessageId.make("historical-system"),
          text: "System history",
          attachments: [systemAttachment],
          context,
        },
      };
      projection.visibleTurnItems[1] = { ...projection.visibleTurnItems[1]!, item: systemItem };
      const input = {
        projection,
        targetThreadId,
        source: { kind: "assistant-response" as const, messageId: MessageId.make("answer-one") },
      };
      const plan = yield* planConversationFork(input);
      const sharedItem = shown(plan, projection)[1]!;
      assert.ok(sharedItem.type === "dynamic_tool");
      const record = yield* decodeHistoricalSystemMessage(sharedItem.input);
      assert.equal(record.messageId, "historical-system");
      assert.equal(record.text, "System history");
      // The system message's file is shared with the fork, under its own id.
      assert.deepEqual(
        plan.attachmentCopies.find(({ source }) => source.id === systemAttachment.id),
        { source: systemAttachment, target: systemAttachment },
      );
      assert.equal(record.attachments?.[0]?.id, systemAttachment.id);
      assert.deepEqual(record.context, context);
      projection.visibleTurnItems[1] = {
        ...projection.visibleTurnItems[1]!,
        item: { ...systemItem, input: {} },
      };
      const invalid = yield* planConversationFork(input);
      const generic = shown(invalid, projection)[1]!;
      assert.ok(generic.type === "dynamic_tool");
      assert.deepEqual(generic.input, {});
      assert.notInclude(
        invalid.attachmentCopies.map((copy) => copy.source.id),
        systemAttachment.id,
      );
      projection.visibleTurnItems[1] = {
        ...projection.visibleTurnItems[1]!,
        item: {
          ...systemItem,
          input: {
            ...(systemItem.input as object),
            attachments: [{ type: "file", id: "unsafe", name: "unsafe" }],
            context: { version: -1 },
          },
        },
      };
      const partial = yield* planConversationFork(input);
      // Readers degrade the malformed fields; no file is shared for them.
      const safeRecord = readHistoricalSystemMessage(shown(partial, projection)[1]!);
      assert.ok(Option.isSome(safeRecord));
      assert.equal(safeRecord.value.text, "System history");
      assert.isNull(safeRecord.value.attachments);
      assert.isNull(safeRecord.value.context);
      assert.notInclude(
        partial.attachmentCopies.map((copy) => copy.source.id),
        systemAttachment.id,
      );
      // The same tool name and record from a native run grant no history/file authority.
      projection.visibleTurnItems[1] = {
        ...projection.visibleTurnItems[1]!,
        item: { ...systemItem, id: TurnItemId.make("native-system-tool"), runId: completed },
      };
      const native = yield* planConversationFork(input);
      assert.notInclude(
        native.attachmentCopies.map((copy) => copy.source.id),
        systemAttachment.id,
      );
      const nativeItem = shown(native, projection)[1]!;
      assert.ok(nativeItem.type === "dynamic_tool");
      assert.deepEqual(nativeItem.input, systemItem.input);
    }),
);

it.effect("freezes a settled native run through its trailing facts and excludes later runs", () =>
  Effect.gen(function* () {
    const projection = makeProjection();
    const plan = yield* planConversationFork({
      projection,
      targetThreadId,
      source: { kind: "settled-run", runId: completed },
    });
    assert.equal(plan.boundaryRunId, completed);
    assert.deepEqual(
      plan.history.map((entry) => entry.sourceItemId),
      projection.visibleTurnItems
        .filter(({ item }) => item.runId === completed)
        .map(({ item }) => item.id),
    );
    assert.isTrue(shown(plan, projection).every((item) => item.runId === null));
  }),
);

it.effect("a cancelled run with no rendered facts keeps only the earlier frozen prefix", () =>
  Effect.gen(function* () {
    const projection = makeProjection();
    const cancelledId = RunId.make("empty-cancelled-run");
    const prior = projection.runs[0]!;
    const later = projection.runs[1]!;
    projection.runs = [
      prior,
      { ...later, id: cancelledId, ordinal: 2, status: "cancelled" },
      { ...later, ordinal: 3 },
    ];
    const plan = yield* planConversationFork({
      projection,
      targetThreadId,
      source: { kind: "settled-run", runId: cancelledId },
    });
    assert.equal(plan.boundaryRunId, cancelledId);
    assert.deepEqual(
      plan.history.map((entry) => entry.sourceItemId),
      projection.visibleTurnItems
        .filter(({ item }) => item.runId === completed)
        .map(({ item }) => item.id),
    );
  }),
);

it.effect("a completed-looking response in an active native run is not a settled boundary", () =>
  Effect.gen(function* () {
    for (const status of ["queued", "preparing", "starting", "running"] as const) {
      const projection = makeProjection();
      projection.runs[0] = { ...projection.runs[0]!, status, completedAt: null };
      assert.equal(
        (yield* Effect.result(
          planConversationFork({
            projection,
            targetThreadId,
            source: { kind: "assistant-response", messageId: MessageId.make("answer-one") },
          }),
        ))._tag,
        "Failure",
        status,
      );
    }
    const accepted = yield* planConversationFork({
      projection: makeProjection(),
      targetThreadId,
      source: { kind: "assistant-response", messageId: MessageId.make("answer-one") },
    });
    assert.equal(accepted.boundaryRunId, completed);
  }),
);

it.effect(
  "a running native fork retains interrupted and unanswered requests once under their own run ownership",
  () =>
    Effect.gen(function* () {
      const projection = makeProjection();
      const unanswered = RunId.make("interrupted-unanswered");
      projection.runs.splice(1, 0, {
        ...projection.runs[0]!,
        id: unanswered,
        ordinal: 2,
        userMessageId: MessageId.make("interrupted-question"),
        rootNodeId: null,
        status: "interrupted",
      });
      projection.runs[2] = { ...projection.runs[2]!, ordinal: 3 };
      const request = {
        ...projection.turnItems[0]!,
        id: TurnItemId.make("interrupted-question"),
        runId: unanswered,
        ordinal: 3,
        messageId: MessageId.make("interrupted-question"),
        text: "Interrupted question",
        attachments: [],
      };
      const work = {
        ...projection.turnItems[1]!,
        id: TurnItemId.make("interrupted-work"),
        runId: unanswered,
        ordinal: 4,
        status: "interrupted" as const,
      };
      projection.turnItems.splice(3, 0, request, work);
      projection.visibleTurnItems = projection.turnItems.map((item, position) => ({
        item,
        position,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        visibility: "local" as const,
      }));
      const plan = yield* planConversationFork({
        projection,
        targetThreadId,
        source: { kind: "running-turn", runId: running },
      });
      const history = shown(plan, projection);
      const copied = history.filter((item) => item.inheritedFrom?.runId === unanswered);
      assert.lengthOf(copied, 2);
      assert.isTrue(copied.every((item) => item.runId === null));
      assert.equal(
        copied.filter(
          (item) => item.type === "user_message" && item.text === "Interrupted question",
        ).length,
        1,
      );
      assert.equal(
        history.filter(
          (item) =>
            item.inheritedFrom?.runId === running &&
            item.type === "user_message" &&
            item.inputIntent === "turn_start",
        ).length,
        1,
      );
      assert.ok(
        history.some((item) => item.type === "assistant_message" && item.text === "First answer"),
      );
      assert.isFalse(
        history.some(
          (item) =>
            item.inheritedFrom?.runId === running && item.inheritedFrom?.itemId === request.id,
        ),
      );
    }),
);

it.effect(
  "a later unanswered native run requested before an earlier answer finishes stays outside that answer's fork",
  () =>
    Effect.gen(function* () {
      const projection = makeProjection();
      const question = projection.turnItems[3]!;
      projection.visibleTurnItems = [
        projection.turnItems[0]!,
        question,
        projection.turnItems[1]!,
        projection.turnItems[2]!,
        ...projection.turnItems.slice(4),
      ].map((item, position) => ({
        item,
        position,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        visibility: "local" as const,
      }));
      const plan = yield* planConversationFork({
        projection,
        targetThreadId,
        source: { kind: "assistant-response", messageId: MessageId.make("answer-one") },
      });
      const history = shown(plan, projection);
      assert.deepEqual(
        history.flatMap((item) =>
          item.type === "user_message" || item.type === "assistant_message" ? [item.text] : [],
        ),
        ["First question", "First answer"],
      );
      assert.isFalse(history.some((item) => item.inheritedFrom?.runId === running));
    }),
);

it.effect(
  "native question history follows retained run ownership and excludes pending and message-mode replay",
  () =>
    Effect.gen(function* () {
      const projection = makeProjection();
      const question = (
        id: string,
        runId: RunId,
      ): Extract<OrchestrationV2TurnItem, { type: "user_input_request" }> => ({
        id: TurnItemId.make(id),
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_input_request",
        requestId: RuntimeRequestId.make(id),
        questions: [{ id: "dataset", header: "Data", question: "Which dataset?", options: [] }],
        questionAnswer: { requestId: id, answers: { dataset: id }, attachmentsByQuestionId: {} },
      });
      const chosen = question("retained-answer", completed);
      const pending = {
        ...question("pending-answer", completed),
        status: "running" as const,
        questionAnswer: undefined,
      };
      const messageMode = {
        ...question("message-mode-answer", completed),
        responseMode: "message" as const,
      };
      const later = question("later-answer", running);
      const items = [
        projection.turnItems[0]!,
        chosen,
        pending,
        messageMode,
        later,
        ...projection.turnItems.slice(1),
      ];
      const plan = yield* planConversationFork({
        projection: {
          ...projection,
          turnItems: items,
          visibleTurnItems: items.map((item, position) => ({
            item,
            position,
            sourceThreadId: threadId,
            sourceItemId: item.id,
            visibility: "local" as const,
          })),
        },
        targetThreadId,
        source: { kind: "assistant-response", messageId: MessageId.make("answer-one") },
      });
      const answers = shown(plan, {
        visibleTurnItems: items.map((item) => ({ sourceItemId: item.id, item })),
      }).filter((item) => item.type === "user_input_request");
      assert.lengthOf(answers, 3);
      assert.isFalse(answers.some((item) => item.inheritedFrom?.itemId === later.id));
      const replayed = answers.flatMap((item) => {
        const message = historicalMessage(item);
        return message ? [message.text] : [];
      });
      assert.lengthOf(replayed, 1);
      assert.include(replayed[0]!, "Which dataset?");
      assert.include(replayed[0]!, "retained-answer");
      assert.notInclude(replayed[0]!, "later-answer");
      assert.isTrue(
        answers.every(
          (item) => item.runId === null && item.nodeId === null && item.nativeItemRef === null,
        ),
      );
    }),
);
