import { assert, it, vi } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  CheckpointScopeId,
  ChatAttachmentId,
  ChatFileAttachment,
  CommandId,
  ContextHandoffId,
  type OrchestrationV2ContextHandoff,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ServerSettingsError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import {
  ProviderAdapterEventStreamError,
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
} from "./ProviderAdapter.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import {
  ThreadCommandExecutor,
  layer as threadCommandExecutorLayer,
} from "./ThreadCommandExecutor.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";

const driver = ProviderDriverKind.make("codex");

const RunExecutionTestLayer = RunExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
      Layer.mock(EventSink.EventSinkV2)({}),
      IdAllocator.layer,
      Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
        ingestNormalized: () => Effect.succeed([]),
      }),
      ServerSettings.layerTest(),
    ),
  ),
);

it("keeps recoverable turn failures reusable and reserves error for broken threads", () => {
  assert.equal(RunExecutionService.finalProviderThreadStatus("reusable"), "idle");
  assert.equal(RunExecutionService.finalProviderThreadStatus("broken"), "error");
});

it.effect("routes shared-runtime events only to their owning root run", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const first: RunExecutionService.ProviderEventRouteIdentity = {
      driver,
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId: ThreadId.make("thread:shared-runtime:first"),
      runId: RunId.make("run:shared-runtime:first"),
      attemptId: RunAttemptId.make("attempt:shared-runtime:first"),
      providerThreadId: ProviderThreadId.make("provider-thread:shared-runtime:first"),
    };
    const second: RunExecutionService.ProviderEventRouteIdentity = {
      driver,
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId: ThreadId.make("thread:shared-runtime:second"),
      runId: RunId.make("run:shared-runtime:second"),
      attemptId: RunAttemptId.make("attempt:shared-runtime:second"),
      providerThreadId: ProviderThreadId.make("provider-thread:shared-runtime:second"),
    };
    const firstTurnId = ProviderTurnId.make("provider-turn:shared-runtime:first");
    const turnEvent: ProviderAdapterV2Event = {
      type: "provider_turn.updated",
      driver,
      threadId: first.threadId,
      providerTurn: {
        id: firstTurnId,
        providerThreadId: first.providerThreadId,
        nodeId: NodeId.make("node:shared-runtime:first"),
        runAttemptId: first.attemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    };
    const messageEvent: ProviderAdapterV2Event = {
      type: "message.updated",
      driver,
      message: {
        createdBy: "agent",
        creationSource: "provider",
        id: MessageId.make("message:shared-runtime:first"),
        threadId: first.threadId,
        runId: first.runId,
        nodeId: NodeId.make("node:shared-runtime:first"),
        role: "assistant",
        text: "first only",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    };
    const terminalEvent: ProviderAdapterV2Event = {
      type: "turn.terminal",
      driver,
      providerThreadId: first.providerThreadId,
      providerTurnId: firstTurnId,
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    };

    const firstInitial = RunExecutionService.makeProviderEventRoutingState({
      identity: first,
      providerTurnId: null,
    });
    const secondInitial = RunExecutionService.makeProviderEventRoutingState({
      identity: second,
      providerTurnId: null,
    });
    const [firstTurnAccepted, firstAfterTurn] = RunExecutionService.routeProviderEvent(
      turnEvent,
      first,
      firstInitial,
    );
    const [secondTurnAccepted, secondAfterTurn] = RunExecutionService.routeProviderEvent(
      turnEvent,
      second,
      secondInitial,
    );

    assert.isTrue(firstTurnAccepted);
    assert.isFalse(secondTurnAccepted);
    assert.isTrue(RunExecutionService.routeProviderEvent(messageEvent, first, firstAfterTurn)[0]);
    assert.isFalse(
      RunExecutionService.routeProviderEvent(messageEvent, second, secondAfterTurn)[0],
    );
    assert.isTrue(RunExecutionService.routeProviderEvent(terminalEvent, first, firstAfterTurn)[0]);
    assert.isFalse(
      RunExecutionService.routeProviderEvent(terminalEvent, second, secondAfterTurn)[0],
    );
  }),
);

it("leaves a child thread created after the root turn ended to the run that is live then", () => {
  const threadId = ThreadId.make("thread:late-child");
  const rootProviderTurnId = ProviderTurnId.make("provider-turn:late-child");
  const identity: RunExecutionService.ProviderEventRouteIdentity = {
    driver,
    providerInstanceId: ProviderInstanceId.make("codex"),
    threadId,
    runId: RunId.make("run:late-child"),
    attemptId: RunAttemptId.make("attempt:late-child"),
    providerThreadId: ProviderThreadId.make("provider-thread:late-child"),
  };
  const childCreated = (childThreadId: ThreadId): ProviderAdapterV2Event =>
    ({
      type: "app_thread.created",
      driver,
      appThread: {
        id: childThreadId,
        lineage: {
          parentThreadId: threadId,
          relationshipToParent: "subagent",
          rootThreadId: threadId,
        },
      },
    }) as ProviderAdapterV2Event;
  const earlyChild = ThreadId.make("thread:late-child:early");
  const lateChild = ThreadId.make("thread:late-child:late");

  const initial = RunExecutionService.makeProviderEventRoutingState({
    identity,
    providerTurnId: rootProviderTurnId,
  });
  const [earlyAccepted, live] = RunExecutionService.routeProviderEvent(
    childCreated(earlyChild),
    identity,
    initial,
  );
  assert.isTrue(earlyAccepted);
  const [terminalAccepted, ended] = RunExecutionService.routeProviderEvent(
    {
      type: "turn.terminal",
      driver,
      providerThreadId: identity.providerThreadId,
      providerTurnId: rootProviderTurnId,
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    },
    identity,
    live,
  );
  assert.isTrue(terminalAccepted);
  // A child the root launched before it ended stays with this run.
  assert.isTrue(ended.ownedThreadIds.has(earlyChild));
  const [lateAccepted, afterLate] = RunExecutionService.routeProviderEvent(
    childCreated(lateChild),
    identity,
    ended,
  );
  assert.isFalse(lateAccepted);
  assert.isFalse(afterLate.ownedThreadIds.has(lateChild));
});

it.effect("routes inert workflow slots only through an accepted native coordinator", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const identity: RunExecutionService.ProviderEventRouteIdentity = {
      driver,
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId: ThreadId.make("workflow-owner"),
      runId: RunId.make("workflow-run"),
      attemptId: RunAttemptId.make("workflow-attempt"),
      providerThreadId: ProviderThreadId.make("workflow-provider-thread"),
    };
    const coordinator: OrchestrationV2Subagent = {
      id: NodeId.make("native-workflow"),
      threadId: identity.threadId,
      runId: identity.runId,
      parentNodeId: NodeId.make("workflow-root"),
      origin: "provider_native",
      createdBy: "agent",
      driver,
      providerInstanceId: identity.providerInstanceId,
      providerThreadId: null,
      childThreadId: ThreadId.make("workflow-coordinator-child"),
      nativeTaskRef: { driver, nativeId: "workflow-task", strength: "strong" },
      prompt: "",
      title: "Workflow",
      model: null,
      status: "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      presentation: { kind: "workflow" },
    };
    const member: OrchestrationV2Subagent = {
      ...coordinator,
      id: NodeId.make("native-workflow-member"),
      runId: null,
      parentNodeId: coordinator.id,
      childThreadId: null,
      nativeTaskRef: null,
      presentation: { kind: "workflow_agent", workflowId: coordinator.id, agentIndex: 0 },
    };
    const initial = RunExecutionService.makeProviderEventRoutingState({
      identity,
      providerTurnId: null,
    });
    const memberEvent = { type: "subagent.updated", driver, subagent: member } as const;
    assert.isFalse(RunExecutionService.routeProviderEvent(memberEvent, identity, initial)[0]);
    const [accepted, owned] = RunExecutionService.routeProviderEvent(
      { type: "subagent.updated", driver, subagent: coordinator },
      identity,
      initial,
    );
    assert.isTrue(accepted);
    for (const foreign of [
      { ...member, threadId: ThreadId.make("sibling-thread") },
      { ...member, providerInstanceId: ProviderInstanceId.make("sibling-instance") },
      { ...member, driver: ProviderDriverKind.make("claudeAgent") },
      { ...member, parentNodeId: NodeId.make("unowned-parent") },
      { ...member, nativeTaskRef: coordinator.nativeTaskRef },
      { ...member, childThreadId: coordinator.childThreadId },
      {
        ...member,
        presentation: {
          kind: "workflow_agent" as const,
          workflowId: NodeId.make("spoofed-parent"),
        },
      },
    ])
      assert.isFalse(
        RunExecutionService.routeProviderEvent(
          { ...memberEvent, subagent: foreign },
          identity,
          owned,
        )[0],
      );
    const [memberAccepted, withMember] = RunExecutionService.routeProviderEvent(
      memberEvent,
      identity,
      owned,
    );
    assert.isTrue(memberAccepted);
    const node: OrchestrationV2ExecutionNode = {
      id: member.id,
      threadId: member.threadId,
      runId: null,
      parentNodeId: coordinator.id,
      rootNodeId: coordinator.id,
      kind: "subagent",
      status: "running",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    assert.isTrue(
      RunExecutionService.routeProviderEvent(
        { type: "node.updated", driver, node },
        identity,
        withMember,
      )[0],
    );
    assert.isFalse(
      RunExecutionService.routeProviderEvent(
        { type: "node.updated", driver, node: { ...node, countsForRun: true } },
        identity,
        withMember,
      )[0],
    );
    assert.isFalse(
      RunExecutionService.routeProviderEvent(
        {
          type: "node.updated",
          driver,
          node: { ...node, checkpointScopeId: CheckpointScopeId.make("unowned-scope") },
        },
        identity,
        withMember,
      )[0],
    );
    const [, afterTerminal] = RunExecutionService.routeProviderEvent(
      {
        type: "subagent.updated",
        driver,
        subagent: { ...coordinator, status: "completed", completedAt: now },
      },
      identity,
      withMember,
    );
    assert.isFalse(RunExecutionService.routeProviderEvent(memberEvent, identity, afterTerminal)[0]);
    assert.isTrue(
      RunExecutionService.routeProviderEvent(
        { ...memberEvent, subagent: { ...member, status: "completed", completedAt: now } },
        identity,
        afterTerminal,
      )[0],
    );
    const [, transferred] = RunExecutionService.routeProviderEvent(
      {
        type: "subagent.updated",
        driver,
        subagent: { ...coordinator, runId: RunId.make("later-workflow-run") },
      },
      identity,
      withMember,
    );
    assert.isFalse(RunExecutionService.routeProviderEvent(memberEvent, identity, transferred)[0]);
    assert.isFalse(
      RunExecutionService.routeProviderEvent(
        { type: "node.updated", driver, node },
        identity,
        transferred,
      )[0],
    );
  }),
);

it("does not route a superseded attempt through a reused provider thread", () => {
  const threadId = ThreadId.make("thread:shared-runtime:restart");
  const providerThreadId = ProviderThreadId.make("provider-thread:shared-runtime:restart");
  const oldAttempt: RunExecutionService.ProviderEventRouteIdentity = {
    driver,
    providerInstanceId: ProviderInstanceId.make("codex"),
    threadId,
    runId: RunId.make("run:shared-runtime:restart"),
    attemptId: RunAttemptId.make("attempt:shared-runtime:restart:old"),
    providerThreadId,
  };
  const newAttempt: RunExecutionService.ProviderEventRouteIdentity = {
    ...oldAttempt,
    attemptId: RunAttemptId.make("attempt:shared-runtime:restart:new"),
  };
  const oldTurnEvent: ProviderAdapterV2Event = {
    type: "provider_turn.updated",
    driver,
    threadId,
    providerTurn: {
      id: ProviderTurnId.make("provider-turn:shared-runtime:restart:old"),
      providerThreadId,
      nodeId: NodeId.make("node:shared-runtime:restart:old"),
      runAttemptId: oldAttempt.attemptId,
      nativeTurnRef: null,
      ordinal: 1,
      status: "interrupted",
      startedAt: null,
      completedAt: null,
    },
  };

  const newState = RunExecutionService.makeProviderEventRoutingState({
    identity: newAttempt,
    providerTurnId: null,
  });
  assert.isFalse(RunExecutionService.routeProviderEvent(oldTurnEvent, newAttempt, newState)[0]);
});

it("routes only exact same-thread background items inherited from settled runs", () => {
  const threadId = ThreadId.make("thread:inherited-background-routing");
  const otherThreadId = ThreadId.make("thread:inherited-background-routing:other");
  const priorRunId = RunId.make("run:inherited-background-routing:prior");
  const currentRunId = RunId.make("run:inherited-background-routing:current");
  const itemId = TurnItemId.make("turn-item:inherited-background-routing");
  const identity: RunExecutionService.ProviderEventRouteIdentity = {
    driver,
    providerInstanceId: ProviderInstanceId.make("codex"),
    threadId,
    runId: currentRunId,
    attemptId: RunAttemptId.make("attempt:inherited-background-routing:current"),
    providerThreadId: ProviderThreadId.make("provider-thread:inherited-background-routing:current"),
  };
  const initial = RunExecutionService.makeProviderEventRoutingState({
    identity,
    inheritedBackgroundTurnItems: [{ id: itemId, runId: priorRunId }],
    providerTurnId: null,
  });
  const inheritedRunning = {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: itemId,
      threadId,
      runId: priorRunId,
      providerTurnId: null,
      ordinal: 1,
      type: "subagent",
      status: "running",
    },
  } as Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>;
  const unrelatedRunItem = {
    ...inheritedRunning,
    turnItem: {
      ...inheritedRunning.turnItem,
      runId: RunId.make("run:inherited-background-routing:unrelated"),
    },
  } as ProviderAdapterV2Event;
  const unlistedPriorItem = {
    ...inheritedRunning,
    turnItem: {
      ...inheritedRunning.turnItem,
      id: TurnItemId.make("turn-item:inherited-background-routing:unrelated"),
    },
  } as ProviderAdapterV2Event;
  const unrelatedThreadItem = {
    ...inheritedRunning,
    turnItem: { ...inheritedRunning.turnItem, threadId: otherThreadId },
  } as ProviderAdapterV2Event;
  const ordinaryItem = {
    ...inheritedRunning,
    turnItem: { ...inheritedRunning.turnItem, type: "reasoning" as const },
  } as ProviderAdapterV2Event;
  const inheritedTerminal = {
    ...inheritedRunning,
    turnItem: { ...inheritedRunning.turnItem, status: "completed" as const },
  } as ProviderAdapterV2Event;

  const [runningAccepted, afterRunning] = RunExecutionService.routeProviderEvent(
    inheritedRunning,
    identity,
    initial,
  );
  assert.isTrue(runningAccepted);
  assert.isFalse(
    RunExecutionService.routeProviderEvent(unrelatedRunItem, identity, afterRunning)[0],
  );
  assert.isFalse(
    RunExecutionService.routeProviderEvent(unlistedPriorItem, identity, afterRunning)[0],
  );
  assert.isFalse(
    RunExecutionService.routeProviderEvent(unrelatedThreadItem, identity, afterRunning)[0],
  );
  assert.isFalse(RunExecutionService.routeProviderEvent(ordinaryItem, identity, afterRunning)[0]);

  const [terminalAccepted, afterTerminal] = RunExecutionService.routeProviderEvent(
    inheritedTerminal,
    identity,
    afterRunning,
  );
  assert.isTrue(terminalAccepted);
  assert.isFalse(
    RunExecutionService.routeProviderEvent(inheritedRunning, identity, afterTerminal)[0],
    "a nonterminal replay must not resurrect an inherited terminal",
  );
});

