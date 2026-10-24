import { OrchestrationV2ShellSnapshot } from "./orchestrationV2.ts";
import { ProviderCitationPresentation } from "./providerCitationPresentation.ts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  NodeId,
  NonNegativeInt,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./index.ts";
import {
  latestProviderTurnForAttempt,
  OrchestrationV2Command,
  OrchestrationV2DroidHeldSteer,
  OrchestrationV2Notification,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2RpcSchemas,
  OrchestrationV2Subagent,
  OrchestrationV2SubagentJson,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
} from "./orchestrationV2.ts";

const isCitationPresentation = Schema.is(ProviderCitationPresentation);
const decodeCitationPresentation = Schema.decodeUnknownOption(ProviderCitationPresentation);
const now = DateTime.makeUnsafe("2026-04-20T00:00:00.000Z");

const oldNotice = Schema.Struct({
  type: Schema.Literal("system_notice"),
  id: TurnItemId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  nodeId: Schema.NullOr(NodeId),
  providerThreadId: Schema.NullOr(ProviderThreadId),
  providerTurnId: Schema.Null,
  nativeItemRef: Schema.Null,
  parentItemId: Schema.NullOr(TurnItemId),
  ordinal: NonNegativeInt,
  status: Schema.Literal("completed"),
  title: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  updatedAt: Schema.DateTimeUtcFromString,
  message: Schema.String,
});
const decodeOldForkSnapshot = Schema.decodeUnknownSync(
  Schema.Struct({ turnItems: Schema.Array(oldNotice) }),
);
const forkTypeJsonCodec = Schema.toCodecJson(OrchestrationV2TurnItem);
const encodeForkTypeJson = Schema.encodeSync(forkTypeJsonCodec);
const decodeForkTypeJson = Schema.decodeUnknownSync(forkTypeJsonCodec);
const encodeUnknownForkTypeJson = Schema.encodeUnknownSync(forkTypeJsonCodec);
const encodeUnknownForkJson = Schema.encodeUnknownSync(OrchestrationV2TurnItemJson);

describe("first-admission metadata compatibility", () => {
  it.each([undefined, false, true])("round trips optional admission provenance %s", (admitted) => {
    const item = decodeOrchestrationV2TurnItem({
      id: "admission-item",
      threadId: "admission-thread",
      type: "user_message",
      messageId: "admission-message",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      createdBy: "user",
      creationSource: "web",
      inputIntent: "steer",
      ...(admitted === undefined ? {} : { inputAlreadyAdmitted: admitted }),
      text: "synthetic",
      attachments: [],
    });
    for (const encoded of [encodeOrchestrationV2TurnItemJson(item), encodeForkTypeJson(item)]) {
      expect(decodeOrchestrationV2TurnItemJson(encoded)).toEqual(item);
      expect(decodeForkTypeJson(encoded)).toEqual(item);
      expect(encoded).toMatchObject(
        admitted === undefined ? {} : { inputAlreadyAdmitted: admitted },
      );
    }
  });
});

