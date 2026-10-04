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
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { emptyProjection } from "../ProjectionStore.ts";
import { planConversationFork } from "./ConversationForkPlan.ts";

const now = DateTime.makeUnsafe("2026-10-03T00:00:00.000Z");
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

it.effect(
  "freezes a completed prefix and gives retained attachments and context to the destination",
  () =>
    Effect.gen(function* () {
      const projection = makeProjection();
      const plan = yield* planConversationFork({
        projection,
        targetThreadId,
        source: { kind: "assistant-response", messageId: MessageId.make("answer-one") },
      });
      assert.deepEqual(
        plan.items.map((item) => item.type),
        ["user_message", "command_execution", "assistant_message"],
      );
      assert.equal(plan.messages.length, 2);
      assert.ok(
        plan.items.every(
          (item) => item.threadId === targetThreadId && item.runId === null && item.nodeId === null,
        ),
      );
      assert.equal(plan.attachmentCopies.length, 1);
      assert.notEqual(plan.attachmentCopies[0]!.target.id, attachment.id);
      const user = plan.items[0]!;
      assert.ok(user.type === "user_message");
      assert.equal(user.attachments[0]!.id, plan.attachmentCopies[0]!.target.id);
      assert.equal(user.context?.records[0]?.kind, "file");
      assert.deepEqual(user.inheritedFrom, {
        threadId,
        itemId: TurnItemId.make("question-one"),
        runId: completed,
        status: "completed",
      });
      projection.turnItems.splice(0);
      projection.messages.splice(0);
      assert.equal(plan.items.length, 3);
      assert.equal(plan.messages[1]!.text, "First answer");
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
        plan.items.map((item) => item.type),
        ["user_message", "command_execution", "assistant_message"],
      );
      assert.equal(plan.messages.length, 2);
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
    assert.equal(plan.messages.at(-1)?.text, "First answer");
    assert.ok(plan.items.every((item) => item.runId === null && item.nodeId === null));
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