it("selects only live background items from non-completed settled prior runs", () => {
  const threadId = ThreadId.make("thread:inherited-background-selection");
  const otherThreadId = ThreadId.make("thread:inherited-background-selection:other");
  const currentProviderThreadId = ProviderThreadId.make(
    "provider-thread:inherited-background-selection:current",
  );
  const foreignProviderThreadId = ProviderThreadId.make(
    "provider-thread:inherited-background-selection:foreign-session",
  );
  const interruptedRunId = RunId.make("run:inherited-background-selection:interrupted");
  const failedRunId = RunId.make("run:inherited-background-selection:failed");
  const cancelledRunId = RunId.make("run:inherited-background-selection:cancelled");
  const completedRunId = RunId.make("run:inherited-background-selection:completed");
  const rolledBackRunId = RunId.make("run:inherited-background-selection:rolled-back");
  const currentRunId = RunId.make("run:inherited-background-selection:current");
  const inheritedItemId = TurnItemId.make("turn-item:inherited-background-selection:live");
  const failedItemId = TurnItemId.make("turn-item:inherited-background-selection:failed");
  const cancelledItemId = TurnItemId.make("turn-item:inherited-background-selection:cancelled");
  const makeRun = (
    id: RunId,
    ordinal: number,
    status: OrchestrationV2Run["status"],
    runThreadId = threadId,
  ) =>
    ({
      id,
      threadId: runThreadId,
      ordinal,
      status,
    }) as OrchestrationV2Run;
  const makeItem = (
    id: TurnItemId,
    runId: RunId,
    status: OrchestrationV2TurnItem["status"],
    type: OrchestrationV2TurnItem["type"] = "subagent",
    itemThreadId = threadId,
    providerThreadId = currentProviderThreadId,
  ) =>
    ({
      id,
      threadId: itemThreadId,
      runId,
      providerThreadId,
      type,
      status,
    }) as OrchestrationV2TurnItem;

  const selected = RunExecutionService.selectInheritedBackgroundTurnItems({
    threadId,
    currentProviderThreadId,
    currentRunOrdinal: 6,
    runs: [
      makeRun(interruptedRunId, 1, "interrupted"),
      makeRun(failedRunId, 2, "failed"),
      makeRun(cancelledRunId, 3, "cancelled"),
      makeRun(completedRunId, 4, "completed"),
      makeRun(rolledBackRunId, 5, "rolled_back"),
      makeRun(currentRunId, 6, "running"),
      makeRun(
        RunId.make("run:inherited-background-selection:other"),
        1,
        "interrupted",
        otherThreadId,
      ),
    ],
    turnItems: [
      makeItem(inheritedItemId, interruptedRunId, "running"),
      makeItem(failedItemId, failedRunId, "running"),
      makeItem(cancelledItemId, cancelledRunId, "running"),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:completed-run"),
        completedRunId,
        "running",
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:terminal"),
        interruptedRunId,
        "completed",
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:ordinary"),
        interruptedRunId,
        "running",
        "reasoning",
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:rolled-back"),
        rolledBackRunId,
        "running",
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:other-thread"),
        interruptedRunId,
        "running",
        "subagent",
        otherThreadId,
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:foreign-provider"),
        interruptedRunId,
        "running",
        "subagent",
        threadId,
        foreignProviderThreadId,
      ),
    ],
  });

  assert.deepEqual(selected, [
    { id: inheritedItemId, runId: interruptedRunId },
    { id: failedItemId, runId: failedRunId },
    { id: cancelledItemId, runId: cancelledRunId },
  ]);
});

it("does not carry interrupted or still-running child ownership into later attempts", () => {
  assert.isFalse(RunExecutionService.canRouteRelatedSubagent("interrupted"));
  assert.isFalse(RunExecutionService.canRouteRelatedSubagent("failed"));
  assert.isFalse(RunExecutionService.canRouteRelatedSubagent("cancelled"));
  assert.isTrue(RunExecutionService.canRouteRelatedSubagent("completed"));
  // The launching run still ingests a running subagent's child thread.
  assert.isFalse(RunExecutionService.canRouteRelatedSubagent("running"));

  const threadId = ThreadId.make("thread:related-child:next-attempt");
  const childThreadId = ThreadId.make("thread:related-child:interrupted");
  const identity: RunExecutionService.ProviderEventRouteIdentity = {
    driver,
    providerInstanceId: ProviderInstanceId.make("codex"),
    threadId,
    runId: RunId.make("run:related-child:next-attempt"),
    attemptId: RunAttemptId.make("attempt:related-child:next-attempt"),
    providerThreadId: ProviderThreadId.make("provider-thread:related-child:next-attempt"),
  };
  const state = RunExecutionService.makeProviderEventRoutingState({
    identity,
    providerTurnId: null,
    relatedThreadIds: RunExecutionService.canRouteRelatedSubagent("interrupted")
      ? [childThreadId]
      : [],
  });
  const childNodeId = NodeId.make("node:related-child:interrupted");
  const lateChildNode = {
    type: "node.updated",
    driver,
    node: {
      id: childNodeId,
      threadId: childThreadId,
      runId: null,
      parentNodeId: null,
      rootNodeId: childNodeId,
      kind: "root_turn",
      status: "completed",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: null,
      completedAt: null,
    },
  } satisfies ProviderAdapterV2Event;

  assert.isFalse(RunExecutionService.routeProviderEvent(lateChildNode, identity, state)[0]);
});

it.effect("rechecks run ownership immediately before calling the provider", () =>
  Effect.gen(function* () {
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const guardCalls = yield* Ref.make(0);
    const providerStarts = yield* Ref.make(0);
    const threadId = ThreadId.make("thread:run-execution-start-guard");
    const runId = RunId.make("run:run-execution-start-guard");
    const attemptId = RunAttemptId.make("attempt:run-execution-start-guard");
    const providerThreadId = ProviderThreadId.make("provider-thread:run-execution-start-guard");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-start-guard");
    const rootNodeId = NodeId.make("node:run-execution-start-guard");
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
    } as OrchestrationV2Run;
    const rootNode = { id: rootNodeId } as OrchestrationV2ExecutionNode;
    const providerThread = {
      id: providerThreadId,
      driver,
    } as OrchestrationV2ProviderThread;
    const attempt = {
      id: attemptId,
      providerTurnId: null,
    } as OrchestrationV2RunAttempt;
    const session = {
      events: Stream.never,
      startTurn: () => Ref.update(providerStarts, (count) => count + 1),
    } as unknown as ProviderAdapterV2SessionRuntime;

    yield* runExecution.startRootRun({
      commandId: CommandId.make("command:run-execution-start-guard"),
      appThread: { id: threadId } as OrchestrationV2AppThread,
      providerSessionId,
      session,
      run,
      rootNode,
      checkpointScope: {
        id: CheckpointScopeId.make("checkpoint-scope:run-execution-start-guard"),
      } as OrchestrationV2CheckpointScope,
      providerThread,
      attempt,
      attemptId,
      providerTurnOrdinal: 1,
      shouldStartProviderTurn: () =>
        Ref.modify(guardCalls, (calls) => [calls === 0, calls + 1] as const),
      message: {
        messageId: MessageId.make("message:run-execution-start-guard"),
        text: "Do not start after ownership changes.",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      },
    });

    assert.equal(yield* Ref.get(guardCalls), 2);
    assert.equal(yield* Ref.get(providerStarts), 0);
  }).pipe(Effect.provide(RunExecutionTestLayer)),
);

it.effect(
  "dispatches only attachment-free compact commands through the native compaction path",
  () =>
    Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      const calls: Array<string> = [];
      const attachment = ChatFileAttachment.make({
        type: "file",
        id: ChatAttachmentId.make("compact-file-12345678-1234-1234-1234-123456789abc"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
      });
      const cases = [
        { text: " /compact ", attachments: [], expected: "compact" },
        { text: "/compact", attachments: [attachment], expected: "prompt" },
        { text: "Continue the work", attachments: [], expected: "prompt" },
      ];
      for (const [index, testCase] of cases.entries()) {
        const threadId = ThreadId.make(`thread:compact-routing:${index}`);
        const attemptId = RunAttemptId.make(`attempt:compact-routing:${index}`);
        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:compact-routing:${index}`),
          appThread: { id: threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:compact-routing:${index}`),
          session: {
            events: Stream.never,
            startTurn: () =>
              Effect.sync(() => {
                calls.push("prompt");
              }),
            compactThread: () =>
              Effect.sync(() => {
                calls.push("compact");
              }),
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: RunId.make(`run:compact-routing:${index}`),
            threadId,
            ordinal: 1,
            providerInstanceId: ProviderInstanceId.make("codex"),
          } as OrchestrationV2Run,
          rootNode: {
            id: NodeId.make(`node:compact-routing:${index}`),
          } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make(`checkpoint:compact-routing:${index}`),
          } as OrchestrationV2CheckpointScope,
          providerThread: {
            id: ProviderThreadId.make(`provider-thread:compact-routing:${index}`),
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
          attemptId,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make(`message:compact-routing:${index}`),
            text: testCase.text,
            attachments: testCase.attachments,
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }
      assert.deepEqual(
        calls,
        cases.map((testCase) => testCase.expected),
      );
    }).pipe(Effect.provide(RunExecutionTestLayer)),
);

it.effect("refreshes MCP credential liveness before calling the provider", () =>
  Effect.gen(function* () {
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const threadId = ThreadId.make("thread:run-execution-mcp-liveness");
    const touchActiveMcpThread = vi
      .spyOn(McpSessionRegistry, "touchActiveMcpThread")
      .mockImplementation((touchedThreadId) =>
        Ref.update(order, (entries) => [...entries, `touch:${touchedThreadId}`]),
      );

    yield* runExecution
      .startRootRun({
        commandId: CommandId.make("command:run-execution-mcp-liveness"),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make("session:run-execution-mcp-liveness"),
        session: {
          events: Stream.never,
          startTurn: () => Ref.update(order, (entries) => [...entries, "start-turn"]),
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: {
          id: RunId.make("run:run-execution-mcp-liveness"),
          threadId,
          ordinal: 1,
          providerInstanceId: ProviderInstanceId.make("codex"),
        } as OrchestrationV2Run,
        rootNode: {
          id: NodeId.make("node:run-execution-mcp-liveness"),
        } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make("checkpoint-scope:run-execution-mcp-liveness"),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: ProviderThreadId.make("provider-thread:run-execution-mcp-liveness"),
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: RunAttemptId.make("attempt:run-execution-mcp-liveness"),
          providerTurnId: null,
        } as OrchestrationV2RunAttempt,
        attemptId: RunAttemptId.make("attempt:run-execution-mcp-liveness"),
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make("message:run-execution-mcp-liveness"),
          text: "Keep the MCP credential alive.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      })
      .pipe(Effect.ensuring(Effect.sync(() => touchActiveMcpThread.mockRestore())));

    assert.deepEqual(yield* Ref.get(order), [`touch:${threadId}`, "start-turn"]);
  }).pipe(Effect.provide(RunExecutionTestLayer)),
);

it.effect("starts the provider when checkpoint baseline capture fails", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:run-execution-baseline-failure");
    const runId = RunId.make("run:run-execution-baseline-failure");
    const attemptId = RunAttemptId.make("attempt:run-execution-baseline-failure");
    const providerThreadId = ProviderThreadId.make(
      "provider-thread:run-execution-baseline-failure",
    );
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-baseline-failure");
    const rootNodeId = NodeId.make("node:run-execution-baseline-failure");
    const checkpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:run-execution-baseline-failure"),
    } as OrchestrationV2CheckpointScope;
    const providerStarts = yield* Ref.make(0);
    const writes = yield* Ref.make<
      ReadonlyArray<{
        events: ReadonlyArray<OrchestrationV2DomainEvent>;
        effects: ReadonlyArray<PendingOrchestrationEffectV2>;
      }>
    >([]);
    const testLayer = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            captureBaseline: () =>
              Effect.fail(
                new CheckpointService.CheckpointBaselineCaptureError({
                  scopeId: checkpointScope.id,
                  ordinalWithinScope: 0,
                  cause: new Error("VCS process timed out"),
                }),
              ),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Ref.update(writes, (current) => [
                ...current,
                { events: input.events, effects: input.effects },
              ]).pipe(Effect.as([])),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-baseline-failure"),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId,
        session: {
          events: Stream.never,
          startTurn: () => Ref.update(providerStarts, (count) => count + 1),
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope,
        providerThread: {
          id: providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: attemptId,
          providerTurnId: null,
        } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make("message:run-execution-baseline-failure"),
          text: "Start the provider without a baseline.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(testLayer));

    assert.equal(yield* Ref.get(providerStarts), 1);

    const events = (yield* Ref.get(writes)).flatMap((write) => [...write.events]);
    const failedEvent = events.find(
      (event) =>
        (event.type === "run.updated" ||
          event.type === "run-attempt.updated" ||
          event.type === "node.updated") &&
        event.payload.status === "failed",
    );
    assert.isUndefined(failedEvent);
    const errorItem = events.find(
      (event) => event.type === "turn-item.updated" && event.payload.type === "error",
    );
    assert.isUndefined(errorItem);
  }),
);

for (const scenario of [
  "failure",
  "interruption",
  "stale-attempt",
  "start-guard",
  "handoff-interruption-after-record",
  "handoff-interruption-before-agent",
] as const) {
  it.effect(`handles ${scenario} before the provider turn starts`, () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:run-execution-settings-failure");
      const runId = RunId.make("run:run-execution-settings-failure");
      const attemptId = RunAttemptId.make("attempt:run-execution-settings-failure");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const providerSessionId = ProviderSessionId.make("session:run-execution-settings-failure");
      const providerThreadId = ProviderThreadId.make(
        "provider-thread:run-execution-settings-failure",
      );
      const rootNodeId = NodeId.make("node:run-execution-settings-failure");
      const checkpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:run-execution-settings-failure"),
      } as OrchestrationV2CheckpointScope;
      const handoffInterruption = scenario.startsWith("handoff-interruption");
      const pendingHandoffs = yield* Ref.make<ReadonlyArray<OrchestrationV2ContextHandoff>>([]);
      const providerStarts = yield* Ref.make(0);
      const refreshes = yield* Ref.make(0);
      const guardedWrites = yield* Ref.make(0);
      const writes = yield* Ref.make<ReadonlyArray<ReadonlyArray<OrchestrationV2DomainEvent>>>([]);
      const testLayer = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () =>
                scenario === "start-guard" || handoffInterruption
                  ? Effect.void
                  : Effect.die("not reached"),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              writeIfRunCurrent: (input) =>
                Effect.gen(function* () {
                  assert.equal(input.threadId, threadId);
                  assert.equal(input.runId, runId);
                  assert.equal(input.activeAttemptId, attemptId);
                  assert.equal(input.expectedStatus, "running");
                  yield* Ref.update(guardedWrites, (count) => count + 1);
                  if (scenario === "stale-attempt") {
                    return { committed: false, storedEvents: [] };
                  }
                  yield* Ref.update(writes, (current) => [...current, input.events]);
                  return { committed: true, storedEvents: [] };
                }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: () => Effect.succeed([]),
            }),
            scenario === "start-guard" || handoffInterruption
              ? ServerSettings.layerTest()
              : Layer.mock(ServerSettings.ServerSettingsService)({
                  committedCustomModels: () => DEFAULT_SERVER_SETTINGS.customModels,
                  getSettings:
                    scenario === "interruption"
                      ? Effect.interrupt
                      : Effect.fail(
                          new ServerSettingsError({
                            settingsPath: "<test>",
                            operation: "read-file",
                            cause: new Error("settings read failed"),
                          }),
                        ),
                }),
            Layer.succeed(RunFinalizationService.RunFinalizationObserver, {
              refresh: () => Effect.void,
              refreshAfterTurn: () => Ref.update(refreshes, (count) => count + 1),
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make("command:run-execution-settings-failure"),
          appThread: { id: threadId } as OrchestrationV2AppThread,
          providerSessionId,
          session: {
            events: Stream.never,
            startTurn: () =>
              handoffInterruption
                ? deliverContextHandoffs({
                    handoffs: [
                      {
                        id: ContextHandoffId.make("handoff:interrupted-native-start"),
                        threadId,
                        targetRunId: runId,
                        fromProviderThreadIds: [],
                        toProviderThreadId: providerThreadId,
                        coveredRunOrdinals: { from: 1, to: 1 },
                        strategy: "full_thread_summary",
                        status: "ready",
                        summaryMessageId: null,
                        summaryText: "Preserve inherited scientific context.",
                        createdByProviderInstanceId: null,
                        createdAt: DateTime.makeUnsafe("2026-10-04T00:00:00Z"),
                        updatedAt: DateTime.makeUnsafe("2026-10-04T00:00:00Z"),
                      },
                    ],
                    providerThread: {
                      id: providerThreadId,
                      nativeThreadRef: {
                        driver,
                        strength: "strong",
                        nativeId: "native:interrupted-context",
                      },
                    } as OrchestrationV2ProviderThread,
                    budget: 16_000,
                    alreadyDeliveredItemIds: new Set(),
                    persist: (handoff) =>
                      Ref.update(pendingHandoffs, (all) => [...all, handoff]).pipe(
                        Effect.andThen(
                          scenario === "handoff-interruption-after-record"
                            ? Effect.interrupt
                            : Effect.void,
                        ),
                      ),
                    inject: () => Effect.interrupt,
                  }).pipe(Effect.andThen(Ref.update(providerStarts, (count) => count + 1)))
                : Ref.update(providerStarts, (count) => count + 1),
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            status: "running",
          } as OrchestrationV2Run,
          rootNode: { id: rootNodeId, status: "running" } as OrchestrationV2ExecutionNode,
          checkpointScope,
          providerThread: {
            id: providerThreadId,
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: {
            id: attemptId,
            providerTurnId: null,
            status: "running",
          } as OrchestrationV2RunAttempt,
          attemptId,
          providerTurnOrdinal: 1,
          // A declined start is a normal exit, not a preparation failure.
          ...(scenario === "start-guard"
            ? { shouldStartProviderTurn: () => Effect.succeed(false) }
            : {}),
          message: {
            messageId: MessageId.make("message:run-execution-settings-failure"),
            text: "Start after settings fail.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(testLayer), Effect.exit);

      assert.equal(yield* Ref.get(providerStarts), 0);
      const events = (yield* Ref.get(writes)).flat();
      if (scenario === "interruption" || handoffInterruption) {
        if (handoffInterruption) {
          const receipts = yield* Ref.get(pendingHandoffs);
          assert.lengthOf(receipts, 1);
          assert.equal(receipts[0]?.delivery?.status, "pending");
          assert.equal(receipts[0]?.delivery?.nativeThreadId, "native:interrupted-context");
        }
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result)) assert.isTrue(Cause.hasInterruptsOnly(result.cause));
        assert.equal(yield* Ref.get(guardedWrites), 0);
        assert.equal(yield* Ref.get(refreshes), 0);
        assert.isEmpty(events);
        return;
      }
      assert.isTrue(Exit.isSuccess(result));
      if (scenario === "start-guard") {
        assert.equal(yield* Ref.get(guardedWrites), 0);
        assert.equal(yield* Ref.get(refreshes), 0);
        assert.isEmpty(events);
        return;
      }
      assert.equal(yield* Ref.get(guardedWrites), 1);
      if (scenario === "stale-attempt") {
        assert.equal(yield* Ref.get(refreshes), 0);
        assert.isEmpty(events);
        return;
      }
      assert.equal(yield* Ref.get(refreshes), 1);
      assert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === "run.updated" ||
              event.type === "run-attempt.updated" ||
              event.type === "node.updated",
          )
          .map((event) => event.payload.status),
        ["failed", "failed", "failed"],
      );
      const errorItem = events.find(
        (event) => event.type === "turn-item.updated" && event.payload.type === "error",
      );
      assert.isDefined(errorItem);
      if (errorItem?.type === "turn-item.updated" && errorItem.payload.type === "error") {
        // The persisted item carries a bounded curated message; the exact
        // underlying text stays in the logged cause.
        assert.equal(errorItem.payload.failure.message, "Run preparation failed.");
      }
    }),
  );
}