describe("portable message fork boundary compatibility", () => {
  it.each(
    (["before", "after"] as const).map((position) => ({
      caseTitle: `preserves the ${position} message boundary through Type, JSON and old notice codecs`,
      position,
    })),
  )("$caseTitle", ({ position }) => {
    const item = decodeOrchestrationV2TurnItem({
      id: "portable-fork-boundary",
      threadId: "portable-child",
      type: "fork",
      runId: null,
      nodeId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 3,
      status: "completed",
      title: "Conversation forked here",
      startedAt: null,
      completedAt: now,
      updatedAt: now,
      source: {
        type: "message",
        threadId: "portable-source",
        messageId: "historical-message",
        position,
      },
      targetThreadId: "portable-child",
    });
    for (const encoded of [encodeOrchestrationV2TurnItemJson(item), encodeForkTypeJson(item)]) {
      expect(decodeOldForkSnapshot({ turnItems: [encoded] }).turnItems[0]).toMatchObject({
        type: "system_notice",
        message: "Conversation forked here",
        runId: null,
        nodeId: null,
      });
      const decoded = decodeOrchestrationV2TurnItemJson(encoded);
      expect(decoded).toEqual(item);
      expect(encodeOrchestrationV2TurnItemJson(decoded)).toEqual(encoded);
      expect(decodeForkTypeJson(encoded)).toEqual(item);
    }
  });
  it("rejects message boundaries carrying execution authority in Type and JSON", () => {
    const item = {
      id: "portable-fork-boundary",
      threadId: "portable-child",
      type: "fork",
      runId: null,
      nodeId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 3,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
      source: { type: "message", threadId: "source", messageId: "answer", position: "after" },
      targetThreadId: "portable-child",
    };
    for (const ownership of [
      { runId: "live-run" },
      { nodeId: "live-node" },
      { providerThreadId: "live-provider-thread" },
      { providerThreadId: null },
      { providerTurnId: "live-provider-turn" },
      { nativeItemRef: { driver: "codex", nativeId: "live-native-item", strength: "strong" } },
    ]) {
      expect(() => decodeOrchestrationV2TurnItem({ ...item, ...ownership })).toThrow();
      expect(() => encodeUnknownForkTypeJson({ ...item, ...ownership })).toThrow();
      expect(() => encodeUnknownForkJson({ ...item, ...ownership })).toThrow();
      expect(() =>
        decodeOrchestrationV2TurnItemJson({
          ...item,
          updatedAt: DateTime.formatIso(now),
          ...ownership,
        }),
      ).toThrow();
    }
  });
  it("keeps ordinary and malformed marker notices inert", () => {
    const notice = {
      id: "malformed-fork-notice",
      threadId: "portable-child",
      type: "system_notice",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-04-20T00:00:00.000Z",
      message: "Ordinary notice",
    };
    for (const extra of [
      {},
      {
        forkBoundary: {
          source: { type: "message", threadId: "source" },
          targetThreadId: "portable-child",
        },
      },
      {
        runId: "active-run",
        forkBoundary: {
          source: { type: "message", threadId: "source", messageId: "message", position: "after" },
          targetThreadId: "portable-child",
        },
      },
    ]) {
      expect(decodeOrchestrationV2TurnItemJson({ ...notice, ...extra }).type).toBe("system_notice");
    }
  });
});

const LegacyShellStreamItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationV2ShellSnapshot,
  }),
]);
const LegacySubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  afterSequence: Schema.optionalKey(NonNegativeInt),
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});

const decodeOrchestrationV2Command = Schema.decodeUnknownSync(OrchestrationV2Command);
const isOrchestrationV2Command = Schema.is(OrchestrationV2Command);
const decodeOrchestrationV2TurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const decodeOrchestrationV2TurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const encodeOrchestrationV2TurnItemJson = Schema.encodeSync(OrchestrationV2TurnItemJson);
const decodeOrchestrationV2Subagent = Schema.decodeUnknownSync(OrchestrationV2Subagent);
const encodeOrchestrationV2SubagentJson = Schema.encodeSync(OrchestrationV2SubagentJson);
const decodeOrchestrationV2ProviderThreadJson = Schema.decodeUnknownSync(
  OrchestrationV2ProviderThreadJson,
);
const encodeOrchestrationV2ProviderThreadJson = Schema.encodeSync(
  OrchestrationV2ProviderThreadJson,
);
const decodeOrchestrationV2ProviderThread = Schema.decodeUnknownSync(OrchestrationV2ProviderThread);
const decodeOrchestrationV2ProviderCapabilities = Schema.decodeUnknownSync(
  OrchestrationV2ProviderCapabilities,
);

