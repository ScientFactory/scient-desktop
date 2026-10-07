import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { emptyProjection } from "../ProjectionStore.ts";
import {
  freezeConversationForkNativeSource,
  frozenForkPortableReason,
} from "./ConversationForkNativeSource.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import type { ConversationForkSource } from "./ConversationForkPlan.ts";

const now = DateTime.makeUnsafe("2026-10-04T00:00:00.000Z");
const threadId = ThreadId.make("native-source");
const instanceId = ProviderInstanceId.make("native-codex");
const driver = ProviderDriverKind.make("codex");
const providerThreadId = ProviderThreadId.make("native-provider-thread");
const modelSelection = { instanceId, model: "fixture" };
function fixture() {
  const projection = emptyProjection({
    id: EventId.make("native-source-created"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      id: threadId,
      projectId: ProjectId.make("native-project"),
      title: "Native source",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
      historyOrigin: "native",
    },
  });
  const runs: OrchestrationV2Run[] = [1, 2].map((ordinal) => ({
    id: RunId.make(`run-${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId,
    userMessageId: MessageId.make(`user-${ordinal}`),
    rootNodeId: NodeId.make(`root-${ordinal}`),
    activeAttemptId: RunAttemptId.make(`attempt-${ordinal}`),
    status: "completed",
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
  }));
  const attempts: OrchestrationV2RunAttempt[] = runs.map((run) => ({
    id: run.activeAttemptId!,
    runId: run.id,
    attemptOrdinal: 1,
    rootNodeId: run.rootNodeId!,
    providerInstanceId: instanceId,
    providerThreadId,
    providerTurnId: ProviderTurnId.make(`turn-${run.ordinal}`),
    nativeThreadId: "native-thread",
    reason: "initial",
    status: "completed",
    startedAt: now,
    completedAt: now,
  }));
  const providerTurns: OrchestrationV2ProviderTurn[] = runs.map((run) => ({
    id: ProviderTurnId.make(`turn-${run.ordinal}`),
    providerThreadId,
    nodeId: run.rootNodeId!,
    runAttemptId: run.activeAttemptId,
    ordinal: run.ordinal,
    nativeTurnRef: { driver, nativeId: `native-turn-${run.ordinal}`, strength: "strong" },
    status: "completed",
    startedAt: now,
    completedAt: now,
  }));
  const providerThread: OrchestrationV2ProviderThread = {
    id: providerThreadId,
    driver,
    providerInstanceId: instanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    createdAt: now,
    updatedAt: now,
  };
  const items: OrchestrationV2TurnItem[] = runs.map((run) => ({
    id: TurnItemId.make(`item-${run.ordinal}`),
    threadId,
    runId: run.id,
    nodeId: run.rootNodeId,
    providerThreadId,
    providerTurnId: providerTurns[run.ordinal - 1]!.id,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: run.ordinal,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "assistant_message",
    messageId: MessageId.make(`answer-${run.ordinal}`),
    text: `Answer ${run.ordinal}`,
    streaming: false,
  }));
  return {
    projection: {
      ...projection,
      runs,
      attempts,
      providerTurns,
      providerThreads: [providerThread],
      turnItems: items,
      visibleTurnItems: items.map((item, position) => ({
        item,
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
      })),
    },
    retainedSourceItems: items,
    boundaryRunId: runs[1]!.id,
    sourceKind: "assistant-response" as ConversationForkSource["kind"],
  };
}

it("freezes inclusive native identity independently of later source mutation", () => {
  const input = fixture();
  const result = freezeConversationForkNativeSource(input);
  assert.equal(result.strategy, "native_fork");
  if (result.strategy !== "native_fork") return assert.fail(result.reason);
  const frozen = result.frozenSource;
  input.projection.providerThreads[0] = {
    ...input.projection.providerThreads[0]!,
    nativeThreadRef: { driver, nativeId: "mutated-thread", strength: "strong" },
  };
  input.projection.providerTurns[1] = {
    ...input.projection.providerTurns[1]!,
    nativeTurnRef: { driver, nativeId: "mutated-turn", strength: "strong" },
  };
  input.projection.runs.splice(0);
  assert.equal(frozen.sourceProviderThread.nativeThreadRef?.nativeId, "native-thread");
  assert.equal(frozen.sourceProviderTurns[1]?.nativeTurnRef?.nativeId, "native-turn-2");
  assert.equal(frozen.sourceRun.id, input.boundaryRunId);
  assert.equal(frozen.providerTurnId, ProviderTurnId.make("turn-2"));
});

it("uses the unique root turn's durable reverse attempt link when the forward link is absent", () => {
  const input = fixture();
  input.projection.attempts = input.projection.attempts.map((attempt) => ({
    ...attempt,
    providerTurnId: null,
  }));
  assert.equal(freezeConversationForkNativeSource(input).strategy, "native_fork");
  input.projection.providerTurns.push({
    ...input.projection.providerTurns[1]!,
    id: ProviderTurnId.make("ambiguous-root-turn"),
  });
  assert.equal(freezeConversationForkNativeSource(input).strategy, "portable_context");
});

it("rechecks exact source boundary and destination instance, driver and native capabilities", () => {
  const source = fixture();
  const decision = freezeConversationForkNativeSource(source);
  assert.ok(decision.strategy === "native_fork");
  const input = {
    frozenSource: decision.frozenSource,
    sourceThreadId: threadId,
    sourceRunId: source.boundaryRunId,
    targetInstanceId: instanceId,
    targetDriver: driver,
    capabilities: CodexProviderCapabilitiesV2,
  };
  assert.isUndefined(frozenForkPortableReason(input));
  assert.isString(
    frozenForkPortableReason({ ...input, sourceRunId: RunId.make("other-boundary") }),
  );
  assert.isString(
    frozenForkPortableReason({
      ...input,
      targetInstanceId: ProviderInstanceId.make("other-instance"),
    }),
  );
  assert.isString(
    frozenForkPortableReason({ ...input, targetDriver: ProviderDriverKind.make("pi") }),
  );
  assert.isString(
    frozenForkPortableReason({
      ...input,
      capabilities: {
        ...input.capabilities,
        threads: { ...input.capabilities.threads, canForkFromTurn: false },
      },
    }),
  );
});

it("keeps uncertain, imported, restarted, incomplete and foreign ownership portable", () => {
  const mutations = [
    (input: ReturnType<typeof fixture>) => {
      input.sourceKind = "running-turn";
    },
    (input: ReturnType<typeof fixture>) => {
      input.projection.thread = { ...input.projection.thread, historyOrigin: "v1_import" };
    },
    (input: ReturnType<typeof fixture>) => {
      input.retainedSourceItems[0] = { ...input.retainedSourceItems[0]!, runId: null };
    },
    (input: ReturnType<typeof fixture>) => {
      input.projection.providerTurns[1] = {
        ...input.projection.providerTurns[1]!,
        nativeTurnRef: { driver, nativeId: "native-turn-2", strength: "weak" },
      };
    },
    (input: ReturnType<typeof fixture>) => {
      input.projection.providerTurns[1] = {
        ...input.projection.providerTurns[1]!,
        nativeTurnRef: { driver, nativeId: null, strength: "strong" },
      };
    },
    (input: ReturnType<typeof fixture>) => {
      input.projection.providerTurns[1] = {
        ...input.projection.providerTurns[1]!,
        nativeTurnRef: { driver, nativeId: " ", strength: "strong" },
      };
    },
    (input: ReturnType<typeof fixture>) => {
      input.projection.providerThreads[0] = {
        ...input.projection.providerThreads[0]!,
        ownerNodeId: NodeId.make("child"),
      };
    },
    (input: ReturnType<typeof fixture>) => {
      input.projection.runs[0] = {
        ...input.projection.runs[0]!,
        providerInstanceId: ProviderInstanceId.make("another-instance"),
      };
    },
    (input: ReturnType<typeof fixture>) => {
      input.projection.runs[0] = { ...input.projection.runs[0]!, status: "waiting" };
    },
    (input: ReturnType<typeof fixture>) => {
      input.projection.attempts.push({
        ...input.projection.attempts[0]!,
        id: RunAttemptId.make("retry"),
        attemptOrdinal: 2,
      });
    },
    (input: ReturnType<typeof fixture>) => {
      input.retainedSourceItems = input.retainedSourceItems.slice(1);
    },
    (input: ReturnType<typeof fixture>) => {
      input.retainedSourceItems[0] = {
        ...input.retainedSourceItems[0]!,
        providerThreadId: ProviderThreadId.make("child-provider"),
      };
    },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    const result = freezeConversationForkNativeSource(input);
    assert.equal(result.strategy, "portable_context");
    if (result.strategy === "portable_context") assert.isAbove(result.reason.length, 0);
  }
});

function claudeFixture() {
  const input = fixture();
  const claudeDriver = ProviderDriverKind.make("claudeAgent");
  const nodes: OrchestrationV2ExecutionNode[] = [];
  const items: OrchestrationV2TurnItem[] = input.retainedSourceItems.map((item, index) => {
    assert.ok(item.type === "assistant_message");
    const run = input.projection.runs[index]!;
    assert.ok(run.rootNodeId);
    const nativeId = `00000000-0000-4000-8000-00000000000${index + 1}`;
    const nodeId = NodeId.make(`assistant-${index}`);
    const nativeItemRef = { driver: claudeDriver, nativeId, strength: "strong" as const };
    nodes.push({
      id: nodeId,
      threadId,
      runId: run.id,
      rootNodeId: run.rootNodeId,
      parentNodeId: run.rootNodeId,
      kind: "assistant_message",
      status: "completed",
      countsForRun: false,
      providerThreadId,
      providerTurnId: input.projection.providerTurns[index]!.id,
      nativeItemRef,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: now,
    });
    return { ...item, nodeId, nativeItemRef };
  });
  return {
    ...input,
    retainedSourceItems: items,
    projection: {
      ...input.projection,
      nodes,
      turnItems: items,
      visibleTurnItems: items.map((item, position) => ({
        item,
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
      })),
      providerThreads: input.projection.providerThreads.map((thread) => ({
        ...thread,
        driver: claudeDriver,
        nativeThreadRef: {
          driver: claudeDriver,
          nativeId: "claude-native-session",
          strength: "strong" as const,
        },
      })),
      attempts: input.projection.attempts.map((attempt) => ({
        ...attempt,
        nativeThreadId: "claude-native-session",
      })),
      providerTurns: input.projection.providerTurns.map((turn, index) => ({
        ...turn,
        nativeTurnRef: {
          driver: claudeDriver,
          nativeId: `00000000-0000-4000-8000-00000000000${index + 1}`,
          strength: "weak" as const,
        },
      })),
    },
  };
}

it("freezes weak Claude UUIDs only with completed root-owned strong assistant evidence", () => {
  const input = claudeFixture();
  const decision = freezeConversationForkNativeSource(input);
  assert.equal(decision.strategy, "native_fork");
  if (decision.strategy !== "native_fork") return assert.fail(decision.reason);
  assert.lengthOf(decision.frozenSource.claudeBoundaryEvidence ?? [], 2);
  assert.isUndefined(
    frozenForkPortableReason({
      frozenSource: decision.frozenSource,
      sourceThreadId: threadId,
      sourceRunId: input.boundaryRunId,
      targetInstanceId: instanceId,
      targetDriver: ProviderDriverKind.make("claudeAgent"),
      capabilities: CodexProviderCapabilitiesV2,
    }),
  );
  const lastProof = decision.frozenSource.claudeBoundaryEvidence?.at(-1);
  assert.ok(lastProof);
  assert.isString(
    frozenForkPortableReason({
      frozenSource: {
        ...decision.frozenSource,
        claudeBoundaryEvidence: [{ ...lastProof, runId: RunId.make("foreign-run") }],
      },
      sourceThreadId: threadId,
      sourceRunId: input.boundaryRunId,
      targetInstanceId: instanceId,
      targetDriver: ProviderDriverKind.make("claudeAgent"),
      capabilities: CodexProviderCapabilitiesV2,
    }),
  );
});

for (const invalid of [
  "nested",
  "foreign-thread",
  "foreign-turn",
  "synthetic",
  "missing-node",
  "weak-item",
  "running-item",
  "non-Claude",
] as const) {
  it(`rejects weak cursor evidence outside the exact root boundary: ${invalid}`, () => {
    const input = claudeFixture();
    const node = input.projection.nodes[1]!;
    if (invalid === "nested")
      input.projection.nodes[1] = { ...node, parentNodeId: NodeId.make("task-root") };
    if (invalid === "foreign-thread")
      input.projection.nodes[1] = { ...node, threadId: ThreadId.make("foreign") };
    if (invalid === "foreign-turn")
      input.projection.nodes[1] = { ...node, providerTurnId: ProviderTurnId.make("foreign") };
    if (invalid === "synthetic")
      input.projection.providerTurns[1] = {
        ...input.projection.providerTurns[1]!,
        nativeTurnRef: {
          driver: ProviderDriverKind.make("claudeAgent"),
          nativeId: "synthetic-uuid",
          strength: "weak",
        },
      };
    if (invalid === "missing-node") input.projection.nodes.splice(1, 1);
    if (invalid === "weak-item")
      input.retainedSourceItems[1] = {
        ...input.retainedSourceItems[1]!,
        nativeItemRef: {
          driver: ProviderDriverKind.make("claudeAgent"),
          nativeId: "00000000-0000-4000-8000-000000000002",
          strength: "weak",
        },
      };
    if (invalid === "running-item")
      input.retainedSourceItems[1] = { ...input.retainedSourceItems[1]!, status: "running" };
    if (invalid === "non-Claude")
      input.projection.providerThreads[0] = { ...input.projection.providerThreads[0]!, driver };
    assert.equal(freezeConversationForkNativeSource(input).strategy, "portable_context");
  });
}