it.effect("keeps ingesting owned child events after the root turn terminalizes", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:run-execution-late-child");
    const childThreadId = ThreadId.make("thread:run-execution-late-child:child");
    const runId = RunId.make("run:run-execution-late-child");
    const attemptId = RunAttemptId.make("attempt:run-execution-late-child");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-late-child");
    const providerThreadId = ProviderThreadId.make("provider-thread:run-execution-late-child");
    const childProviderThreadId = ProviderThreadId.make(
      "provider-thread:run-execution-late-child:child",
    );
    const rootProviderTurnId = ProviderTurnId.make("provider-turn:run-execution-late-child");
    const childProviderTurnId = ProviderTurnId.make("provider-turn:run-execution-late-child:child");
    const rootNodeId = NodeId.make("node:run-execution-late-child");
    const childNodeId = NodeId.make("node:run-execution-late-child:child");
    const subagentNodeId = NodeId.make("node:run-execution-late-child:subagent");
    const childMessageIngested = yield* Deferred.make<void>();
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const testLayer = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSink.EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.gen(function* () {
                if (
                  input.events.some(
                    (event) => event.type === "run.updated" && event.runId === runId,
                  )
                ) {
                  yield* Ref.update(order, (current) => [...current, "root-finalized"]);
                }
                return [];
              }),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: (input) =>
              Effect.gen(function* () {
                if (
                  input.event.type === "message.updated" &&
                  input.event.message.threadId === childThreadId
                ) {
                  yield* Ref.update(order, (current) => [...current, "child-message"]);
                  yield* Deferred.succeed(childMessageIngested, undefined).pipe(Effect.ignore);
                }
                return [];
              }),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );
    const events: ReadonlyArray<ProviderAdapterV2Event> = [
      {
        type: "app_thread.created",
        driver,
        appThread: {
          id: childThreadId,
          lineage: {
            parentThreadId: threadId,
            relationshipToParent: "subagent",
            rootThreadId: threadId,
          },
        },
      } as ProviderAdapterV2Event,
      {
        type: "provider_thread.updated",
        driver,
        providerThread: {
          id: childProviderThreadId,
          appThreadId: childThreadId,
        },
      } as ProviderAdapterV2Event,
      {
        type: "subagent.updated",
        driver,
        subagent: {
          id: subagentNodeId,
          threadId,
          runId,
          status: "running",
        },
      } as ProviderAdapterV2Event,
      {
        type: "provider_turn.updated",
        driver,
        threadId: childThreadId,
        providerTurn: {
          id: childProviderTurnId,
          providerThreadId: childProviderThreadId,
          nodeId: childNodeId,
          runAttemptId: null,
          status: "running",
        },
      } as ProviderAdapterV2Event,
      {
        type: "turn.terminal",
        driver,
        providerThreadId,
        providerTurnId: rootProviderTurnId,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      },
      {
        type: "message.updated",
        driver,
        message: {
          id: MessageId.make("message:run-execution-late-child:child"),
          threadId: childThreadId,
          runId: null,
          nodeId: childNodeId,
          role: "assistant",
          text: "Hello.",
          streaming: false,
        },
      } as ProviderAdapterV2Event,
      {
        type: "provider_turn.updated",
        driver,
        threadId: childThreadId,
        providerTurn: {
          id: childProviderTurnId,
          providerThreadId: childProviderThreadId,
          nodeId: childNodeId,
          runAttemptId: null,
          status: "completed",
        },
      } as ProviderAdapterV2Event,
      {
        type: "subagent.updated",
        driver,
        subagent: {
          id: subagentNodeId,
          threadId,
          runId,
          status: "completed",
        },
      } as ProviderAdapterV2Event,
    ];

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-late-child"),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId,
        session: {
          events: Stream.fromIterable(events),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make("checkpoint-scope:run-execution-late-child"),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: attemptId,
          providerTurnId: rootProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make("message:run-execution-late-child:user"),
          text: "Spawn a child and finish.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(testLayer));

    const observed = yield* Deferred.await(childMessageIngested).pipe(
      Effect.timeoutOption("2 seconds"),
    );
    assert.isTrue(Option.isSome(observed), "child message was not ingested after root terminal");
    assert.deepEqual(yield* Ref.get(order), ["root-finalized", "child-message"]);
  }),
);

it.effect.each([false, true])(
  "cleans workflow nodes after terminal-row races without touching transferred ownership (transfer=%s)",
  (transfer) =>
    Effect.gen(function* () {
      const finalization = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const memberId = NodeId.make(`workflow-race-member:${transfer}`);
      const observed = yield* runBackgroundItemScenario(
        `workflow-race:${transfer}`,
        (ids) => {
          const base = makeRunOwnedSubagentFixture({
            ids,
            providerInstanceId: ProviderInstanceId.make("codex"),
            childThreadId: ids.childThreadId,
            driver,
            status: "running",
          });
          const coordinator = { ...base, presentation: { kind: "workflow" as const } };
          const member: OrchestrationV2Subagent = {
            ...base,
            id: memberId,
            runId: null,
            parentNodeId: coordinator.id,
            childThreadId: null,
            nativeTaskRef: null,
            presentation: { kind: "workflow_agent", workflowId: coordinator.id },
          };
          const memberNode: OrchestrationV2ExecutionNode = {
            ...makeRunOwnedSubagentNodeFixture({ ids, status: "running" }),
            id: memberId,
            runId: null,
            parentNodeId: coordinator.id,
            rootNodeId: coordinator.id,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
          };
          return [
            { type: "subagent.updated", driver, subagent: coordinator },
            { type: "subagent.updated", driver, subagent: member },
            { type: "node.updated", driver, node: memberNode },
            transfer
              ? {
                  type: "subagent.updated",
                  driver,
                  subagent: { ...coordinator, runId: RunId.make("later-owner") },
                }
              : {
                  type: "subagent.updated",
                  driver,
                  subagent: { ...member, status: "completed", completedAt: base.startedAt },
                },
            rootTerminalEvent(ids, "interrupted"),
          ];
        },
        {
          onFinalization: (events) =>
            Ref.update(finalization, (current) => [...current, ...events]),
        },
      );
      const events = yield* Ref.get(finalization);
      const memberNodes = events.filter(
        (event) => event.type === "node.updated" && event.payload.id === memberId,
      );
      assert.equal(memberNodes.length, transfer ? 0 : 1);
      if (!transfer) {
        assert.equal(
          memberNodes[0]?.type === "node.updated" ? memberNodes[0].payload.status : null,
          "interrupted",
        );
        assert.include(observed, "subagent:completed");
      } else {
        assert.deepEqual(
          events
            .filter((event) => event.type === "subagent.updated")
            .map((event) => (event.type === "subagent.updated" ? event.payload.id : null)),
          [],
        );
      }
    }),
);

it.effect(
  "releases the old workflow subscriber after a coordinator transfers to a live owner",
  () =>
    Effect.gen(function* () {
      const observed = yield* runBackgroundItemScenario(
        "workflow-transfer-release",
        (ids) => {
          const coordinator: OrchestrationV2Subagent = {
            ...makeRunOwnedSubagentFixture({
              ids,
              providerInstanceId: ProviderInstanceId.make("codex"),
              childThreadId: ids.childThreadId,
              driver,
              status: "running",
            }),
            presentation: { kind: "workflow" },
          };
          const item = makeRunOwnedSubagentTurnItemFixture({
            ids,
            providerInstanceId: ProviderInstanceId.make("codex"),
            childThreadId: ids.childThreadId,
            driver,
            status: "running",
          });
          const later = { ...coordinator, runId: RunId.make("live-later-owner") };
          const nextIdentity: RunExecutionService.ProviderEventRouteIdentity = {
            driver,
            providerInstanceId: ProviderInstanceId.make("codex"),
            threadId: ids.threadId,
            runId: later.runId,
            attemptId: RunAttemptId.make("live-later-attempt"),
            providerThreadId: ids.providerThreadId,
          };
          const [accepted, laterRouting] = RunExecutionService.routeProviderEvent(
            { type: "subagent.updated", driver, subagent: later },
            nextIdentity,
            RunExecutionService.makeProviderEventRoutingState({
              identity: nextIdentity,
              providerTurnId: null,
            }),
          );
          assert.isTrue(accepted);
          assert.equal(laterRouting.workflowCoordinators.get(coordinator.id)?.status, "running");
          return [
            { type: "subagent.updated", driver, subagent: coordinator },
            { type: "turn_item.updated", driver, turnItem: item },
            rootTerminalEvent(ids, "completed"),
            { type: "subagent.updated", driver, subagent: later },
          ];
        },
        { keepEventStreamOpen: true },
      );
      assert.deepEqual(observed, ["subagent:running", "turn_item:running", "root-finalized"]);
    }),
);

it.effect("keeps ingesting a late background command item completion after root terminal", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("bg-command", (ids) => [
      backgroundTurnItemEvent(ids, "command_execution", "running", 1),
      rootTerminalEvent(ids, "completed"),
      backgroundTurnItemEvent(ids, "command_execution", "completed", 2),
    ]);
    assert.deepEqual(observed, ["turn_item:running", "root-finalized", "turn_item:completed"]);
  }),
);

it.effect("ingests the trailing subagent item completion after the subagent row completes", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("subagent-trailing-item", (ids) => [
      subagentEvent(ids, "running"),
      backgroundTurnItemEvent(ids, "subagent", "running", 1),
      rootTerminalEvent(ids, "completed"),
      subagentEvent(ids, "completed"),
      backgroundTurnItemEvent(ids, "subagent", "completed", 2),
    ]);
    assert.deepEqual(observed, [
      "subagent:running",
      "turn_item:running",
      "root-finalized",
      "subagent:completed",
      "turn_item:completed",
    ]);
  }),
);

it.effect("keeps ingesting a child thread's late background item completion", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("bg-child-item", (ids) => [
      childThreadCreatedEvent(ids),
      subagentEvent(ids, "running"),
      childBackgroundTurnItemEvent(ids, "running", 1),
      rootTerminalEvent(ids, "completed"),
      subagentEvent(ids, "completed"),
      childBackgroundTurnItemEvent(ids, "completed", 2),
    ]);
    assert.deepEqual(observed, [
      "subagent:running",
      "turn_item:running",
      "root-finalized",
      "subagent:completed",
      "turn_item:completed",
    ]);
  }),
);

it.effect("keeps ingesting until the last of several background items terminalizes", () =>
  Effect.gen(function* () {
    const secondItemId = TurnItemId.make("turn-item:bg-multi:second");
    const observed = yield* runBackgroundItemScenario("bg-multi", (ids) => [
      backgroundTurnItemEvent(ids, "command_execution", "running", 1),
      backgroundTurnItemEvent(ids, "dynamic_tool", "running", 2, secondItemId),
      rootTerminalEvent(ids, "completed"),
      backgroundTurnItemEvent(ids, "command_execution", "completed", 3),
      backgroundTurnItemEvent(ids, "dynamic_tool", "completed", 4, secondItemId),
    ]);
    assert.deepEqual(observed, [
      "turn_item:running",
      "turn_item:running",
      "root-finalized",
      "turn_item:completed",
      "turn_item:completed",
    ]);
  }),
);

it.effect("does not pin ingestion on background items when the root turn is interrupted", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("bg-interrupted", (ids) => [
      backgroundTurnItemEvent(ids, "command_execution", "running", 1),
      rootTerminalEvent(ids, "interrupted"),
      backgroundTurnItemEvent(ids, "command_execution", "completed", 2),
    ]);
    assert.deepEqual(observed, ["turn_item:running", "root-finalized"]);
  }),
);

it.effect("seeds inherited background items before their next update", () =>
  Effect.gen(function* () {
    const key = "inherited-background-seeded";
    const priorRunId = RunId.make(`run:${key}:prior`);
    const observed = yield* runBackgroundItemScenario(
      key,
      (ids) => [
        rootTerminalEvent(ids, "completed"),
        backgroundTurnItemEventForRun(ids, priorRunId, "subagent", "completed", 1),
      ],
      {
        loadInheritedBackgroundTurnItems: () =>
          Effect.succeed([{ id: TurnItemId.make(`turn-item:${key}`), runId: priorRunId }]),
      },
    );

    assert.deepEqual(observed, ["root-finalized", "turn_item:completed"]);
  }),
);

it.effect("releases the live run after an inherited background item terminalizes", () =>
  Effect.gen(function* () {
    const key = "inherited-background-terminal";
    const priorRunId = RunId.make(`run:${key}:prior`);
    const observed = yield* runBackgroundItemScenario(
      key,
      (ids) => [
        backgroundTurnItemEventForRun(ids, priorRunId, "subagent", "running", 1),
        rootTerminalEvent(ids, "completed"),
        backgroundTurnItemEventForRun(ids, priorRunId, "subagent", "completed", 2),
      ],
      {
        loadInheritedBackgroundTurnItems: () =>
          Effect.succeed([{ id: TurnItemId.make(`turn-item:${key}`), runId: priorRunId }]),
      },
    );

    assert.deepEqual(observed, ["turn_item:running", "root-finalized", "turn_item:completed"]);
  }),
);