describe("orchestration V2 contracts", () => {
  it("decodes thread event types from a newer server as skippable items", () => {
    const decodeWireItems = Schema.decodeUnknownSync(
      Schema.toCodecJson(Schema.Array(OrchestrationV2RpcSchemas.subscribeThread.output)),
    );
    const detached = (id: string, sequence: number) => ({
      kind: "event",
      sequence,
      event: {
        id,
        type: "provider-session.detached",
        threadId: "thread-1",
        occurredAt: DateTime.formatIso(now),
        payload: { providerSessionId: "provider-session-1", detachedAt: DateTime.formatIso(now) },
      },
    });

    const items = decodeWireItems([
      detached("event-1", 1),
      {
        kind: "event",
        sequence: 2,
        event: {
          id: "event-2",
          type: "run.from-a-future-server",
          threadId: "thread-1",
          occurredAt: DateTime.formatIso(now),
          payload: { runId: "run-1" },
        },
      },
      detached("event-3", 3),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["event", "unknown-event", "event"]);
    expect(items[1]).toEqual({
      kind: "unknown-event",
      sequence: 2,
      eventType: "run.from-a-future-server",
    });
    expect(() =>
      decodeWireItems([
        { ...detached("event-4", 4), event: { ...detached("event-4", 4).event, payload: {} } },
      ]),
    ).toThrow();
  });

  it("skips turn item types from a newer server in snapshots and turn-item events", () => {
    const decodeWireItems = Schema.decodeUnknownSync(
      Schema.toCodecJson(Schema.Array(OrchestrationV2RpcSchemas.subscribeThread.output)),
    );
    const decodeHistoryPage = Schema.decodeUnknownSync(
      Schema.toCodecJson(OrchestrationV2ThreadHistoryPage),
    );
    const item = (id: string, type: string, extra: Record<string, unknown>) => ({
      id,
      type,
      threadId: "thread-1",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.formatIso(now),
      ...extra,
    });
    const known = item("item-known", "system_notice", { message: "Hello" });
    const future = item("item-future", "hologram", { beam: "ref-1" });
    const projected = (position: number, turnItem: { readonly id: string }) => ({
      position,
      visibility: "local",
      sourceThreadId: "thread-1",
      sourceItemId: turnItem.id,
      item: turnItem,
    });
    const projection = {
      thread: {
        createdBy: "user",
        creationSource: "web",
        id: "thread-1",
        projectId: "project-1",
        title: "Thread",
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
        forkedFrom: null,
        createdAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
        archivedAt: null,
        deletedAt: null,
      },
      runs: [],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [future, known],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [projected(0, future), projected(1, known)],
      updatedAt: DateTime.formatIso(now),
    };
    const turnItemEvent = (sequence: number, payload: unknown) => ({
      kind: "event",
      sequence,
      event: {
        id: `event-${sequence}`,
        type: "turn-item.updated",
        threadId: "thread-1",
        occurredAt: DateTime.formatIso(now),
        payload,
      },
    });

    const [snapshot, futureEvent, knownEvent] = decodeWireItems([
      { kind: "snapshot", snapshotSequence: 1, projection },
      turnItemEvent(2, future),
      turnItemEvent(3, known),
    ]);

    expect(snapshot).toMatchObject({ kind: "snapshot" });
    if (snapshot?.kind !== "snapshot") throw new Error("expected a snapshot");
    expect(snapshot.projection.turnItems.map((turnItem) => turnItem.id)).toEqual(["item-known"]);
    expect(snapshot.projection.visibleTurnItems.map((row) => row.item.id)).toEqual(["item-known"]);
    expect(futureEvent).toEqual({
      kind: "unknown-event",
      sequence: 2,
      eventType: "turn-item.updated",
    });
    expect(knownEvent).toMatchObject({
      kind: "event",
      event: { type: "turn-item.updated", payload: { id: "item-known", type: "system_notice" } },
    });
    expect(
      decodeHistoryPage({
        snapshotSequence: 1,
        items: [projected(0, future), projected(1, known)],
        nextCursor: null,
        hasMoreHistory: false,
      }).items.map((row) => row.item.id),
    ).toEqual(["item-known"]);

    const broken = item("item-broken", "system_notice", {});
    expect(() => decodeWireItems([turnItemEvent(4, broken)])).toThrow();
    expect(() =>
      decodeWireItems([
        {
          kind: "snapshot",
          snapshotSequence: 1,
          projection: { ...projection, turnItems: [broken] },
        },
      ]),
    ).toThrow();
  });

  it("decodes persisted capability snapshots that predate runtimePolicy", () => {
    const legacyCapabilities = {
      sessions: {
        supportsMultipleProviderThreadsPerSession: false,
        supportsModelSwitchInSession: false,
        supportsProviderSwitchingViaHandoff: true,
        supportsRuntimeModeSwitchInSession: false,
        pendingRequestsSurviveRestart: false,
      },
      threads: {
        canCreateEmptyThread: true,
        canReadThreadSnapshot: false,
        canRollbackThread: true,
        canForkThread: false,
        canForkFromTurn: false,
        canForkFromSubagentThread: false,
        exposesNativeThreadId: true,
      },
      turns: {
        exposesNativeTurnId: false,
        emitsTurnStarted: true,
        emitsTurnCompleted: true,
        supportsInterrupt: true,
        supportsActiveSteering: false,
        supportsSteeringByInterruptRestart: true,
        supportsQueuedMessages: true,
        terminalStatusQuality: "strong",
      },
      streaming: {
        streamsAssistantText: true,
        streamsReasoning: true,
        streamsToolOutput: true,
        streamsPlanText: false,
        emitsMessageCompleted: true,
      },
      tools: {
        exposesToolItemIds: true,
        emitsToolStarted: true,
        emitsToolCompleted: true,
        emitsToolOutput: true,
        supportsMcpTools: false,
        supportsDynamicToolCallbacks: false,
      },
      approvals: {
        supportsCommandApproval: true,
        supportsFileReadApproval: true,
        supportsFileChangeApproval: true,
        supportsApplyPatchApproval: false,
        approvalsHaveNativeRequestIds: false,
        approvalCallbacksAreLiveOnly: true,
        approvalsCanOriginateFromSubagents: false,
      },
      planning: {
        emitsPlanUpdated: true,
        emitsTodoList: true,
        emitsProposedPlan: false,
        supportsStructuredQuestions: true,
        planDeltasHaveItemIds: false,
      },
      subagents: {
        supportsSubagents: false,
        exposesSubagentThreadIds: false,
        emitsSubagentLifecycle: false,
        canWaitForSubagents: false,
        canCloseSubagents: false,
        canForkSubagentThread: false,
      },
      context: {
        acceptsSystemContext: false,
        acceptsDeveloperContext: false,
        acceptsSyntheticUserContext: true,
        canGenerateSummaries: true,
        canConsumeHandoffSummaries: true,
        supportsDeltaHandoff: true,
        supportsFullThreadHandoff: true,
        maxRecommendedHandoffChars: null,
      },
      checkpointing: {
        appCanCheckpointFilesystem: true,
        supportsNestedCheckpointScopes: true,
        providerCanRollbackConversation: true,
        providerRollbackReturnsSnapshot: true,
        providerCanReadConversationSnapshot: false,
      },
      identity: {
        nativeThreadIds: "strong",
        nativeTurnIds: "weak",
        nativeItemIds: "weak",
        nativeRequestIds: "weak",
      },
    };

    const decoded = decodeOrchestrationV2ProviderCapabilities(legacyCapabilities);
    expect(decoded.runtimePolicy).toEqual({ enforcement: "client-boundary" });
    expect(decoded.sessions.supportsPerThreadWorkspace).toBeUndefined();
    expect(
      decodeOrchestrationV2ProviderCapabilities({
        ...legacyCapabilities,
        sessions: { ...legacyCapabilities.sessions, supportsPerThreadWorkspace: true },
      }).sessions.supportsPerThreadWorkspace,
    ).toBe(true);

    const explicit = decodeOrchestrationV2ProviderCapabilities({
      ...legacyCapabilities,
      runtimePolicy: { enforcement: "native" },
    });
    expect(explicit.runtimePolicy).toEqual({ enforcement: "native" });
  });

  it.each(["  indented prompt\n", "\n \t\n"])(
    "preserves workflow prompt and result %j in stored and wire JSON",
    (preview) => {
      const subagent = {
        ...decodeOrchestrationV2Subagent({
          id: "workflow-coordinator",
          threadId: "thread-1",
          runId: "run-1",
          parentNodeId: "node-root-1",
          origin: "provider_native",
          createdBy: "agent",
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Run workflow",
          title: null,
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        }),
        workflow: {
          phases: [],
          agents: [
            {
              index: 1,
              label: "Member",
              state: "completed" as const,
              prompt: preview,
              result: preview,
            },
          ],
        },
      };
      const { workflow, ...coordinator } = subagent;
      const incoming = { ...encodeOrchestrationV2SubagentJson(coordinator), workflow };
      for (const codec of [
        OrchestrationV2SubagentJson,
        Schema.toCodecJson(OrchestrationV2Subagent),
      ]) {
        const encode = Schema.encodeSync(codec);
        const decode = Schema.decodeUnknownSync(codec);
        const json: unknown = JSON.parse(JSON.stringify(encode(subagent)));
        expect(json).toMatchObject({
          workflow: { agents: [{ prompt: preview, result: preview }] },
        });
        expect(decode(json).workflow?.agents[0]).toMatchObject({
          prompt: preview,
          result: preview,
        });
        expect(decode(incoming).workflow?.agents[0]).toMatchObject({
          prompt: preview,
          result: preview,
        });
      }
    },
  );

  it("decodes historical provider-thread JSON without pendingBackgroundTasks as empty roster", () => {
    const providerThread = decodeOrchestrationV2ProviderThreadJson({
      id: "provider-thread-1",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: "provider-session-1",
      appThreadId: "thread-1",
      ownerNodeId: null,
      nativeThreadRef: {
        driver: "claude",
        nativeId: "native-session-1",
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    });

    expect(providerThread.pendingBackgroundTasks).toEqual([]);
    expect(providerThread.contextUsage).toBeNull();
    expect(providerThread.nativeMetadata).toBeNull();

    const runtimeThread = decodeOrchestrationV2ProviderThread({
      id: "provider-thread-2",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: null,
      appThreadId: "thread-2",
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(runtimeThread.pendingBackgroundTasks).toEqual([]);
    expect(runtimeThread.contextUsage).toBeNull();
    expect(runtimeThread.nativeMetadata).toBeNull();
  });
});

describe("background work kinds from older or newer servers", () => {
  const storedNotification = (source: unknown) => ({
    id: "notification",
    threadId: "parent",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-09-09T00:00:00.000Z",
    type: "notification",
    outcome: "completed",
    summary: "Background activity updated",
    source,
  });

  it("decodes notification sources stored before specific kinds existed", () => {
    const sourceOf = (source: unknown) => {
      const item = decodeOrchestrationV2TurnItemJson(storedNotification(source));
      return item.type === "notification" ? item.source : undefined;
    };
    expect(
      sourceOf({ kind: "background_task", nativeRef: { driver: "claude", nativeId: "task-1" } }),
    ).toEqual({ kind: "background_task" });
    expect(sourceOf({ kind: "background_command" })).toEqual({ kind: "command" });
    expect(sourceOf({ kind: "monitor" })).toEqual({ kind: "monitor" });
  });

  it("sends and stores sources that clients from before specific kinds still decode", () => {
    const PreSpecificKindsNotification = Schema.Struct({
      type: Schema.Literal("notification"),
      source: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("delegated_task"), taskIds: Schema.Array(NodeId) }),
        Schema.Struct({
          kind: Schema.Literals(["background_task", "background_command", "monitor"]),
          nativeRef: Schema.optional(Schema.Unknown),
        }),
      ]),
      outcome: Schema.Literals(["completed", "failed", "cancelled", "updated", "unknown"]),
      summary: Schema.String,
      detail: Schema.optional(Schema.String),
    });
    const decodePreSpecificKinds = Schema.decodeUnknownSync(PreSpecificKindsNotification);
    const sendOverWire = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2TurnItem));
    const cases = [
      [{ kind: "subagent", childThreadId: "child" }, { kind: "background_task" }],
      [{ kind: "subagent" }, { kind: "background_task" }],
      [{ kind: "command" }, { kind: "background_command" }],
      [{ kind: "monitor" }, { kind: "monitor" }],
      [{ kind: "background_task" }, { kind: "background_task" }],
      [
        { kind: "delegated_task", taskIds: ["task-1"], childThreadId: "child" },
        { kind: "delegated_task", taskIds: ["task-1"] },
      ],
    ] as const;
    for (const [source, preSpecificKindsSource] of cases) {
      const item = decodeOrchestrationV2TurnItemJson(storedNotification(source));
      for (const encoded of [encodeOrchestrationV2TurnItemJson(item), sendOverWire(item)]) {
        expect(decodePreSpecificKinds(encoded).source).toEqual(preSpecificKindsSource);
        expect(decodeOrchestrationV2TurnItemJson(encoded)).toEqual(item);
      }
      expect(item).toMatchObject({ source });
    }
  });

  it("decodes a notification source kind from a newer server as generic background work", () => {
    const item = decodeOrchestrationV2TurnItemJson(
      storedNotification({ kind: "workflow", workflowId: "wf-1" }),
    );
    expect(item).toMatchObject({ type: "notification", source: { kind: "background_task" } });
  });

  it("decodes rosters stored before kinds existed, and kinds from a newer server, as generic tasks", () => {
    const providerThread = decodeOrchestrationV2ProviderThreadJson({
      id: "provider-thread-1",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: null,
      appThreadId: "thread-1",
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      pendingBackgroundTasks: [
        { taskId: "bg-1", description: "Background sleep", taskType: "local_bash" },
        { taskId: "bg-2" },
        { taskId: "bg-3", description: "Nightly", kind: "workflow", schedule: "0 3 * * *" },
        { taskId: "bg-4", description: "npm test", kind: "command" },
        { taskId: "bg-5", kind: "subagent", childThreadId: "thread-child" },
        { taskId: "bg-6", kind: "subagent", providerInstanceId: "claudeAgent" },
      ],
    });
    expect(providerThread.pendingBackgroundTasks).toEqual([
      { taskId: "bg-1", description: "Background sleep", kind: "background_task" },
      { taskId: "bg-2", kind: "background_task" },
      { taskId: "bg-3", description: "Nightly", kind: "background_task" },
      { taskId: "bg-4", description: "npm test", kind: "command" },
      { taskId: "bg-5", kind: "subagent", childThreadId: "thread-child" },
      { taskId: "bg-6", kind: "subagent", providerInstanceId: "claudeAgent" },
    ]);
    const encoded = encodeOrchestrationV2ProviderThreadJson(providerThread).pendingBackgroundTasks;
    expect(encoded).toEqual(providerThread.pendingBackgroundTasks);
    const decodePreKindsRoster = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          taskId: TrimmedNonEmptyString,
          description: Schema.optional(TrimmedNonEmptyString),
          taskType: Schema.optional(TrimmedNonEmptyString),
        }),
      ),
    );
    expect(decodePreKindsRoster(encoded).map((task) => task.taskId)).toEqual([
      "bg-1",
      "bg-2",
      "bg-3",
      "bg-4",
      "bg-5",
      "bg-6",
    ]);
    expect(() =>
      decodeOrchestrationV2ProviderThreadJson({
        ...encodeOrchestrationV2ProviderThreadJson(providerThread),
        pendingBackgroundTasks: [{ taskId: "", kind: "command" }],
      }),
    ).toThrow();
  });
});

