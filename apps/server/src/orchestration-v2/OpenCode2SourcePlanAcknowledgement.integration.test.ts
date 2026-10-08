import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import { openCode2ReplayRuntime } from "./Adapters/OpenCode2AdapterV2.testkit.ts";
import type { ProviderAdapterV2TurnInput } from "./ProviderAdapter.ts";
import type { ProviderReplayEntry } from "@t3tools/contracts";
import { sourcePlanFingerprint } from "./SourcePlan.ts";

const SESSION = "ses_f148ca2deffeJcwCnRQtb0YFNX";
const WORK = "/work/opencode2";

const out = (type: string, input?: unknown): ProviderReplayEntry => ({
  type: "expect_outbound",
  frame: input === undefined ? { type } : { type, input },
});
/** A recorded response body; `{ data }` is the server's envelope, `null` an empty 204. */
const reply = (operation: string, data: unknown): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: { type: "sdk.response", operation, data },
});
const replyData = (operation: string, data: unknown) => reply(operation, { data });
/** The rules T3 gives every session it runs, with only this thread's own T3 MCP server allowed. */
const mcpRules = [
  { action: "t3-code-*", resource: "*", effect: "deny" },
  { action: "t3-code-thread_opencode2-adapter_*", resource: "*", effect: "allow" },
];
const t3Rules = [{ action: "*", resource: "*", effect: "allow" }, ...mcpRules];
const sessionInfo = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION,
  permissions: t3Rules,
  projectID: "global",
  model: { id: "big-pickle", providerID: "opencode", variant: "default" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1790656601394, updated: 1790656601394 },
  location: { directory: WORK },
  ...overrides,
});
// `/api/model` as 2.0.18 lists big-pickle: its 160k input limit is the usable window.
const modelCatalog = {
  location: { directory: WORK },
  data: [
    {
      id: "big-pickle",
      modelID: "big-pickle",
      providerID: "opencode",
      family: "big-pickle",
      name: "Big Pickle",
      compatibility: { reasoningField: "reasoning_content" },
      package: "@opencode/ai/providers/openai-compatible",
      settings: { apiKey: "public", baseURL: "https://opencode.ai/zen/v1", provider: "opencode" },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [],
      time: { released: 1760659200000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      status: "active",
      enabled: true,
      limit: { context: 200000, input: 160000, output: 32000 },
    },
  ],
};

const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const testLayer = Layer.merge(EventSink.layer, ProjectionMaintenance.layer).pipe(
  Layer.provideMerge(stores),
);
const instanceId = ProviderInstanceId.make("opencode");
const driver = ProviderDriverKind.make("opencode");
const seed = Effect.fnUntraced(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("thread:opencode2-adapter");
  const sourceThreadId = ThreadId.make("plan-source");
  const runId = RunId.make("plan-consumer:run");
  const attemptId = RunAttemptId.make("plan-consumer:attempt");
  const rootId = NodeId.make("plan-consumer:root");
  const providerThreadId = ProviderThreadId.make("plan-consumer:native");
  const projectId = ProjectId.make("plan-consumption-project");
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId,
    title: "Consumer",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "opencode/big-pickle" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThreadId,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  const sourceThread = {
    ...thread,
    id: sourceThreadId,
    title: "Source",
    activeProviderThreadId: null,
    lineage: { ...thread.lineage, rootThreadId: sourceThreadId },
  };
  const plan: Extract<OrchestrationV2PlanArtifact, { kind: "proposed_plan" }> = {
    id: PlanId.make("source-plan"),
    threadId: sourceThreadId,
    runId: null,
    nodeId: NodeId.make("source-plan:node"),
    kind: "proposed_plan",
    markdown: "# Exact selected plan",
    status: "active",
  };
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection: thread.modelSelection,
    providerThreadId,
    userMessageId: MessageId.make("plan-consumer:message"),
    rootNodeId: rootId,
    activeAttemptId: attemptId,
    status: "running",
    queuePosition: 1,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    sourcePlanRef: { threadId: sourceThreadId, planId: plan.id },
    sourcePlanFingerprint: sourcePlanFingerprint(plan),
  };
  const attempt: OrchestrationV2RunAttempt = {
    id: attemptId,
    runId,
    attemptOrdinal: 1,
    rootNodeId: rootId,
    providerInstanceId: instanceId,
    providerThreadId,
    providerTurnId: null,
    reason: "initial",
    status: "running",
    startedAt: now,
    completedAt: null,
  };
  const root: OrchestrationV2ExecutionNode = {
    id: rootId,
    threadId,
    runId,
    parentNodeId: null,
    rootNodeId: rootId,
    kind: "root_turn",
    status: "running",
    countsForRun: true,
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
  const providerThread: OrchestrationV2ProviderThread = {
    id: providerThreadId,
    driver,
    providerInstanceId: instanceId,
    providerSessionId: ProviderSessionId.make("provider-session:opencode2-adapter"),
    appThreadId: threadId,
    ownerNodeId: rootId,
    nativeThreadRef: { driver, nativeId: SESSION, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "active",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    createdAt: now,
    updatedAt: now,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make("consumer:create"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make("source:create"),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: sourceThread,
      },
      {
        id: EventId.make("plan:create"),
        type: "plan.updated",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: plan,
      },
      {
        id: EventId.make("consumer:native"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      },
      {
        id: EventId.make("consumer:run"),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: run,
      },
      {
        id: EventId.make("consumer:attempt"),
        type: "run-attempt.created",
        threadId,
        occurredAt: now,
        payload: attempt,
      },
      {
        id: EventId.make("consumer:root"),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: root,
      },
    ],
  });
  return { sink, thread, sourceThread, run, attempt, root, providerThread, plan, now };
});