it.effect("does not hold the live stream open for a foreign provider's background item", () =>
  Effect.gen(function* () {
    const key = "inherited-background-foreign-provider";
    const ids = backgroundScenarioIds(key);
    const priorRunId = RunId.make(`run:${key}:prior`);
    const foreignProviderThreadId = ProviderThreadId.make(`provider-thread:${key}:foreign-session`);
    const foreignItem = {
      id: ids.itemId,
      threadId: ids.threadId,
      runId: priorRunId,
      providerThreadId: foreignProviderThreadId,
      type: "subagent",
      status: "running",
    } as OrchestrationV2TurnItem;
    const inherited = RunExecutionService.selectInheritedBackgroundTurnItems({
      threadId: ids.threadId,
      currentProviderThreadId: ids.providerThreadId,
      currentRunOrdinal: 2,
      runs: [
        {
          id: priorRunId,
          threadId: ids.threadId,
          ordinal: 1,
          status: "interrupted",
        } as OrchestrationV2Run,
      ],
      turnItems: [foreignItem],
    });

    const observed = yield* runBackgroundItemScenario(
      key,
      (scenarioIds) => [rootTerminalEvent(scenarioIds, "completed")],
      {
        keepEventStreamOpen: true,
        loadInheritedBackgroundTurnItems: () => Effect.succeed(inherited),
      },
    );

    assert.deepEqual(inherited, []);
    assert.deepEqual(observed, ["root-finalized"]);
  }),
);

it.effect("refreshes inherited background items after event subscription", () =>
  Effect.gen(function* () {
    const key = "inherited-background-subscription-refresh";
    const ids = backgroundScenarioIds(key);
    const priorRunId = RunId.make(`run:${key}:prior`);
    const itemStatus = yield* Ref.make<OrchestrationV2TurnItem["status"]>("running");
    const loadInheritedBackgroundTurnItems = () =>
      Ref.get(itemStatus).pipe(
        Effect.map((status) =>
          RunExecutionService.selectInheritedBackgroundTurnItems({
            threadId: ids.threadId,
            currentProviderThreadId: ids.providerThreadId,
            currentRunOrdinal: 2,
            runs: [
              {
                id: priorRunId,
                threadId: ids.threadId,
                ordinal: 1,
                status: "interrupted",
              } as OrchestrationV2Run,
            ],
            turnItems: [
              {
                id: ids.itemId,
                threadId: ids.threadId,
                runId: priorRunId,
                providerThreadId: ids.providerThreadId,
                type: "subagent",
                status,
              } as OrchestrationV2TurnItem,
            ],
          }),
        ),
      );

    const observed = yield* runBackgroundItemScenario(
      key,
      (scenarioIds) => [rootTerminalEvent(scenarioIds, "completed")],
      {
        keepEventStreamOpen: true,
        loadInheritedBackgroundTurnItems,
        onSubscribe: Ref.set(itemStatus, "completed"),
      },
    );

    assert.deepEqual(yield* loadInheritedBackgroundTurnItems(), []);
    assert.deepEqual(observed, ["root-finalized"]);
  }),
);

it.effect(
  "keeps ingesting a late empty provider-thread roster while thread-scoped pending work is true",
  () =>
    Effect.gen(function* () {
      const key = "bg-roster-pending-work";
      const ids = backgroundScenarioIds(key);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const now = yield* DateTime.now;
      const observed = yield* Ref.make<ReadonlyArray<string>>([]);
      const pendingByProviderThreadId = yield* Ref.make(new Map([[ids.providerThreadId, true]]));
      const scopedProbeArgs = yield* Ref.make<ReadonlyArray<ProviderThreadId>>([]);
      const ingestCalls = yield* Ref.make<
        ReadonlyArray<{
          readonly activeAttemptId: RunAttemptId | null;
          readonly eventType: string;
          readonly hasWriteIfRunCurrent: boolean;
          readonly hasWriteIfProviderThreadOwner: boolean;
          readonly expectedLastRunOrdinal: number | null;
          readonly runId: RunId | null;
          readonly rosterLength: number | null;
        }>
      >([]);
      const ingestionDone = yield* Deferred.make<void>();
      const testLayer = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  if (
                    input.events.some(
                      (event) => event.type === "run.updated" && event.runId === ids.runId,
                    )
                  ) {
                    yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                  }
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
              writeIfProviderThreadOwner: () =>
                Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: (input) =>
                Effect.gen(function* () {
                  const event = input.event;
                  const rosterLength =
                    event.type === "provider_thread.updated"
                      ? (event.providerThread.pendingBackgroundTasks?.length ?? 0)
                      : null;
                  yield* Ref.update(ingestCalls, (current) => [
                    ...current,
                    {
                      activeAttemptId: input.writeIfProviderThreadOwner?.activeAttemptId ?? null,
                      eventType: event.type,
                      hasWriteIfRunCurrent: input.writeIfRunCurrent !== undefined,
                      hasWriteIfProviderThreadOwner: input.writeIfProviderThreadOwner !== undefined,
                      expectedLastRunOrdinal:
                        input.writeIfProviderThreadOwner?.expectedLastRunOrdinal ?? null,
                      runId: input.writeIfProviderThreadOwner?.runId ?? null,
                      rosterLength,
                    },
                  ]);
                  if (event.type === "provider_thread.updated" && rosterLength === 0) {
                    yield* Ref.update(pendingByProviderThreadId, (current) => {
                      const next = new Map(current);
                      next.set(event.providerThread.id, false);
                      return next;
                    });
                    yield* Ref.update(observed, (current) => [...current, "roster-cleared"]);
                  }
                  if (event.type === "turn.terminal") {
                    yield* Ref.update(observed, (current) => [...current, "terminal"]);
                  }
                  return [];
                }),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      );

      const providerThreadBase = {
        id: ids.providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        appThreadId: ids.threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:${key}`),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:${key}`),
          session: {
            events: Stream.empty,
            // Session-wide stays true forever; the root must consult the
            // thread-scoped probe instead of being pinned by siblings.
            hasPendingBackgroundWork: Effect.succeed(true),
            hasPendingBackgroundWorkForThread: (providerThread: OrchestrationV2ProviderThread) =>
              Effect.gen(function* () {
                yield* Ref.update(scopedProbeArgs, (current) => [...current, providerThread.id]);
                return (yield* Ref.get(pendingByProviderThreadId)).get(providerThread.id) === true;
              }),
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...providerThreadBase,
                    status: "active" as const,
                    pendingBackgroundTasks: [
                      { taskId: "bg-1", description: "sleep 20", kind: "command" },
                    ],
                    updatedAt: now,
                  },
                } as ProviderAdapterV2Event,
                rootTerminalEvent(ids, "completed"),
                {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...providerThreadBase,
                    status: "idle" as const,
                    pendingBackgroundTasks: [],
                    updatedAt: now,
                  },
                } as ProviderAdapterV2Event,
              ]),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
          } as OrchestrationV2CheckpointScope,
          providerThread: providerThreadBase as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make(`message:${key}:user`),
            text: "Start background work and settle.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(testLayer));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(Option.isSome(closed), "event subscription did not release");
      assert.deepEqual(yield* Ref.get(observed), ["terminal", "root-finalized", "roster-cleared"]);
      assert.isTrue((yield* Ref.get(scopedProbeArgs)).includes(ids.providerThreadId));

      const calls = yield* Ref.get(ingestCalls);
      const preTerminalRoster = calls.find(
        (call) => call.eventType === "provider_thread.updated" && call.rosterLength === 1,
      );
      const lateClear = calls.find(
        (call) => call.eventType === "provider_thread.updated" && call.rosterLength === 0,
      );
      assert.isDefined(preTerminalRoster);
      assert.isTrue(preTerminalRoster?.hasWriteIfRunCurrent);
      assert.isFalse(preTerminalRoster?.hasWriteIfProviderThreadOwner);
      assert.isDefined(lateClear);
      assert.isFalse(
        lateClear?.hasWriteIfRunCurrent,
        "late empty roster must not use stale writeIfRunCurrent running-gate",
      );
      assert.isTrue(
        lateClear?.hasWriteIfProviderThreadOwner,
        "late empty roster must gate on provider-thread ownership",
      );
      assert.equal(lateClear?.expectedLastRunOrdinal, 1);
      assert.equal(lateClear?.runId, ids.runId);
      assert.equal(lateClear?.activeAttemptId, ids.attemptId);
    }),
);