it("preserves provider-initiated work identity without admitting an internal command from a client", () => {
  const notification = {
    source: {
      kind: "provider_work",
      workId: "extension-work-1",
      providerThreadId: ProviderThreadId.make("native-thread:work"),
      providerSessionId: ProviderSessionId.make("session:work"),
      modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "fixture-model" },
      runtimePolicy: {
        runtimeMode: "approval-required",
        interactionMode: "plan",
        cwd: "/synthetic/project",
      },
    },
    outcome: "updated",
    summary: "Provider started work",
  } as const;
  const codec = Schema.fromJsonString(OrchestrationV2Notification);
  const encoded = Schema.encodeSync(codec)(notification);
  expect(Schema.decodeSync(codec)(encoded)).toEqual(notification);
  expect(
    isOrchestrationV2Command({
      type: "provider-work.admit",
      commandId: "command:work",
      messageId: "message:work",
      threadId: "thread:work",
      providerThreadId: "native-thread:work",
      providerSessionId: "session:work",
      providerInstanceId: "pi",
      driver: "pi",
      workId: "extension-work-1",
      modelSelection: notification.source.modelSelection,
      runtimePolicy: notification.source.runtimePolicy,
      detail: "Provider started work",
    }),
  ).toBe(false);
});

describe("inert fork initialization handoff provenance", () => {
  const handoff = {
    id: "copied-handoff",
    threadId: "grand",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: "Translated copy",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    inheritedFrom: {
      threadId: "child",
      itemId: "original-handoff",
      runId: "child-run",
      status: "completed",
    },
    type: "handoff",
    contextHandoffId: "initialization-context",
    fromProviderThreadIds: [],
    toProviderThreadId: "historical-provider",
    fromProviderInstanceIds: [],
    toProviderInstanceId: "omp",
    strategy: "full_thread_summary",
  };
  const proof = {
    transferId: "fork-transfer",
    contextHandoffId: "initialization-context",
    threadId: "child",
    runId: "child-run",
  };
  it("preserves causal IDs in Type and JSON codecs without restoring live ownership", () => {
    const item = decodeOrchestrationV2TurnItem({
      ...handoff,
      forkInitialization: proof,
    });
    expect(decodeForkTypeJson(encodeForkTypeJson(item))).toEqual(item);
    const json = encodeOrchestrationV2TurnItemJson(item);
    expect(decodeOrchestrationV2TurnItemJson(json)).toEqual(item);
    expect(item.runId).toBeNull();
    expect(item.nativeItemRef).toBeNull();
    expect(json).toHaveProperty("forkInitialization", proof);
  });
  it("keeps older optional-absent handoffs readable", () => {
    const item = decodeOrchestrationV2TurnItem(handoff);
    expect(decodeForkTypeJson(encodeForkTypeJson(item))).toEqual(item);
    expect(item).not.toHaveProperty("forkInitialization");
  });
  it("rejects an incomplete causal proof instead of silently accepting it", () => {
    expect(() =>
      decodeOrchestrationV2TurnItem({
        ...handoff,
        forkInitialization: { transferId: "fork-transfer", threadId: "child", runId: "child-run" },
      }),
    ).toThrow();
    const json = {
      ...handoff,
      startedAt: DateTime.formatIso(now),
      completedAt: DateTime.formatIso(now),
      updatedAt: DateTime.formatIso(now),
    };
    expect(() =>
      decodeOrchestrationV2TurnItemJson({
        ...json,
        forkInitialization: { ...proof, runId: null },
      }),
    ).toThrow();
  });
});