it.effect.each(
  (["foreign-id", "foreign-session", "confirmed", "displaced-attempt"] as const).map((proof) => ({
    caseTitle: `only an exact OpenCode native prompt acknowledgement consumes a source plan: ${proof}`,
    proof,
  })),
)("$caseTitle", ({ proof }) =>
  Effect.gen(function* () {
    const { sink, thread, run, attempt, root, providerThread, plan, now } = yield* seed();
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const offeredId = `msg_t3_turn_${SESSION}:${attempt.id}`;
    // Deliberately no session.execution.* or assistant/tool events: only the
    // typed HTTP response can establish acceptance in these scenarios.
    const runtime = yield* openCode2ReplayRuntime([
      out("event.subscribe"),
      out("model.list", "<any>"),
      reply("model.list", modelCatalog),
      out("session.get", { sessionID: SESSION }),
      replyData("session.get", sessionInfo()),
      out("permission.list", { sessionID: SESSION }),
      replyData("permission.list", []),
      out("session.form.list", { sessionID: SESSION }),
      replyData("session.form.list", []),
      out("session.instructions.entry.put", {
        sessionID: SESSION,
        key: "t3-code",
        value: "<any>",
      }),
      reply("session.instructions.entry.put", null),
      out("session.prompt", { sessionID: SESSION, id: offeredId, text: "<any>" }),
      replyData("session.prompt", {
        id: proof === "foreign-id" ? "msg_foreign_acknowledgement" : offeredId,
        sessionID: proof === "foreign-session" ? "ses_foreign_acknowledgement" : SESSION,
        time: { created: 1790656601410 },
        type: "user",
        payload: { text: "Implement exact plan" },
        delivery: "steer",
      }),
      out("message.list", { sessionID: SESSION, order: "asc", limit: "100" }),
      reply("message.list", { data: [], cursor: {} }),
    ]);
    const resumed = yield* runtime.resumeThread({ providerThread });
    assert.ok(run.userMessageId);
    const input: ProviderAdapterV2TurnInput = {
      appThread: thread,
      threadId: thread.id,
      runId: run.id,
      runOrdinal: run.ordinal,
      providerTurnOrdinal: 1,
      attemptId: attempt.id,
      rootNodeId: root.id,
      providerThread: resumed,
      modelSelection: thread.modelSelection,
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: WORK },
      message: {
        messageId: run.userMessageId,
        text: "Implement exact plan",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        scheduledTaskId: undefined,
        senderThreadId: undefined,
      },
    };
    yield* runtime.startTurn(input);
    const snapshot = yield* runtime.readThreadSnapshot({ providerThread: resumed });
    const latest = snapshot.providerTurns[0];
    assert.ok(latest);
    assert.equal(snapshot.providerTurns.length, 1);
    if (proof === "displaced-attempt") {
      const replacementId = RunAttemptId.make(`${attempt.id}:replacement`);
      yield* sink.write({
        events: [
          {
            id: EventId.make("replacement:attempt"),
            type: "run-attempt.created",
            threadId: thread.id,
            occurredAt: now,
            payload: { ...attempt, id: replacementId, attemptOrdinal: 2 },
          },
          {
            id: EventId.make("replacement:run"),
            type: "run.updated",
            threadId: thread.id,
            occurredAt: now,
            payload: { ...run, activeAttemptId: replacementId },
          },
        ],
      });
    }
    // snapshotOf returns the actual providerTurns map values. Drain through
    // that exact final emitted object, avoiding sleeps and synthetic receipts.
    const emitted = yield* runtime.events.pipe(
      Stream.takeUntil(
        (event) => event.type === "provider_turn.updated" && event.providerTurn === latest,
      ),
      Stream.runCollect,
      Effect.timeout("5 seconds"),
    );
    let receiptOrdinal = 0;
    for (const event of emitted) {
      assert.notEqual(event.type, "turn.terminal");
      if (event.type !== "provider_turn.updated") continue;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`actual-native-receipt:${++receiptOrdinal}`),
            type: "provider-turn.updated",
            threadId: thread.id,
            runId: run.id,
            nodeId: root.id,
            providerInstanceId: instanceId,
            driver,
            occurredAt: now,
            payload: event.providerTurn,
          },
        ],
      });
    }
    const mismatched = proof === "foreign-id" || proof === "foreign-session";
    const consumed = yield* projection.getPlan(plan.threadId, plan.id);
    assert.ok(consumed?.kind === "proposed_plan");
    assert.equal(consumed.status, proof === "confirmed" ? "completed" : "active");
    assert.equal(latest.nativeAcceptance, mismatched ? "unknown" : "accepted");
    assert.equal(latest.nativeTurnRef?.strength, mismatched ? "weak" : "strong");
    assert.equal(latest.nativeTurnRef?.nativeId, offeredId);
    assert.equal(latest.runAttemptId, attempt.id);
    assert.equal(latest.nodeId, run.rootNodeId);
    assert.equal(latest.providerThreadId, resumed.id);
    if (proof === "confirmed") {
      assert.deepEqual(consumed.consumedBy, {
        threadId: thread.id,
        runId: run.id,
        runAttemptId: attempt.id,
        providerTurnId: latest.id,
      });
      assert.ok(latest.acceptedAt);
    } else {
      assert.equal(consumed.consumedBy, undefined);
      if (mismatched) assert.equal(latest.acceptedAt, undefined);
    }
    const planEvents = yield* events
      .read({ threadId: plan.threadId, eventType: "plan.updated" })
      .pipe(Stream.runCollect);
    assert.equal(planEvents.length, proof === "confirmed" ? 2 : 1);
    const persisted = (yield* projection.getThreadProjection(thread.id)).providerTurns;
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0], latest);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