it.effect("drops late root provider-thread writes from a superseded attempt", () =>
  Effect.gen(function* () {
    const key = "bg-roster-attempt-owner-lost";
    const ids = backgroundScenarioIds(key);
    const replacementAttemptId = RunAttemptId.make(`attempt:${key}:replacement`);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const now = yield* DateTime.now;
    const observed = yield* Ref.make<ReadonlyArray<string>>([]);
    // Probe stays true forever so only ownership-loss can release the stream.
    const ingestionDone = yield* Deferred.make<void>();
    const ingestCalls = yield* Ref.make<
      ReadonlyArray<{
        readonly activeAttemptId: RunAttemptId | null;
        readonly eventType: string;
        readonly hasWriteIfProviderThreadOwner: boolean;
        readonly expectedLastRunOrdinal: number | null;
        readonly rosterLength: number | null;
        readonly committed: boolean;
      }>
    >([]);
    const testLayer = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSink.EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.gen(function* () {
                if (
                  input.events.some(
                    (event) => event.type === "run.updated" && event.runId === ids.runId,
                  )
                ) {
                  yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                }
                return [];
              }),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            writeIfProviderThreadOwner: () =>
              Effect.succeed({ committed: false, storedEvents: [] }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: (input) =>
              Effect.gen(function* () {
                const event = input.event;
                const rosterLength =
                  event.type === "provider_thread.updated"
                    ? (event.providerThread.pendingBackgroundTasks?.length ?? 0)
                    : null;
                const ownerGate = input.writeIfProviderThreadOwner;
                // Simulate the EventSink reject after a same-run replacement
                // changes activeAttemptId without advancing lastRunOrdinal.
                const rejectAsStaleOwner =
                  ownerGate !== undefined && ownerGate.activeAttemptId !== replacementAttemptId;
                yield* Ref.update(ingestCalls, (current) => [
                  ...current,
                  {
                    activeAttemptId: ownerGate?.activeAttemptId ?? null,
                    eventType: event.type,
                    hasWriteIfProviderThreadOwner: ownerGate !== undefined,
                    expectedLastRunOrdinal: ownerGate?.expectedLastRunOrdinal ?? null,
                    rosterLength,
                    committed: !rejectAsStaleOwner,
                  },
                ]);
                if (event.type === "turn.terminal") {
                  yield* Ref.update(observed, (current) => [...current, "terminal"]);
                }
                if (event.type === "provider_thread.updated" && rejectAsStaleOwner) {
                  yield* Ref.update(observed, (current) => [...current, "stale-owner-rejected"]);
                  return [];
                }
                if (event.type === "provider_thread.updated") {
                  yield* Ref.update(observed, (current) => [...current, "roster-written"]);
                }
                return [];
              }),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );

    const providerThreadBase = {
      id: ids.providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId: ProviderSessionId.make(`session:${key}`),
      appThreadId: ids.threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle" as const,
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:${key}`),
        appThread: { id: ids.threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        session: {
          events: Stream.empty,
          hasPendingBackgroundWork: Effect.succeed(true),
          hasPendingBackgroundWorkForThread: () => Effect.succeed(true),
          subscribeEvents: Effect.succeed({
            events: Stream.fromIterable([
              {
                type: "provider_thread.updated",
                driver,
                providerThread: {
                  ...providerThreadBase,
                  status: "active" as const,
                  pendingBackgroundTasks: [
                    { taskId: "bg-stale", description: "sleep 20", kind: "command" },
                  ],
                  updatedAt: now,
                },
              } as ProviderAdapterV2Event,
              rootTerminalEvent(ids, "completed"),
              // Late snapshot after a replacement attempt claimed the same
              // run ordinal. Without attempt gating this would clobber it.
              {
                type: "provider_thread.updated",
                driver,
                providerThread: {
                  ...providerThreadBase,
                  status: "idle" as const,
                  lastRunOrdinal: 1,
                  pendingBackgroundTasks: [
                    { taskId: "bg-stale", description: "sleep 20", kind: "command" },
                  ],
                  updatedAt: now,
                },
              } as ProviderAdapterV2Event,
            ]),
            close: Deferred.succeed(ingestionDone, undefined),
          }),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: {
          id: ids.runId,
          threadId: ids.threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
        } as OrchestrationV2CheckpointScope,
        providerThread: providerThreadBase as OrchestrationV2ProviderThread,
        attempt: {
          id: ids.attemptId,
          providerTurnId: ids.rootProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId: ids.attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make(`message:${key}:user`),
          text: "Background work that loses ownership.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(testLayer));

    const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
    assert.isTrue(
      Option.isSome(closed),
      "subscription must release after ownership-loss reject even when probe stays true",
    );
    assert.deepEqual(yield* Ref.get(observed), [
      "roster-written",
      "terminal",
      "root-finalized",
      "stale-owner-rejected",
    ]);

    const calls = yield* Ref.get(ingestCalls);
    const lateStale = calls.find(
      (call) =>
        call.eventType === "provider_thread.updated" &&
        call.hasWriteIfProviderThreadOwner &&
        call.rosterLength === 1,
    );
    assert.isDefined(lateStale);
    assert.equal(lateStale?.expectedLastRunOrdinal, 1);
    assert.equal(lateStale?.activeAttemptId, ids.attemptId);
    assert.isFalse(lateStale?.committed);
  }),
);

it.effect(
  "keeps ingesting a late background turn-item completion after ownership-loss rejects roster writes",
  () =>
    Effect.gen(function* () {
      const key = "bg-item-after-owner-lost";
      const ids = backgroundScenarioIds(key);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const now = yield* DateTime.now;
      const observed = yield* Ref.make<ReadonlyArray<string>>([]);
      // Probe stays true forever; open background items must pin the stream
      // past ownership-loss so late turn_item completions still land.
      const ingestionDone = yield* Deferred.make<void>();
      const testLayer = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  if (
                    input.events.some(
                      (event) => event.type === "run.updated" && event.runId === ids.runId,
                    )
                  ) {
                    yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                  }
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
              writeIfProviderThreadOwner: () =>
                Effect.succeed({ committed: false, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: (input) =>
                Effect.gen(function* () {
                  const event = input.event;
                  if (event.type === "turn.terminal") {
                    yield* Ref.update(observed, (current) => [...current, "terminal"]);
                  }
                  if (
                    event.type === "provider_thread.updated" &&
                    input.writeIfProviderThreadOwner !== undefined
                  ) {
                    yield* Ref.update(observed, (current) => [...current, "stale-owner-rejected"]);
                    return [];
                  }
                  if (event.type === "turn_item.updated") {
                    yield* Ref.update(observed, (current) => [
                      ...current,
                      `turn_item:${event.turnItem.status}`,
                    ]);
                  }
                  return [];
                }),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      );

      const providerThreadBase = {
        id: ids.providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        appThreadId: ids.threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:${key}`),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:${key}`),
          session: {
            events: Stream.empty,
            hasPendingBackgroundWork: Effect.succeed(true),
            hasPendingBackgroundWorkForThread: () => Effect.succeed(true),
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                backgroundTurnItemEvent(ids, "command_execution", "running", 1),
                rootTerminalEvent(ids, "completed"),
                // Ownership reject after a newer run claimed lastRunOrdinal.
                {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...providerThreadBase,
                    status: "idle" as const,
                    lastRunOrdinal: 1,
                    pendingBackgroundTasks: [
                      { taskId: "bg-stale", description: "sleep 20", kind: "command" },
                    ],
                    updatedAt: now,
                  },
                } as ProviderAdapterV2Event,
                // Late completion still writable (turn_item writes are not
                // ownership-gated); stream must stay open for it.
                backgroundTurnItemEvent(ids, "command_execution", "completed", 2),
              ]),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
          } as OrchestrationV2CheckpointScope,
          providerThread: providerThreadBase as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make(`message:${key}:user`),
            text: "Background item after ownership loss.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(testLayer));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(
        Option.isSome(closed),
        "subscription must release after background item completes past ownership loss",
      );
      assert.deepEqual(yield* Ref.get(observed), [
        "turn_item:running",
        "terminal",
        "root-finalized",
        "stale-owner-rejected",
        "turn_item:completed",
      ]);
    }),
);

it.effect(
  "does not pin ingestion on a sibling session-wide pending state when this thread has no roster",
  () =>
    Effect.gen(function* () {
      const key = "bg-roster-sibling-not-pin";
      const ids = backgroundScenarioIds(key);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const now = yield* DateTime.now;
      const observed = yield* Ref.make<ReadonlyArray<string>>([]);
      const ingestionDone = yield* Deferred.make<void>();
      const scopedProbeArgs = yield* Ref.make<ReadonlyArray<ProviderThreadId>>([]);
      const testLayer = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  if (
                    input.events.some(
                      (event) => event.type === "run.updated" && event.runId === ids.runId,
                    )
                  ) {
                    yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                  }
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: (input) =>
                Effect.gen(function* () {
                  if (input.event.type === "turn.terminal") {
                    yield* Ref.update(observed, (current) => [...current, "terminal"]);
                  }
                  return [];
                }),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      );

      const providerThreadBase = {
        id: ids.providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        appThreadId: ids.threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-self",
          strength: "strong" as const,
        },
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const siblingProviderThreadId = ProviderThreadId.make(`provider-thread:${key}:sibling`);

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:${key}`),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:${key}`),
          session: {
            events: Stream.empty,
            // Session-wide stays true (sibling has work). Stop must use only
            // the scoped probe for this root's provider thread.
            hasPendingBackgroundWork: Effect.succeed(true),
            hasPendingBackgroundWorkForThread: (providerThread: OrchestrationV2ProviderThread) =>
              Effect.gen(function* () {
                yield* Ref.update(scopedProbeArgs, (current) => [...current, providerThread.id]);
                // Own thread has no roster; sibling would report true if probed.
                return providerThread.id !== ids.providerThreadId;
              }),
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                rootTerminalEvent(ids, "completed"),
                // Sibling thread update after terminal. Own-thread scoped
                // pending is false, so this root must release without waiting
                // for sibling-driven session-wide pending work.
                {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...providerThreadBase,
                    id: siblingProviderThreadId,
                    appThreadId: ThreadId.make(`thread:${key}:sibling`),
                    nativeThreadRef: {
                      driver,
                      nativeId: "native-sibling",
                      strength: "strong" as const,
                    },
                    pendingBackgroundTasks: [
                      { taskId: "sibling-bg", description: "other thread", kind: "command" },
                    ],
                    updatedAt: now,
                  },
                } as ProviderAdapterV2Event,
              ]),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
          } as OrchestrationV2CheckpointScope,
          providerThread: providerThreadBase as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make(`message:${key}:user`),
            text: "Settle without local pending work.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(testLayer));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(Option.isSome(closed), "event subscription did not release");
      // Critical: release while session-wide hasPendingBackgroundWork stays true
      // and the scoped probe reports false for this root's provider thread.
      const observedEvents = [...(yield* Ref.get(observed))];
      assert.includeMembers(observedEvents, ["terminal", "root-finalized"]);
      const probedIds = yield* Ref.get(scopedProbeArgs);
      assert.isTrue(probedIds.includes(ids.providerThreadId));
      assert.isFalse(probedIds.includes(siblingProviderThreadId));
    }),
);

it.effect(
  "cascade-terminalizes run-owned subagent rows on interrupt before root finalization",
  () =>
    Effect.gen(function* () {
      const ids = backgroundScenarioIds("subagent-interrupt-cascade");
      const childThreadId = ids.childThreadId;
      const unrelatedChildThreadId = ThreadId.make(
        "thread:subagent-interrupt-cascade:unrelated-child",
      );
      const providerInstanceId = ProviderInstanceId.make("codex");
      const written = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const ingested = yield* Ref.make<ReadonlyArray<ProviderAdapterV2Event>>([]);
      const ingestionDone = yield* Deferred.make<void>();
      const testLayer = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  yield* Ref.update(written, (current) => [...current, ...input.events]);
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: (input) =>
                Ref.update(ingested, (current) => [...current, input.event]).pipe(Effect.as([])),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      );

      const runningSubagent = makeRunOwnedSubagentFixture({
        ids,
        providerInstanceId,
        childThreadId,
        driver,
        status: "running",
      });
      const runningTurnItem = makeRunOwnedSubagentTurnItemFixture({
        ids,
        providerInstanceId,
        childThreadId,
        driver,
        status: "running",
      });
      const runningNode = makeRunOwnedSubagentNodeFixture({
        ids,
        status: "running",
      });
      const runningChildNode = makeRunOwnedSubagentChildNodeFixture({
        ids,
        status: "running",
      });
      const runningChildTurnItem = makeLinkedChildTurnItemFixture({
        ids,
        driver,
        type: "command_execution",
      });
      const suppressedChildAssistantTurnItem = makeLinkedChildTurnItemFixture({
        ids: {
          ...ids,
          childItemId: TurnItemId.make("turn-item:subagent-interrupt-cascade:suppressed-assistant"),
        },
        driver,
        type: "assistant_message",
      });
      const unrelatedChildNode = {
        ...runningChildNode,
        id: NodeId.make("node:subagent-interrupt-cascade:unrelated-child"),
        threadId: unrelatedChildThreadId,
        runId: ids.runId,
        rootNodeId: NodeId.make("node:subagent-interrupt-cascade:unrelated-child"),
      };
      const unrelatedChildTurnItem = {
        ...runningChildTurnItem,
        id: TurnItemId.make("turn-item:subagent-interrupt-cascade:unrelated-child"),
        threadId: unrelatedChildThreadId,
        nodeId: unrelatedChildNode.id,
      };

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make("command:subagent-interrupt-cascade"),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make("session:subagent-interrupt-cascade"),
          session: {
            events: Stream.empty,
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                childThreadCreatedEvent(ids),
                {
                  type: "subagent.updated",
                  driver,
                  subagent: runningSubagent,
                },
                {
                  type: "node.updated",
                  driver,
                  node: runningNode,
                },
                {
                  type: "node.updated",
                  driver,
                  node: runningChildNode,
                },
                {
                  type: "node.updated",
                  driver,
                  node: unrelatedChildNode,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: runningTurnItem,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: runningChildTurnItem,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: suppressedChildAssistantTurnItem,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: unrelatedChildTurnItem,
                },
                rootTerminalEvent(ids, "interrupted"),
                // Late provider completion after interrupt must not be ingested.
                {
                  type: "subagent.updated",
                  driver,
                  subagent: {
                    ...runningSubagent,
                    status: "completed" as const,
                    result: "should-not-apply",
                    completedAt: runningSubagent.updatedAt,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...runningTurnItem,
                    status: "completed" as const,
                    result: "should-not-apply",
                    completedAt: runningTurnItem.updatedAt,
                    updatedAt: runningTurnItem.updatedAt,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...runningChildTurnItem,
                    status: "completed" as const,
                    completedAt: runningChildTurnItem.updatedAt,
                    updatedAt: runningChildTurnItem.updatedAt,
                  },
                },
                {
                  type: "node.updated",
                  driver,
                  node: {
                    ...runningChildNode,
                    status: "completed" as const,
                    completedAt: runningChildNode.startedAt,
                  },
                },
              ] satisfies ReadonlyArray<ProviderAdapterV2Event>),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make("checkpoint-scope:subagent-interrupt-cascade"),
          } as OrchestrationV2CheckpointScope,
          providerThread: {
            id: ids.providerThreadId,
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          relatedThreadIds: [unrelatedChildThreadId],
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make("message:subagent-interrupt-cascade:user"),
            text: "Spawn a subagent then stop.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(testLayer));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(Option.isSome(closed), "event ingestion fiber did not finish");

      const events = yield* Ref.get(written);
      const subagentEvents = events.flatMap((event) =>
        event.type === "subagent.updated" ? [event] : [],
      );
      const turnItemEvents = events.flatMap((event) => {
        if (event.type !== "turn-item.updated" || event.payload.type !== "subagent") {
          return [];
        }
        return [
          {
            ...event,
            payload: event.payload,
          },
        ];
      });
      const nodeEvents = events.flatMap((event) =>
        event.type === "node.updated" &&
        event.payload.status === "interrupted" &&
        (event.payload.id === runningNode.id || event.payload.id === runningChildNode.id)
          ? [event]
          : [],
      );
      const runUpdatedIndex = events.findIndex((event) => event.type === "run.updated");
      assert.isAtLeast(runUpdatedIndex, 0, "root run.updated must be written");

      assert.lengthOf(subagentEvents, 1);
      const terminalSubagent = subagentEvents[0];
      assert.isDefined(terminalSubagent);
      assert.equal(terminalSubagent.payload.status, "interrupted");
      assert.equal(terminalSubagent.payload.childThreadId, childThreadId);
      assert.equal(terminalSubagent.payload.result, null);
      assert.isNotNull(terminalSubagent.payload.completedAt);

      assert.lengthOf(turnItemEvents, 1);
      const terminalTurnItem = turnItemEvents[0];
      assert.isDefined(terminalTurnItem);
      assert.equal(terminalTurnItem.payload.status, "interrupted");
      assert.equal(terminalTurnItem.payload.childThreadId, childThreadId);
      assert.equal(terminalTurnItem.payload.result, null);

      const terminalChildTurnItems = events.flatMap((event) =>
        event.type === "turn-item.updated" &&
        event.payload.id === runningChildTurnItem.id &&
        event.payload.status === "interrupted"
          ? [event]
          : [],
      );
      assert.lengthOf(terminalChildTurnItems, 1);
      const terminalChildTurnItem = terminalChildTurnItems[0];
      assert.isDefined(terminalChildTurnItem);
      assert.equal(terminalChildTurnItem.threadId, childThreadId);
      assert.equal(terminalChildTurnItem.payload.threadId, childThreadId);
      assert.equal(terminalChildTurnItem.payload.runId, null);
      assert.equal(terminalChildTurnItem.payload.type, "command_execution");
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === unrelatedChildTurnItem.id &&
            event.payload.status === "interrupted",
        ),
        "related but unlinked child turn items must not cascade",
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === suppressedChildAssistantTurnItem.id,
        ),
        "suppressed streaming child items must not be created by the cascade",
      );

      assert.lengthOf(nodeEvents, 2);
      assert.isTrue(
        nodeEvents.some(
          (event) => event.payload.id === runningNode.id && event.payload.kind === "subagent",
        ),
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "node.updated" &&
            event.payload.id === unrelatedChildNode.id &&
            event.payload.status === "interrupted",
        ),
        "owned child threads without a live run-owned subagent link must not cascade",
      );
      assert.isTrue(
        nodeEvents.some(
          (event) =>
            event.payload.id === runningChildNode.id &&
            event.runId === (runningChildNode.runId ?? ids.runId) &&
            event.payload.threadId === childThreadId &&
            event.payload.kind === "root_turn",
        ),
      );

      const cascadeIndexes = events.flatMap((event, index) => {
        if (event.type === "subagent.updated" && event.payload.status === "interrupted") {
          return [index];
        }
        if (
          event.type === "turn-item.updated" &&
          event.payload.status === "interrupted" &&
          (event.payload.type === "subagent" || event.payload.id === runningChildTurnItem.id)
        ) {
          return [index];
        }
        if (event.type === "node.updated" && event.payload.status === "interrupted") {
          return event.payload.id === runningNode.id || event.payload.id === runningChildNode.id
            ? [index]
            : [];
        }
        return [];
      });
      assert.isTrue(
        cascadeIndexes.every((index) => index < runUpdatedIndex),
        "subagent cascade must precede run.updated",
      );
      assert.isFalse(
        events.some((event) => {
          if (event.type === "subagent.updated") {
            return event.payload.status === "completed";
          }
          if (event.type === "turn-item.updated" && event.payload.type === "subagent") {
            return event.payload.status === "completed";
          }
          return false;
        }),
        "late provider completion must not reopen cascaded subagent rows",
      );
      assert.isFalse(
        (yield* Ref.get(ingested)).some(
          (event) =>
            (event.type === "subagent.updated" && event.subagent.status === "completed") ||
            (event.type === "turn_item.updated" && event.turnItem.status === "completed") ||
            (event.type === "node.updated" && event.node.status === "completed"),
        ),
        "late provider completion must not be ingested after interrupt",
      );
    }),
);

it.effect(
  "cascades linked child-thread nodes after run-owned subagent and turn-item terminalize",
  () =>
    Effect.gen(function* () {
      const ids = backgroundScenarioIds("subagent-link-survives-terminal");
      const childThreadId = ids.childThreadId;
      const unrelatedChildThreadId = ThreadId.make(
        "thread:subagent-link-survives-terminal:unrelated-child",
      );
      const providerInstanceId = ProviderInstanceId.make("codex");
      const written = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const ingestionDone = yield* Deferred.make<void>();
      const testLayer = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  yield* Ref.update(written, (current) => [...current, ...input.events]);
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: () => Effect.succeed([]),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      );

      const runningSubagent = makeRunOwnedSubagentFixture({
        ids,
        providerInstanceId,
        childThreadId,
        driver,
        status: "running",
      });
      const runningTurnItem = makeRunOwnedSubagentTurnItemFixture({
        ids,
        providerInstanceId,
        childThreadId,
        driver,
        status: "running",
      });
      const runningNode = makeRunOwnedSubagentNodeFixture({
        ids,
        status: "running",
      });
      const runningChildNode = makeRunOwnedSubagentChildNodeFixture({
        ids,
        status: "running",
      });
      const unrelatedChildNode = {
        ...runningChildNode,
        id: NodeId.make("node:subagent-link-survives-terminal:unrelated-child"),
        threadId: unrelatedChildThreadId,
        runId: ids.runId,
        rootNodeId: NodeId.make("node:subagent-link-survives-terminal:unrelated-child"),
      };
      const completedAt = runningSubagent.updatedAt;

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make("command:subagent-link-survives-terminal"),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make("session:subagent-link-survives-terminal"),
          session: {
            events: Stream.empty,
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                childThreadCreatedEvent(ids),
                {
                  type: "subagent.updated",
                  driver,
                  subagent: runningSubagent,
                },
                {
                  type: "node.updated",
                  driver,
                  node: runningNode,
                },
                {
                  type: "node.updated",
                  driver,
                  node: runningChildNode,
                },
                {
                  type: "node.updated",
                  driver,
                  node: unrelatedChildNode,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: runningTurnItem,
                },
                // Subagent + turn-item settle before root interrupt; linkage
                // must still prove the open child-thread node is cascadeable.
                {
                  type: "subagent.updated",
                  driver,
                  subagent: {
                    ...runningSubagent,
                    status: "completed" as const,
                    result: "subagent finished first",
                    completedAt,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...runningTurnItem,
                    status: "completed" as const,
                    result: "turn item finished first",
                    completedAt,
                    updatedAt: completedAt,
                  },
                },
                {
                  type: "node.updated",
                  driver,
                  node: {
                    ...runningNode,
                    status: "completed" as const,
                    completedAt,
                  },
                },
                rootTerminalEvent(ids, "interrupted"),
              ] satisfies ReadonlyArray<ProviderAdapterV2Event>),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make("checkpoint-scope:subagent-link-survives-terminal"),
          } as OrchestrationV2CheckpointScope,
          providerThread: {
            id: ids.providerThreadId,
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          relatedThreadIds: [unrelatedChildThreadId],
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make("message:subagent-link-survives-terminal:user"),
            text: "Subagent settles before root interrupt.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(testLayer));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(Option.isSome(closed), "event ingestion fiber did not finish");

      const events = yield* Ref.get(written);
      const runUpdatedIndex = events.findIndex((event) => event.type === "run.updated");
      assert.isAtLeast(runUpdatedIndex, 0, "root run.updated must be written");

      const cascadedChildNodeEvents = events.flatMap((event, index) =>
        event.type === "node.updated" &&
        event.payload.id === runningChildNode.id &&
        event.payload.status === "interrupted"
          ? [{ event, index }]
          : [],
      );
      assert.lengthOf(
        cascadedChildNodeEvents,
        1,
        "open linked child-thread node must cascade after subagent/turn-item terminalize",
      );
      const cascadedChild = cascadedChildNodeEvents[0];
      assert.isDefined(cascadedChild);
      assert.isTrue(
        cascadedChild.index < runUpdatedIndex,
        "child-thread cascade must precede run.updated",
      );
      assert.equal(cascadedChild.event.payload.threadId, childThreadId);
      assert.equal(cascadedChild.event.payload.kind, "root_turn");
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "node.updated" &&
            event.payload.id === unrelatedChildNode.id &&
            event.payload.status === "interrupted",
        ),
        "related but unlinked child threads must not cascade",
      );
      assert.isFalse(
        events.some(
          (event) => event.type === "subagent.updated" && event.payload.status === "interrupted",
        ),
        "already-terminal subagent rows must not be re-cascaded",
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "subagent" &&
            event.payload.status === "interrupted",
        ),
        "already-terminal subagent turn items must not be re-cascaded",
      );
    }),
);

it.effect("cascade helper is provider-neutral for Claude and Codex-shaped child projections", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    let nextId = 0;
    const allocateEventId = () =>
      Effect.sync(() => EventId.make(`event:cascade-helper:${nextId++}`));

    for (const driverKind of [
      ProviderDriverKind.make("claudeAgent"),
      ProviderDriverKind.make("codex"),
    ] as const) {
      const runId = RunId.make(`run:cascade-helper:${driverKind}`);
      const threadId = ThreadId.make(`thread:cascade-helper:${driverKind}`);
      const childThreadId = ThreadId.make(`thread:cascade-helper:${driverKind}:child`);
      const subagentId = NodeId.make(`node:cascade-helper:${driverKind}:subagent`);
      const childNodeId = NodeId.make(`node:cascade-helper:${driverKind}:child-root`);
      const providerInstanceId = ProviderInstanceId.make(String(driverKind));
      const terminalStatus = driverKind === "claudeAgent" ? "failed" : "cancelled";
      const subagent: OrchestrationV2Subagent = {
        id: subagentId,
        threadId,
        runId,
        parentNodeId: NodeId.make(`node:cascade-helper:${driverKind}:root`),
        origin: "provider_native",
        createdBy: "agent",
        driver: driverKind,
        providerInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: {
          driver: driverKind,
          nativeId: `native-${driverKind}`,
          strength: "strong",
        },
        prompt: "hold",
        title: "hold",
        model: null,
        status: "running",
        progress: "partial progress",
        result: "partial result",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      const turnItem = {
        id: TurnItemId.make(`turn-item:cascade-helper:${driverKind}`),
        threadId,
        runId,
        nodeId: subagentId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: subagent.nativeTaskRef,
        parentItemId: null,
        ordinal: 3,
        status: "running" as const,
        title: "hold",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "subagent" as const,
        subagentId,
        origin: "provider_native" as const,
        driver: driverKind,
        providerInstanceId,
        childThreadId,
        prompt: "hold",
        progress: "partial progress",
        result: "partial result",
      } satisfies Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
      const node: OrchestrationV2ExecutionNode = {
        id: subagentId,
        threadId,
        runId,
        parentNodeId: NodeId.make(`node:cascade-helper:${driverKind}:root`),
        rootNodeId: NodeId.make(`node:cascade-helper:${driverKind}:root`),
        kind: "subagent",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: subagent.nativeTaskRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const openChildNode: OrchestrationV2ExecutionNode = {
        id: childNodeId,
        threadId: childThreadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: childNodeId,
        kind: "root_turn",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const childTurnItem: OrchestrationV2TurnItem =
        driverKind === "claudeAgent"
          ? {
              id: TurnItemId.make(`turn-item:cascade-helper:${driverKind}:child-reasoning`),
              threadId: childThreadId,
              runId: null,
              nodeId: childNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "running",
              title: "Working",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              type: "reasoning",
              text: "partial progress",
              streaming: true,
            }
          : {
              id: TurnItemId.make(`turn-item:cascade-helper:${driverKind}:child-command`),
              threadId: childThreadId,
              runId: null,
              nodeId: childNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "running",
              title: "sleep 300",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              type: "command_execution",
              input: "sleep 300",
            };

      const events = yield* RunExecutionService.cascadeTerminalizeRunOwnedSubagents({
        run: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        open: {
          subagents: new Map([[subagentId, subagent]]),
          turnItems: new Map([[subagentId, turnItem]]),
          childTurnItems: new Map(),
          nodes: new Map([[subagentId, node]]),
          linkedChildThreadIds: new Set([childThreadId]),
          linkedWorkflowMemberIds: new Set(),
        },
        status: terminalStatus,
        completedAt: now,
        allocateEventId,
      });

      assert.equal(events.length, 3, `${driverKind}: subagent + node + turn item`);
      const terminalSubagent = events.find((event) => event.type === "subagent.updated");
      assert.isDefined(terminalSubagent);
      if (terminalSubagent?.type !== "subagent.updated") {
        assert.fail("expected subagent.updated event");
        return;
      }
      assert.equal(terminalSubagent.payload.status, terminalStatus);
      assert.equal(terminalSubagent.payload.childThreadId, childThreadId);
      assert.equal(terminalSubagent.payload.progress, "partial progress");
      assert.equal(terminalSubagent.payload.result, "partial result");
      assert.equal(terminalSubagent.payload.driver, driverKind);

      const terminalItem = events.find(
        (event) => event.type === "turn-item.updated" && event.payload.type === "subagent",
      );
      assert.isDefined(terminalItem);
      if (terminalItem?.type !== "turn-item.updated" || terminalItem.payload.type !== "subagent") {
        assert.fail("expected subagent turn-item.updated event");
        return;
      }
      assert.equal(terminalItem.payload.status, terminalStatus);
      assert.equal(terminalItem.payload.childThreadId, childThreadId);
      assert.equal(terminalItem.payload.progress, "partial progress");
      assert.equal(terminalItem.payload.result, "partial result");

      // Shared cascade path: after subagent/turn-item rows are gone, only the
      // preserved linkage may prove an open child-thread node is cascadeable.
      const afterTerminalLinkEvents =
        yield* RunExecutionService.cascadeTerminalizeRunOwnedSubagents({
          run: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          open: {
            subagents: new Map(),
            turnItems: new Map(),
            childTurnItems: new Map([[childTurnItem.id, childTurnItem]]),
            nodes: new Map([[childNodeId, openChildNode]]),
            linkedChildThreadIds: new Set([childThreadId]),
            linkedWorkflowMemberIds: new Set(),
          },
          status: terminalStatus,
          completedAt: now,
          allocateEventId,
        });
      assert.equal(
        afterTerminalLinkEvents.length,
        2,
        `${driverKind}: linked child node and turn item cascade after link rows terminalize`,
      );
      const cascadedChild = afterTerminalLinkEvents.find((event) => event.type === "node.updated");
      assert.isDefined(cascadedChild);
      if (cascadedChild?.type !== "node.updated") {
        assert.fail("expected node.updated for linked child thread");
        return;
      }
      assert.equal(cascadedChild.payload.id, childNodeId);
      assert.equal(cascadedChild.payload.threadId, childThreadId);
      assert.equal(cascadedChild.payload.status, terminalStatus);
      assert.equal(cascadedChild.payload.kind, "root_turn");
      const cascadedChildTurnItem = afterTerminalLinkEvents.find(
        (event) => event.type === "turn-item.updated",
      );
      assert.isDefined(cascadedChildTurnItem);
      if (cascadedChildTurnItem?.type !== "turn-item.updated") {
        assert.fail("expected turn-item.updated for linked child thread");
        return;
      }
      assert.equal(cascadedChildTurnItem.threadId, childThreadId);
      assert.equal(cascadedChildTurnItem.payload.id, childTurnItem.id);
      assert.equal(cascadedChildTurnItem.payload.status, terminalStatus);
      assert.equal(cascadedChildTurnItem.payload.runId, null);
      assert.equal(cascadedChildTurnItem.payload.type, childTurnItem.type);
      if (cascadedChildTurnItem.payload.type === "reasoning") {
        assert.isFalse(cascadedChildTurnItem.payload.streaming);
      }
    }
  }),
);

it.effect("omits interrupt results and subagent cascade for a superseded attempt", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "steer-supersede",
      shouldFinalizeRun: () => Effect.succeed(false),
      seedOpenSubagent: true,
    });
    assert.deepEqual(
      written.map((item) => item.type),
      [],
    );
    assert.deepEqual(observed, []);
  }),
);

it.effect("emits run_interrupt_result when superseded attempt still has a hard-stop request", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "stop-then-steer-supersede",
      shouldFinalizeRun: () => Effect.succeed(false),
      hasUnpairedRunInterruptRequest: () => Effect.succeed(true),
    });
    assert.deepEqual(
      written.map((item) => item.type),
      ["run_interrupt_result"],
    );
    assert.deepEqual(observed, ["pull-requests-refreshed"]);
    const ids = backgroundScenarioIds("stop-then-steer-supersede");
    const expectedRequestId = yield* Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      return idAllocator.derive.runSignalTurnItem({
        runId: ids.runId,
        signal: "interrupt-request",
      });
    }).pipe(Effect.provide(IdAllocator.layer));
    assert.equal(written[0]?.parentItemId, expectedRequestId);
  }),
);

it.effect("omits run_interrupt_result when superseded attempt request is already paired", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "stop-then-steer-already-paired",
      shouldFinalizeRun: () => Effect.succeed(false),
      hasUnpairedRunInterruptRequest: () => Effect.succeed(false),
    });
    assert.deepEqual(
      written.map((item) => item.type),
      [],
    );
    assert.deepEqual(observed, []);
  }),
);

it.effect("emits run_interrupt_result when hard-stop finalizes the active attempt", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "hard-stop",
      shouldFinalizeRun: () => Effect.succeed(true),
    });
    assert.deepEqual(
      written.map((item) => item.type),
      ["run_interrupt_result"],
    );
    assert.deepEqual(observed, ["run:interrupted", "pull-requests-refreshed"]);
  }),
);

for (const status of ["completed", "interrupted", "cancelled", "failed"] as const) {
  it.effect(`refreshes pull requests after the current root run ${status}`, () =>
    Effect.gen(function* () {
      const { observed } = yield* captureRootRunTermination({
        key: `pull-request-refresh:${status}`,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: (ids) => Stream.make(rootTerminalEvent(ids, status)),
      });
      assert.deepEqual(observed, [
        `run:${status === "completed" ? "waiting" : status}`,
        "pull-requests-refreshed",
      ]);
    }),
  );
}

it.effect("does not refresh pull requests for auxiliary or stale provider terminals", () =>
  Effect.gen(function* () {
    const { observed } = yield* captureRootRunTermination({
      key: "pull-request-refresh:auxiliary",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) =>
        Stream.fromIterable([
          rootTerminalEvent(
            { ...ids, rootProviderTurnId: ProviderTurnId.make("turn:child") },
            "completed",
          ),
          rootTerminalEvent(
            { ...ids, rootProviderTurnId: ProviderTurnId.make("turn:previous") },
            "interrupted",
          ),
        ]),
    });
    assert.deepEqual(observed, []);
  }),
);

it.effect("refreshes pull requests after a provider stream exits with an error", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "pull-request-refresh:stream-error",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () =>
        Stream.fail(
          new ProviderAdapterEventStreamError({
            driver,
            providerSessionId: ProviderSessionId.make("session:exited"),
            cause: "provider process exited",
          }),
        ),
    });
    assert.deepEqual(observed, ["run:failed", "pull-requests-refreshed"]);
    assert.deepEqual(
      written.map((item) => item.type),
      ["error"],
    );
    const error = written.find((item) => item.type === "error");
    assert.include(error?.failure.message ?? "", "provider event stream closed unexpectedly");
  }),
);

it.effect("refreshes pull requests only once when startup failure closes its event stream", () =>
  Effect.gen(function* () {
    const ingestionStarted = yield* Deferred.make<void>();
    const { observed, written } = yield* captureRootRunTermination({
      key: "pull-request-refresh:startup-error",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () =>
        Stream.unwrap(Deferred.succeed(ingestionStarted, undefined).pipe(Effect.as(Stream.never))),
      startTurn: (input) =>
        Deferred.await(ingestionStarted).pipe(
          Effect.andThen(
            Effect.fail(
              new ProviderAdapterTurnStartError({
                driver,
                threadId: input.threadId,
                providerThreadId: input.providerThread.id,
                runId: input.runId,
                cause: "provider rejected the turn",
              }),
            ),
          ),
        ),
    });
    assert.equal(observed.filter((item) => item === "pull-requests-refreshed").length, 1);
    assert.equal(observed[0], "run:failed");
    const error = written.find((item) => item.type === "error");
    assert.include(error?.failure.message ?? "", "provider could not start this turn");
  }),
);

for (const streamPulled of [false, true]) {
  it.effect(
    `closes an immediate failed-start subscription exactly once ${streamPulled ? "after" : "before"} ingestion starts`,
    () =>
      Effect.gen(function* () {
        const ingestionStarted = yield* Deferred.make<void>();
        const phases: string[] = [];
        const result = yield* captureRootRunTermination({
          key: `subscription-startup-close:${streamPulled}`,
          shouldFinalizeRun: () => Effect.succeed(true),
          awaitSubscriptionClose: false,
          observeLifecycle: (phase) => phases.push(phase),
          events: () =>
            Stream.unwrap(
              Effect.sync(() => {
                phases.push("stream-pull");
                return Stream.never;
              }).pipe(Effect.tap(() => Deferred.succeed(ingestionStarted, undefined))),
            ),
          startTurn: (turn) =>
            Effect.gen(function* () {
              phases.push("start");
              if (streamPulled) yield* Deferred.await(ingestionStarted);
              return yield* Effect.fail(
                new ProviderAdapterTurnStartError({
                  driver: turn.providerThread.driver,
                  threadId: turn.threadId,
                  providerThreadId: turn.providerThread.id,
                  runId: turn.runId,
                  cause: "immediate typed startup rejection",
                }),
              );
            }),
        }).pipe(
          // Keep the pre-pull leg synchronous through its real child interruption.
          // This reference is local to the test, never the shared scheduler.
          Effect.provideService(Scheduler.PreventSchedulerYield, true),
        );
        assert.lengthOf(result.guards, 1);
        assert.equal(result.guards[0]!.activeAttemptId, result.ids.attemptId);
        assert.equal(result.guards[0]!.expectedStatus, "running");
        assert.deepEqual(result.observed, ["run:failed", "pull-requests-refreshed"]);
        assert.lengthOf(
          result.written.filter((item) => item.type === "error"),
          1,
        );
        assert.deepEqual(phases, [
          "subscribed",
          "start",
          ...(streamPulled ? ["stream-pull"] : []),
          "closed",
          "run:failed",
          "refresh",
        ]);
      }),
  );
}

it.effect(
  "closes the captured snapshot source exactly once when consumer binding fails before ingestion",
  () =>
    Effect.gen(function* () {
      const key = "subscription-snapshot-bind-failure";
      const ids = backgroundScenarioIds(key);
      const phases: string[] = [];
      const bindFailure = new Error("synthetic snapshot bind failure");
      let failure: Cause.Cause<unknown> | undefined;
      const result = yield* captureRootRunTermination({
        key,
        shouldFinalizeRun: () => Effect.succeed(true),
        awaitSubscriptionClose: false,
        observeLifecycle: (phase) => phases.push(phase),
        snapshotSubscription: Effect.sync(() => {
          phases.push("snapshot-subscribed");
          const events = Stream.unwrap(
            Effect.sync(() => {
              phases.push("stream-pull");
              return Stream.never;
            }),
          );
          return {
            events,
            snapshotEvents: events,
            textSnapshotConsumer: {
              bind: (owner) =>
                Effect.sync(() => {
                  phases.push("snapshot-bind");
                  assert.deepEqual(owner, {
                    threadId: ids.threadId,
                    runId: ids.runId,
                    activeAttemptId: ids.attemptId,
                    rootNodeId: ids.rootNodeId,
                    runOrdinal: 1,
                    providerThreadId: ids.providerThreadId,
                    providerSessionId: ProviderSessionId.make(`session:${key}`),
                    providerInstanceId: ProviderInstanceId.make("codex"),
                    driver,
                  });
                }).pipe(Effect.andThen(Effect.die(bindFailure))),
              consume: () => Effect.void,
            },
            close: Effect.sync(() => {
              phases.push("snapshot-retired", "source-closed");
            }),
          };
        }),
        onStartFailure: (cause) => {
          failure = cause;
          phases.push("start-exit");
        },
        startTurn: () => Effect.sync(() => phases.push("start")).pipe(Effect.asVoid),
      });
      assert.isDefined(failure);
      assert.equal(Cause.squash(failure!), bindFailure);
      assert.deepEqual(phases, [
        "snapshot-subscribed",
        "snapshot-bind",
        "snapshot-retired",
        "source-closed",
        "start-exit",
      ]);
      assert.deepEqual(result.observed, []);
      assert.deepEqual(result.written, []);
      assert.deepEqual(result.events, []);
      assert.deepEqual(result.guards, []);
    }),
);

it.effect("closes a normally terminating ingestion subscription exactly once", () =>
  Effect.gen(function* () {
    const phases: string[] = [];
    yield* captureRootRunTermination({
      key: "subscription-normal-close",
      shouldFinalizeRun: () => Effect.succeed(true),
      observeLifecycle: (phase) => phases.push(phase),
      events: (ids) => Stream.make(rootTerminalEvent(ids, "completed")),
      startTurn: () =>
        Effect.sync(() => {
          phases.push("start");
        }),
    });
    assert.equal(phases.filter((phase) => phase === "subscribed").length, 1);
    assert.equal(phases.filter((phase) => phase === "start").length, 1);
    assert.equal(phases.filter((phase) => phase === "closed").length, 1);
    assert.equal(phases.filter((phase) => phase === "refresh").length, 1);
  }),
);

for (const declineFinalWrite of [false, true]) {
  it.effect(
    `rechecks Droid holds outside the real permit and does not retry a ${declineFinalWrite ? "declined" : "committed"} final write`,
    () =>
      Effect.gen(function* () {
        const ingestionStarted = yield* Deferred.make<void>();
        const probes: string[] = [];
        let presenceChecks = 0;
        let drops = 0;
        const result = yield* captureRootRunTermination({
          key: `droid-finalization-recheck:${declineFinalWrite}`,
          shouldFinalizeRun: () => Effect.succeed(true),
          declineFinalWrite,
          events: () =>
            Stream.unwrap(
              Deferred.succeed(ingestionStarted, undefined).pipe(Effect.as(Stream.never)),
            ),
          startTurn: (turn) =>
            Deferred.await(ingestionStarted).pipe(
              Effect.andThen(
                Effect.fail(
                  new ProviderAdapterTurnStartError({
                    driver: turn.providerThread.driver,
                    threadId: turn.threadId,
                    providerThreadId: turn.providerThread.id,
                    runId: turn.runId,
                    cause: "typed non-stream startup failure",
                  }),
                ),
              ),
            ),
          droidTerminalHeld: (ids, locks) => (attemptId, status) =>
            Effect.gen(function* () {
              assert.equal(attemptId, ids.attemptId);
              probes.push(status);
              if (status === "completed") return ++presenceChecks <= 2;
              if (probes.length === 1) return false;
              // The canonical native drop follows this same nonrecursive executor.
              // A status substitution inside its permit cannot finish this callback.
              yield* locks.withLock(
                ids.threadId,
                Effect.sync(() => {
                  drops++;
                }),
              );
              return false;
            }),
        });
        assert.deepEqual(probes, [
          "failed",
          "completed",
          "failed",
          "completed",
          "failed",
          "completed",
        ]);
        assert.equal(drops, 2);
        assert.lengthOf(result.guards, 1, "A failed current-owner CAS is final, not another retry");
        assert.deepEqual(
          result.observed,
          declineFinalWrite ? [] : ["run:failed", "pull-requests-refreshed"],
        );
        assert.equal(
          result.written.filter((item) => item.type === "error").length,
          declineFinalWrite ? 0 : 1,
        );
      }),
  );
}

it.effect("keeps completed runs completed when pull request refresh fails", () =>
  Effect.gen(function* () {
    const { observed } = yield* captureRootRunTermination({
      key: "pull-request-refresh:refresh-failure",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) => Stream.make(rootTerminalEvent(ids, "completed")),
      refreshAfterTurn: Effect.die("refresh failed"),
    });
    assert.deepEqual(observed, ["run:waiting", "pull-requests-refreshed"]);
  }),
);

function committedRootReceipt(
  ids: BackgroundScenarioIds,
  now: DateTime.Utc,
  status: OrchestrationV2ProviderTurn["status"],
  nativeAcceptance: OrchestrationV2ProviderTurn["nativeAcceptance"],
) {
  const receipt: OrchestrationV2ProviderTurn = {
    id: ids.rootProviderTurnId,
    providerThreadId: ids.providerThreadId,
    nodeId: ids.rootNodeId,
    runAttemptId: ids.attemptId,
    nativeTurnRef: null,
    ordinal: 2,
    status,
    nativeAcceptance,
    ...(nativeAcceptance === "accepted" ? { acceptedAt: now } : {}),
    startedAt: now,
    completedAt: status === "pending" || status === "running" ? null : now,
    tokenUsage: {
      inputTokens: 13,
      outputTokens: 7,
      usedTokens: 20,
      maxTokens: 32_000,
      updatedAt: DateTime.formatIso(now),
    },
  };
  const frame: ProviderAdapterV2Event = {
    type: "provider_turn.updated",
    driver,
    threadId: ids.threadId,
    providerTurn: { ...receipt, ordinal: 1 },
  };
  const stored: OrchestrationV2StoredEvent = {
    sequence: 1,
    commandId: null,
    event: {
      id: EventId.make("event:committed-root"),
      type: "provider-turn.updated",
      threadId: ids.threadId,
      runId: ids.runId,
      nodeId: ids.rootNodeId,
      driver,
      providerInstanceId: ProviderInstanceId.make("codex"),
      occurredAt: now,
      payload: receipt,
    },
  };
  return { receipt, frame, stored };
}

const exitedProviderStream = () =>
  Stream.fail(
    new ProviderAdapterEventStreamError({
      driver,
      providerSessionId: ProviderSessionId.make("session:stream-failure"),
      cause: "owned native process exited",
    }),
  );

for (const [status, acceptance] of [
  ["pending", "unknown"],
  ["pending", "pending"],
  ["running", "accepted"],
  ["completed", "accepted"],
  ["failed", "accepted"],
  ["interrupted", "accepted"],
  ["cancelled", "accepted"],
] as const) {
  it.effect(`preserves committed ${status}/${acceptance} native receipt on stream failure`, () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const key = `committed-root:${status}:${acceptance}`;
      const ids = backgroundScenarioIds(key);
      const { receipt, frame, stored } = committedRootReceipt(ids, now, status, acceptance);
      const result = yield* captureRootRunTermination({
        key,
        attemptProviderTurnAbsent: true,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: () => Stream.concat(Stream.succeed(frame), exitedProviderStream()),
        ingestNormalized: () => () => Effect.succeed([stored]),
      });
      const updates = result.events.filter((event) => event.type === "provider-turn.updated");
      if (status === "pending" || status === "running") {
        assert.lengthOf(updates, 1);
        assert.equal(updates[0]!.payload.status, "failed");
        assert.exists(updates[0]!.payload.completedAt);
        assert.deepEqual(
          { ...updates[0]!.payload, status, completedAt: receipt.completedAt },
          receipt,
        );
      } else {
        assert.deepEqual(updates, [], "An already-terminal native receipt must not be downgraded");
      }
      const error = result.written.find((item) => item.type === "error");
      assert.equal(error?.providerTurnId, receipt.id);
      assert.deepEqual(result.guards, [
        { activeAttemptId: ids.attemptId, expectedStatus: "running" },
      ]);
      assert.deepEqual(result.observed, ["run:failed", "pull-requests-refreshed"]);
    }),
  );
}

for (const mismatch of [
  "thread",
  "run",
  "node",
  "instance",
  "driver",
  "turn",
  "payloadNode",
  "attempt",
  "providerThread",
  "empty",
  "unrelated",
  "sql-failure",
] as const) {
  it.effect(`does not retain ${mismatch} stored receipt as the root on stream failure`, () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const key = `committed-root-mismatch:${mismatch}`;
      const ids = backgroundScenarioIds(key);
      const { frame, stored } = committedRootReceipt(ids, now, "running", "accepted");
      const event = stored.event;
      assert.equal(event.type, "provider-turn.updated");
      if (event.type !== "provider-turn.updated")
        return yield* Effect.die("Wrong test receipt type");
      const changed: OrchestrationV2StoredEvent = {
        ...stored,
        event: {
          ...event,
          ...(mismatch === "thread" ? { threadId: ids.childThreadId } : {}),
          ...(mismatch === "run" ? { runId: RunId.make("run:foreign") } : {}),
          ...(mismatch === "node" ? { nodeId: ids.subagentNodeId } : {}),
          ...(mismatch === "instance"
            ? { providerInstanceId: ProviderInstanceId.make("foreign") }
            : {}),
          ...(mismatch === "driver" ? { driver: ProviderDriverKind.make("pi") } : {}),
          payload: {
            ...event.payload,
            ...(mismatch === "turn" ? { id: ProviderTurnId.make("turn:child") } : {}),
            ...(mismatch === "payloadNode" ? { nodeId: ids.subagentNodeId } : {}),
            ...(mismatch === "attempt"
              ? { runAttemptId: RunAttemptId.make("attempt:foreign") }
              : {}),
            ...(mismatch === "providerThread"
              ? { providerThreadId: ProviderThreadId.make("provider-thread:foreign") }
              : {}),
          },
        },
      };
      const result = yield* captureRootRunTermination({
        key,
        attemptProviderTurnAbsent: true,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: () => Stream.concat(Stream.succeed(frame), exitedProviderStream()),
        ingestNormalized: () => () =>
          mismatch === "sql-failure"
            ? Effect.fail(
                new ProviderEventIngestor.ProviderEventPublishError({
                  providerSessionId: ProviderSessionId.make("session:failed-write"),
                  eventCount: 1,
                  cause: "SQL commit failed",
                }),
              )
            : Effect.succeed(
                mismatch === "empty"
                  ? []
                  : mismatch === "unrelated"
                    ? [
                        {
                          ...stored,
                          event: {
                            ...event,
                            type: "provider-thread.updated",
                            payload: {
                              id: ids.providerThreadId,
                              driver,
                            } as OrchestrationV2ProviderThread,
                          },
                        },
                      ]
                    : [changed],
              ),
      });
      assert.deepEqual(
        result.events.filter((row) => row.type === "provider-turn.updated"),
        [],
      );
      const error = result.written.find((item) => item.type === "error");
      assert.notEqual(error?.providerTurnId, ids.rootProviderTurnId);
      assert.deepEqual(result.observed, ["run:failed", "pull-requests-refreshed"]);
    }),
  );
}

it.effect(
  "does not overwrite a superseded owner when failed-stream CAS declines after the precheck",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const key = "committed-root:replacement-cas";
      const ids = backgroundScenarioIds(key);
      const { frame, stored } = committedRootReceipt(ids, now, "running", "accepted");
      const result = yield* captureRootRunTermination({
        key,
        attemptProviderTurnAbsent: true,
        declineFinalWrite: true,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: () => Stream.concat(Stream.succeed(frame), exitedProviderStream()),
        ingestNormalized: () => () => Effect.succeed([stored]),
      });
      assert.deepEqual(result.guards, [
        { activeAttemptId: ids.attemptId, expectedStatus: "running" },
      ]);
      assert.deepEqual(result.events, []);
      assert.deepEqual(result.written, []);
      assert.deepEqual(result.observed, []);
    }),
);

it.effect(
  "keeps the last committed root when a later differently-routed frame fails its SQL commit",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const key = "committed-root:later-sql-failure";
      const ids = backgroundScenarioIds(key);
      const { receipt, frame, stored } = committedRootReceipt(ids, now, "running", "accepted");
      const later = {
        ...frame,
        providerTurn: { ...receipt, id: ProviderTurnId.make("turn:uncommitted-replacement") },
      };
      let calls = 0;
      const result = yield* captureRootRunTermination({
        key,
        attemptProviderTurnAbsent: true,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: () => Stream.fromIterable([frame, later]),
        ingestNormalized: () => () =>
          ++calls === 1
            ? Effect.succeed([stored])
            : Effect.fail(
                new ProviderEventIngestor.ProviderEventPublishError({
                  providerSessionId: ProviderSessionId.make("session:failed-later-write"),
                  eventCount: 1,
                  cause: "SQL commit failed",
                }),
              ),
      });
      const updates = result.events.filter((event) => event.type === "provider-turn.updated");
      assert.lengthOf(updates, 1);
      assert.equal(updates[0]!.payload.id, receipt.id);
      assert.equal(
        result.written.find((item) => item.type === "error")?.providerTurnId,
        receipt.id,
      );
      assert.deepEqual(updates[0]!.payload.acceptedAt, receipt.acceptedAt);
    }),
);

it.effect(
  "retains the newest committed root identity and canonical usage across later partial updates",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const key = "committed-root:newest-native-receipt";
      const ids = backgroundScenarioIds(key);
      const { frame, stored } = committedRootReceipt(ids, now, "running", "accepted");
      if (stored.event.type !== "provider-turn.updated")
        return yield* Effect.die("Wrong receipt type");
      const nextId = ProviderTurnId.make("turn:committed-next-root");
      const nextReceipt = { ...stored.event.payload, id: nextId, ordinal: 3 };
      const partialReceipt = { ...nextReceipt, tokenUsage: undefined };
      const nextFrame = { ...frame, providerTurn: nextReceipt };
      const partialFrame = { ...frame, providerTurn: partialReceipt };
      let calls = 0;
      const result = yield* captureRootRunTermination({
        key,
        attemptProviderTurnAbsent: true,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: () =>
          Stream.concat(
            Stream.fromIterable([frame, nextFrame, partialFrame]),
            exitedProviderStream(),
          ),
        ingestNormalized: () => () =>
          Effect.succeed([
            ++calls === 1
              ? stored
              : {
                  ...stored,
                  sequence: calls,
                  event: {
                    ...stored.event,
                    type: "provider-turn.updated",
                    payload: calls === 2 ? nextReceipt : partialReceipt,
                  },
                },
          ]),
      });
      const updates = result.events.filter((event) => event.type === "provider-turn.updated");
      assert.lengthOf(updates, 1);
      assert.equal(updates[0]!.payload.id, nextId);
      assert.equal(updates[0]!.payload.ordinal, 3);
      assert.deepEqual(updates[0]!.payload.tokenUsage, nextReceipt.tokenUsage);
      assert.deepEqual(updates[0]!.payload.acceptedAt, nextReceipt.acceptedAt);
      assert.equal(result.written.find((item) => item.type === "error")?.providerTurnId, nextId);
    }),
);

function captureRootRunTermination(input: {
  readonly key: string;
  readonly shouldFinalizeRun: () => Effect.Effect<boolean, never>;
  readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
  readonly seedOpenSubagent?: boolean;
  readonly events?: (
    ids: BackgroundScenarioIds,
  ) => Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>;
  readonly startTurn?: ProviderAdapterV2SessionRuntime["startTurn"];
  readonly droidTerminalHeld?: (
    ids: BackgroundScenarioIds,
    locks: ThreadCommandExecutor["Service"],
  ) => NonNullable<ProviderAdapterV2SessionRuntime["droidSteerTerminalHeld"]>;
  readonly refreshAfterTurn?: Effect.Effect<void>;
  readonly ingestNormalized?: (
    ids: BackgroundScenarioIds,
  ) => ProviderEventIngestor.ProviderEventIngestorV2Shape["ingestNormalized"];
  readonly declineFinalWrite?: boolean;
  readonly attemptProviderTurnAbsent?: boolean;
  readonly awaitSubscriptionClose?: boolean;
  readonly observeLifecycle?: (phase: string) => void;
  readonly snapshotSubscription?: ProviderAdapterV2SessionRuntime["subscribeTextSnapshotEvents"];
  readonly onStartFailure?: (cause: Cause.Cause<unknown>) => void;
}) {
  return Effect.gen(function* () {
    const ids = backgroundScenarioIds(input.key);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const runningSubagent = makeRunOwnedSubagentFixture({
      ids,
      providerInstanceId,
      childThreadId: ids.childThreadId,
      driver,
      status: "running",
    });
    const writtenItems = yield* Ref.make<ReadonlyArray<OrchestrationV2TurnItem>>([]);
    const writtenEvents = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const finalWriteGuards = yield* Ref.make<
      ReadonlyArray<{ activeAttemptId: RunAttemptId; expectedStatus: OrchestrationV2Run["status"] }>
    >([]);
    const observed = yield* Ref.make<ReadonlyArray<string>>([]);
    const ingestionDone = yield* Deferred.make<void>();
    const captureTurnItem = (payload: OrchestrationV2TurnItem) =>
      Ref.update(writtenItems, (current) => [...current, payload]);
    const captureEvents = Effect.fnUntraced(function* (
      events: ReadonlyArray<OrchestrationV2DomainEvent>,
    ) {
      yield* Ref.update(writtenEvents, (current) => [...current, ...events]);
      for (const event of events) {
        if (event.type === "turn-item.updated") yield* captureTurnItem(event.payload);
        if (event.type === "run.updated") {
          yield* Ref.update(observed, (current) => [...current, `run:${event.payload.status}`]);
          input.observeLifecycle?.(`run:${event.payload.status}`);
        }
      }
      return [];
    });
    const testLayer = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSink.EventSinkV2)({
            write: (payload) => captureEvents(payload.events),
            writeWithEffects: (payload) => captureEvents(payload.events),
            writeIfRunCurrent: (payload) =>
              Ref.update(finalWriteGuards, (current) => [
                ...current,
                {
                  activeAttemptId: payload.activeAttemptId,
                  expectedStatus: payload.expectedStatus,
                },
              ]).pipe(
                Effect.andThen(
                  input.declineFinalWrite
                    ? Effect.succeed({ committed: false, storedEvents: [] })
                    : captureEvents(payload.events).pipe(
                        Effect.map((storedEvents) => ({ committed: true, storedEvents })),
                      ),
                ),
              ),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: input.ingestNormalized?.(ids) ?? (() => Effect.succeed([])),
          }),
          ServerSettings.layerTest(),
          Layer.succeed(RunFinalizationService.RunFinalizationObserver, {
            refresh: () => Effect.void,
            refreshAfterTurn: () =>
              Ref.update(observed, (current) => [...current, "pull-requests-refreshed"]).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    input.observeLifecycle?.("refresh");
                  }),
                ),
                Effect.andThen(input.refreshAfterTurn ?? Effect.void),
              ),
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution
        .startRootRun({
          commandId: CommandId.make(`command:${input.key}`),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:${input.key}`),
          session: {
            driver:
              input.droidTerminalHeld === undefined ? driver : ProviderDriverKind.make("droid"),
            ...(input.droidTerminalHeld === undefined
              ? {}
              : {
                  droidSteerTerminalHeld: input.droidTerminalHeld(
                    ids,
                    yield* ThreadCommandExecutor,
                  ),
                }),
            events: Stream.empty,
            ...(input.snapshotSubscription === undefined
              ? {}
              : { subscribeTextSnapshotEvents: input.snapshotSubscription }),
            subscribeEvents: Effect.sync(() => {
              input.observeLifecycle?.("subscribed");
              return {
                events:
                  input.events?.(ids) ??
                  Stream.fromIterable([
                    ...(input.seedOpenSubagent
                      ? [
                          { type: "subagent.updated", driver, subagent: runningSubagent } as const,
                          {
                            type: "node.updated",
                            driver,
                            node: makeRunOwnedSubagentNodeFixture({ ids, status: "running" }),
                          } as const,
                          {
                            type: "turn_item.updated",
                            driver,
                            turnItem: makeRunOwnedSubagentTurnItemFixture({
                              ids,
                              providerInstanceId,
                              childThreadId: ids.childThreadId,
                              driver,
                              status: "running",
                            }),
                          } as const,
                        ]
                      : []),
                    rootTerminalEvent(ids, "interrupted"),
                  ] satisfies ReadonlyArray<ProviderAdapterV2Event>),
                close: Effect.sync(() => {
                  input.observeLifecycle?.("closed");
                }).pipe(Effect.andThen(Deferred.succeed(ingestionDone, undefined))),
              };
            }),
            startTurn: input.startTurn ?? (() => Effect.void),
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: {
            id: ids.rootNodeId,
            providerTurnId: input.attemptProviderTurnAbsent ? null : ids.rootProviderTurnId,
          } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make(`checkpoint-scope:${input.key}`),
          } as OrchestrationV2CheckpointScope,
          providerThread: {
            id: ids.providerThreadId,
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: input.attemptProviderTurnAbsent ? null : ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          providerTurnOrdinal: 1,
          shouldFinalizeRun: input.shouldFinalizeRun,
          ...(input.hasUnpairedRunInterruptRequest === undefined
            ? {}
            : {
                hasUnpairedRunInterruptRequest: input.hasUnpairedRunInterruptRequest,
              }),
          message: {
            messageId: MessageId.make(`message:${input.key}`),
            text: "interrupt projection",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        })
        .pipe(
          Effect.catchCause((cause) =>
            input.onStartFailure === undefined
              ? Effect.failCause(cause)
              : Effect.sync(() => input.onStartFailure!(cause)),
          ),
        );
    }).pipe(Effect.provide(testLayer.pipe(Layer.provideMerge(threadCommandExecutorLayer))));

    if (input.awaitSubscriptionClose !== false) yield* Deferred.await(ingestionDone);
    return {
      written: yield* Ref.get(writtenItems),
      observed: yield* Ref.get(observed),
      events: yield* Ref.get(writtenEvents),
      guards: yield* Ref.get(finalWriteGuards),
      ids,
    };
  });
}