describe("inert citation presentation bounds", () => {
  const valid = {
    format: "codex-private-v1",
    sources: [{ id: "s", url: "https://example.test", title: "Study" }],
  };
  it("accepts an empty recognized scope and rejects oversized or untrusted fields", () => {
    expect(isCitationPresentation(valid)).toBe(true);
    expect(isCitationPresentation({ format: "codex-private-v1", sources: [] })).toBe(true);
    for (const value of [
      { ...valid, sources: Array.from({ length: 129 }, () => valid.sources[0]) },
      { ...valid, sources: [{ ...valid.sources[0], id: "x".repeat(257) }] },
      { ...valid, sources: [{ ...valid.sources[0], url: "x".repeat(32769) }] },
      { ...valid, sources: [{ ...valid.sources[0], title: "x".repeat(1025) }] },
      { ...valid, format: "arbitrary-provider" },
      { ...valid, sources: [{ id: "s", url: { toString: () => "https://example.test" } }] },
    ])
      expect(decodeCitationPresentation(value)._tag).toBe("None");
  });
});

const providerTurnCodec = Schema.toCodecJson(OrchestrationV2ProviderTurn);
const decodeEffortTurn = Schema.decodeUnknownSync(providerTurnCodec);
const encodeEffortTurn = Schema.encodeSync(providerTurnCodec);
const decodeEffortTurnJson = Schema.decodeUnknownSync(OrchestrationV2ProviderTurnJson);
const oldEffortTurn = {
  id: "observed-effort-turn",
  providerThreadId: "observed-effort-thread",
  nodeId: "observed-effort-root",
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal: 1,
  status: "completed",
  startedAt: null,
  completedAt: null,
};
describe("optional observed native root effort", () => {
  it("keeps transport undefined distinct from a typed JSON clear", () => {
    expect(
      decodeEffortTurn({ ...oldEffortTurn, observedEffort: null }).observedEffort,
    ).toBeUndefined();
    expect(() => decodeEffortTurnJson({ ...oldEffortTurn, observedEffort: null })).toThrow();
  });
  it("retains old absent Type/JSON records without inventing an effort or acceptance", () => {
    const decoded = decodeEffortTurn(oldEffortTurn);
    expect(decoded).not.toHaveProperty("observedEffort");
    expect(decoded).not.toHaveProperty("nativeAcceptance");
    expect(decodeEffortTurnJson(encodeEffortTurn(decoded))).toEqual(oldEffortTurn);
  });
  it.each(
    ["off", "high"].map((observedEffort) => ({
      caseTitle: `round-trips explicit ${observedEffort} without changing execution ownership`,
      observedEffort,
    })),
  )("$caseTitle", ({ observedEffort }) => {
    const decoded = decodeEffortTurn({ ...oldEffortTurn, observedEffort });
    expect(decodeEffortTurnJson(encodeEffortTurn(decoded))).toEqual({
      ...oldEffortTurn,
      observedEffort,
    });
    expect(decoded.nodeId).toBe(oldEffortTurn.nodeId);
    expect(decoded.runAttemptId).toBeNull();
  });
  it.each(
    ["", " ", "x".repeat(65)].map((observedEffort) => ({
      caseTitle: `rejects invalid observed display metadata ${String(observedEffort).slice(0, 12)}`,
      observedEffort,
    })),
  )("$caseTitle", ({ observedEffort }) => {
    expect(() => decodeEffortTurn({ ...oldEffortTurn, observedEffort })).toThrow();
    expect(() => decodeEffortTurnJson({ ...oldEffortTurn, observedEffort })).toThrow();
  });
});

const decodeDroidHeldSteer = Schema.decodeUnknownSync(OrchestrationV2DroidHeldSteer);
const droidHeldSteerJson = Schema.fromJsonString(OrchestrationV2DroidHeldSteer);
const encodeDroidHeldSteerJson = Schema.encodeSync(droidHeldSteerJson);
const decodeDroidHeldSteerJson = Schema.decodeSync(droidHeldSteerJson);

describe("Droid held admission contract", () => {
  it("round-trips captured intent without native readiness authority and keeps its command server-only", () => {
    const held = decodeDroidHeldSteer({
      revision: "revision",
      messageId: "message",
      sourceAttemptId: "attempt",
      sourceRootNodeId: "root",
      sourceProviderTurnId: "turn",
      sourceProviderSessionId: "session",
      modelSelection: { instanceId: "droid", model: "model", options: [] },
      runtimePolicy: {
        cwd: "/captured",
        runtimeMode: "full-access",
        interactionMode: "plan",
        reasoningEffort: "high",
      },
      phase: "pre_admission",
      admissionLease: "descriptive-lease",
    });
    const encoded = encodeDroidHeldSteerJson(held);
    expect(decodeDroidHeldSteerJson(encoded)).toEqual(held);
    expect(() =>
      decodeOrchestrationV2Command({
        type: "droid-steer.admission",
        commandId: "claim",
        threadId: "thread",
        runId: "run",
        revision: "revision",
        operation: "complete",
        lease: "descriptive-lease",
      }),
    ).toThrow();
  });
});

describe("latestProviderTurnForAttempt", () => {
  it("returns the attempt's highest-ordinal turn, as a Codex goal run spans several", () => {
    const turns = [
      { id: "first", runAttemptId: RunAttemptId.make("goal-attempt"), ordinal: 3 },
      { id: "other", runAttemptId: RunAttemptId.make("other-attempt"), ordinal: 9 },
      { id: "last", runAttemptId: RunAttemptId.make("goal-attempt"), ordinal: 5 },
      { id: "subagent", runAttemptId: null, ordinal: 7 },
    ];
    expect(latestProviderTurnForAttempt(turns, RunAttemptId.make("goal-attempt"))?.id).toBe("last");
    expect(latestProviderTurnForAttempt(turns, null)).toBeUndefined();
  });
});