interface BackgroundScenarioIds {
  readonly threadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
  readonly rootProviderTurnId: ProviderTurnId;
  readonly rootNodeId: NodeId;
  readonly itemId: TurnItemId;
  readonly childItemId: TurnItemId;
  readonly subagentNodeId: NodeId;
}

function backgroundScenarioIds(key: string): BackgroundScenarioIds {
  return {
    threadId: ThreadId.make(`thread:${key}`),
    childThreadId: ThreadId.make(`thread:${key}:child`),
    runId: RunId.make(`run:${key}`),
    attemptId: RunAttemptId.make(`attempt:${key}`),
    providerThreadId: ProviderThreadId.make(`provider-thread:${key}`),
    rootProviderTurnId: ProviderTurnId.make(`provider-turn:${key}`),
    rootNodeId: NodeId.make(`node:${key}`),
    itemId: TurnItemId.make(`turn-item:${key}`),
    childItemId: TurnItemId.make(`turn-item:${key}:child`),
    subagentNodeId: NodeId.make(`node:${key}:subagent`),
  };
}

function childThreadCreatedEvent(ids: BackgroundScenarioIds): ProviderAdapterV2Event {
  return {
    type: "app_thread.created",
    driver,
    appThread: {
      id: ids.childThreadId,
      lineage: {
        parentThreadId: ids.threadId,
        relationshipToParent: "subagent",
        rootThreadId: ids.threadId,
      },
    },
  } as ProviderAdapterV2Event;
}

function childBackgroundTurnItemEvent(
  ids: BackgroundScenarioIds,
  status: "running" | "completed" | "idle",
  ordinal: number,
): ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: ids.childItemId,
      threadId: ids.childThreadId,
      runId: null,
      providerTurnId: null,
      ordinal,
      type: "command_execution",
      status,
    },
  } as ProviderAdapterV2Event;
}

function backgroundTurnItemEvent(
  ids: BackgroundScenarioIds,
  type: "command_execution" | "dynamic_tool" | "subagent",
  status: "running" | "completed" | "idle",
  ordinal: number,
  itemId?: TurnItemId,
): ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: itemId ?? ids.itemId,
      threadId: ids.threadId,
      runId: ids.runId,
      providerTurnId: ids.rootProviderTurnId,
      ordinal,
      type,
      status,
    },
  } as ProviderAdapterV2Event;
}

function backgroundTurnItemEventForRun(
  ids: BackgroundScenarioIds,
  runId: RunId,
  type: "command_execution" | "dynamic_tool" | "subagent",
  status: "running" | "completed" | "idle",
  ordinal: number,
): ProviderAdapterV2Event {
  const event = backgroundTurnItemEvent(ids, type, status, ordinal);
  if (event.type !== "turn_item.updated") {
    return event;
  }
  return { ...event, turnItem: { ...event.turnItem, runId } };
}

function subagentEvent(
  ids: BackgroundScenarioIds,
  status: "running" | "completed" | "idle",
): ProviderAdapterV2Event {
  return {
    type: "subagent.updated",
    driver,
    subagent: {
      id: ids.subagentNodeId,
      threadId: ids.threadId,
      runId: ids.runId,
      status,
    },
  } as ProviderAdapterV2Event;
}

function makeRunOwnedSubagentFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly providerInstanceId: ProviderInstanceId;
  readonly childThreadId: ThreadId;
  readonly driver: typeof driver;
  readonly status: "running" | "interrupted";
}): OrchestrationV2Subagent {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.subagentNodeId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    parentNodeId: input.ids.rootNodeId,
    origin: "provider_native",
    createdBy: "agent",
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    providerThreadId: null,
    childThreadId: input.childThreadId,
    nativeTaskRef: {
      driver: input.driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    prompt: "hold",
    title: "Live-test subagent hold",
    model: null,
    status: input.status,
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
}

function makeRunOwnedSubagentTurnItemFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly providerInstanceId: ProviderInstanceId;
  readonly childThreadId: ThreadId;
  readonly driver: typeof driver;
  readonly status: "running" | "interrupted";
}): Extract<OrchestrationV2TurnItem, { type: "subagent" }> {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.itemId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    nodeId: input.ids.subagentNodeId,
    providerThreadId: input.ids.providerThreadId,
    providerTurnId: input.ids.rootProviderTurnId,
    nativeItemRef: {
      driver: input.driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    parentItemId: null,
    ordinal: 3,
    status: input.status,
    title: "Live-test subagent hold",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "subagent",
    subagentId: input.ids.subagentNodeId,
    origin: "provider_native",
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    childThreadId: input.childThreadId,
    prompt: "hold",
    result: null,
  };
}

function makeLinkedChildTurnItemFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly driver: typeof driver;
  readonly type: "assistant_message" | "command_execution" | "reasoning";
}): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  const base = {
    id: input.ids.childItemId,
    threadId: input.ids.childThreadId,
    runId: null,
    nodeId: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "running" as const,
    title: "Working",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  if (input.type === "assistant_message") {
    return {
      ...base,
      type: "assistant_message",
      messageId: MessageId.make(`${input.ids.childItemId}:message`),
      text: "partial response",
      streaming: true,
    };
  }
  if (input.type === "reasoning") {
    return {
      ...base,
      type: "reasoning",
      text: "partial progress",
      streaming: true,
    };
  }
  return {
    ...base,
    type: "command_execution",
    input: "sleep 300",
  };
}

function makeRunOwnedSubagentNodeFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly status: "running" | "interrupted";
}): OrchestrationV2ExecutionNode {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.subagentNodeId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    parentNodeId: input.ids.rootNodeId,
    rootNodeId: input.ids.rootNodeId,
    kind: "subagent",
    status: input.status,
    countsForRun: false,
    providerThreadId: input.ids.providerThreadId,
    providerTurnId: input.ids.rootProviderTurnId,
    nativeItemRef: {
      driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
}

function makeRunOwnedSubagentChildNodeFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly status: "running" | "interrupted";
}): OrchestrationV2ExecutionNode {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    threadId: input.ids.childThreadId,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    kind: "root_turn",
    status: input.status,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
}

function rootTerminalEvent(
  ids: BackgroundScenarioIds,
  status: "completed" | "interrupted" | "cancelled" | "failed",
): ProviderAdapterV2Event {
  const common = {
    type: "turn.terminal" as const,
    driver,
    providerThreadId: ids.providerThreadId,
    providerTurnId: ids.rootProviderTurnId,
    runOrdinal: 1,
    threadDisposition: "reusable" as const,
  };
  return status === "failed"
    ? {
        ...common,
        status,
        failureItemOrdinal: 101,
        failure: {
          class: "provider_error",
          message: "Provider failed",
          code: null,
          retryable: null,
        },
      }
    : { ...common, status, failure: null };
}

function runBackgroundItemScenario(
  key: string,
  makeEvents: (ids: BackgroundScenarioIds) => ReadonlyArray<ProviderAdapterV2Event>,
  options?: {
    readonly keepEventStreamOpen?: boolean;
    readonly loadInheritedBackgroundTurnItems?: () => Effect.Effect<
      ReadonlyArray<{ readonly id: TurnItemId; readonly runId: RunId }>
    >;
    readonly onSubscribe?: Effect.Effect<void>;
    readonly onFinalization?: (
      events: ReadonlyArray<OrchestrationV2DomainEvent>,
    ) => Effect.Effect<void>;
  },
) {
  return Effect.gen(function* () {
    const ids = backgroundScenarioIds(key);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const observed = yield* Ref.make<ReadonlyArray<string>>([]);
    const ingestionDone = yield* Deferred.make<void>();
    const testLayer = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSink.EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.gen(function* () {
                yield* options?.onFinalization?.(input.events) ?? Effect.void;
                if (
                  input.events.some(
                    (event) => event.type === "run.updated" && event.runId === ids.runId,
                  )
                ) {
                  yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                }
                return [];
              }),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: (input) =>
              Effect.gen(function* () {
                const event = input.event;
                if (event.type === "turn_item.updated") {
                  yield* Ref.update(observed, (current) => [
                    ...current,
                    `turn_item:${event.turnItem.status}`,
                  ]);
                }
                if (event.type === "subagent.updated") {
                  yield* Ref.update(observed, (current) => [
                    ...current,
                    `subagent:${event.subagent.status}`,
                  ]);
                }
                return [];
              }),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:${key}`),
        appThread: { id: ids.threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        session: {
          driver,
          events: Stream.empty,
          subscribeEvents: Effect.gen(function* () {
            yield* options?.onSubscribe ?? Effect.void;
            const events = Stream.fromIterable(makeEvents(ids));
            return {
              events:
                options?.keepEventStreamOpen === true
                  ? events.pipe(Stream.concat(Stream.never))
                  : events,
              close: Deferred.succeed(ingestionDone, undefined),
            };
          }),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: {
          id: ids.runId,
          threadId: ids.threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: ids.providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: ids.attemptId,
          providerTurnId: ids.rootProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId: ids.attemptId,
        ...(options?.loadInheritedBackgroundTurnItems === undefined
          ? {}
          : {
              loadInheritedBackgroundTurnItems: options.loadInheritedBackgroundTurnItems,
            }),
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make(`message:${key}:user`),
          text: "Start a background item and finish.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(testLayer));

    const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
    assert.isTrue(Option.isSome(closed), "event ingestion fiber did not finish");
    return yield* Ref.get(observed);
  });
}

it.effect("releases ingestion after idle subagent rows and items settle", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario(
      "subagent-idle",
      (ids) => [
        subagentEvent(ids, "running"),
        backgroundTurnItemEvent(ids, "subagent", "running", 1),
        subagentEvent(ids, "idle"),
        backgroundTurnItemEvent(ids, "subagent", "idle", 2),
        rootTerminalEvent(ids, "completed"),
      ],
      { keepEventStreamOpen: true },
    );
    assert.deepEqual(observed, [
      "subagent:running",
      "turn_item:running",
      "subagent:idle",
      "turn_item:idle",
      "root-finalized",
    ]);
  }),
);
