import { describe, expect, it } from "vite-plus/test";
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  ThreadSectionId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";

const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const threadId = ThreadId.make("thread-reducer");
const runId = RunId.make("run-reducer");
const run = {
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  providerThreadId: null,
  userMessageId: MessageId.make("message-reducer"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
} satisfies OrchestrationV2Run;

function commandItem(id: string, output = "done", ordinal = 1) {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "command_execution",
    input: "pwd",
    output,
    exitCode: 0,
  } satisfies OrchestrationV2TurnItem;
}
const emptyProjection = {
  thread: {
    id: threadId,
    projectId: ProjectId.make("project-reducer"),
    title: "Reducer",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
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
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: now,
} as OrchestrationV2ThreadProjection;

describe("applyOrchestrationV2ProjectionEvent", () => {
  it("keeps live token usage when the terminal provider turn omits it", () => {
    const providerTurnId = ProviderTurnId.make("provider-turn-reducer");
    const running = {
      id: providerTurnId,
      providerThreadId: ProviderThreadId.make("provider-thread-reducer"),
      nodeId: NodeId.make("provider-node-reducer"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running" as const,
      startedAt: now,
      completedAt: null,
      tokenUsage: {
        usedTokens: 50_000,
        maxTokens: 200_000,
        updatedAt: "2026-08-29T00:00:00.000Z",
      },
    };
    const projection = { ...emptyProjection, providerTurns: [running] };
    const event = {
      id: "event-provider-turn-terminal",
      type: "provider-turn.updated",
      threadId,
      driver: "codex",
      occurredAt: now,
      payload: {
        ...running,
        status: "completed",
        completedAt: now,
        tokenUsage: undefined,
      },
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);

    expect(next?.providerTurns[0]?.status).toBe("completed");
    expect(next?.providerTurns[0]?.tokenUsage).toEqual(running.tokenUsage);
  });

  it.each([ThreadSectionId.make("research"), null])(
    "files the native thread into section %s without activity and retains it on rename",
    (sectionId) => {
      const filed = applyOrchestrationV2ProjectionEvent(emptyProjection, {
        id: "native-section",
        type: "thread.metadata-updated",
        threadId,
        occurredAt: DateTime.add(now, { hours: 1 }),
        payload: { ...emptyProjection.thread, sectionId },
      } as OrchestrationV2DomainEvent);
      expect(filed?.thread.sectionId).toBe(sectionId);
      expect(filed?.thread.updatedAt).toEqual(emptyProjection.thread.updatedAt);
      const renamed = applyOrchestrationV2ProjectionEvent(filed!, {
        id: "native-rename",
        type: "thread.metadata-updated",
        threadId,
        occurredAt: DateTime.add(now, { hours: 2 }),
        payload: { ...filed!.thread, title: "Renamed", updatedAt: DateTime.add(now, { hours: 2 }) },
      } as OrchestrationV2DomainEvent);
      expect(renamed?.thread.sectionId).toBe(sectionId);
      expect(renamed?.thread.title).toBe("Renamed");
    },
  );

  it("applies thread lifecycle payloads instead of leaving stale metadata", () => {
    const archivedAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
    const event = {
      id: "event-archive",
      type: "thread.archived",
      threadId,
      occurredAt: archivedAt,
      payload: { ...emptyProjection.thread, archivedAt, updatedAt: archivedAt },
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(emptyProjection, event);
    expect(next?.thread.archivedAt).toEqual(archivedAt);
    expect(next?.updatedAt).toEqual(archivedAt);
  });

  it("ignores events for another thread", () => {
    const event = {
      id: "event-other",
      type: "thread.deleted",
      threadId: ThreadId.make("thread-other"),
      occurredAt: now,
      payload: { ...emptyProjection.thread, id: ThreadId.make("thread-other"), deletedAt: now },
    } as OrchestrationV2DomainEvent;

    expect(applyOrchestrationV2ProjectionEvent(emptyProjection, event)).toBe(emptyProjection);
  });

  it("preserves visible row identity when run updates do not change membership", () => {
    const item = commandItem("item-stable");
    const visibleTurnItems = [
      {
        position: 0,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      },
    ];
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: [item],
      visibleTurnItems,
    };
    const event = {
      id: "event-run-update",
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status: "completed" },
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems).toBe(visibleTurnItems);
    expect(next?.visibleTurnItems[0]).toBe(visibleTurnItems[0]);
  });

  it("replaces only the updated visible item when membership is unchanged", () => {
    const first = commandItem("item-first", "first");
    const second = commandItem("item-second", "second");
    const firstRow = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: first.id,
      item: first,
    };
    const secondRow = {
      position: 1,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: second.id,
      item: second,
    };
    const updated = commandItem("item-first", "streamed output");
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: [first, second],
      visibleTurnItems: [firstRow, secondRow],
    };
    const event = {
      id: "event-item-update",
      type: "turn-item.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: updated,
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems).not.toBe(projection.visibleTurnItems);
    expect(next?.visibleTurnItems[0]).not.toBe(firstRow);
    expect(next?.visibleTurnItems[0]?.item).toBe(updated);
    expect(next?.visibleTurnItems[1]).toBe(secondRow);
  });

  it.each([
    {
      name: "same visible run",
      anchorOrdinal: 2_000_001,
      anchorRunId: runId,
      visibility: "local",
      admitted: true,
    },
    {
      name: "truncated same-run tail",
      anchorOrdinal: 2_000_010,
      anchorRunId: runId,
      visibility: "local",
      admitted: false,
    },
    {
      name: "known off-window run",
      anchorOrdinal: 2_000_001,
      anchorRunId: RunId.make("other-run"),
      visibility: "local",
      admitted: false,
    },
    {
      name: "inherited run only",
      anchorOrdinal: 2_000_001,
      anchorRunId: runId,
      visibility: "inherited",
      admitted: false,
    },
    {
      name: "unowned imported history",
      anchorOrdinal: 2_000_001,
      anchorRunId: null,
      visibility: "local",
      admitted: false,
    },
  ] as const)(
    "bounds missing partial items by their $name",
    ({ anchorOrdinal, anchorRunId, visibility, admitted }) => {
      const anchor = {
        ...commandItem("window-anchor", "visible", anchorOrdinal),
        runId: anchorRunId,
      };
      const incoming = commandItem("late-sibling", "late", 2_000_002);
      const projection: OrchestrationV2ThreadProjection = {
        ...emptyProjection,
        runs: [run],
        turnItems: [anchor],
        visibleTurnItems: [
          {
            position: 0,
            visibility,
            sourceThreadId: threadId,
            sourceItemId: anchor.id,
            item: anchor,
          },
        ],
      };
      const next = applyOrchestrationV2ProjectionEvent(
        projection,
        {
          id: "late-sibling-event",
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: incoming,
        } as OrchestrationV2DomainEvent,
        { partialTimeline: true, latestLocalTurnOrdinal: 3_000_001 },
      );
      expect(next?.turnItems.some((item) => item.id === incoming.id)).toBe(admitted);
      expect(next?.visibleTurnItems.some((row) => row.sourceItemId === incoming.id)).toBe(admitted);
      if (!admitted) expect(next).toBe(projection);
    },
  );

  it("inserts an active-run answer despite a future queued run's watermark", () => {
    const active = commandItem("active-run-prompt", "active", 2_000_001);
    const queuedRunId = RunId.make("future-queued-run");
    const queued: OrchestrationV2TurnItem = {
      ...commandItem("future-queued-prompt", "queued", 3_000_001),
      runId: queuedRunId,
      type: "user_message",
      messageId: MessageId.make("future-queued-message"),
      createdBy: "user",
      creationSource: "web",
      inputIntent: "queued_turn",
      text: "Send after the active run",
      attachments: [],
    };
    const incoming = commandItem("active-run-answer", "late", 2_000_002);
    const projection: OrchestrationV2ThreadProjection = {
      ...emptyProjection,
      runs: [
        { ...run, status: "running" },
        { ...run, id: queuedRunId, ordinal: 3, status: "queued" },
      ],
      turnItems: [active, queued],
      visibleTurnItems: [active, queued].map((item, position) => ({
        position,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      })),
    };
    const next = applyOrchestrationV2ProjectionEvent(
      projection,
      {
        id: "active-run-answer-event",
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: incoming,
      } as OrchestrationV2DomainEvent,
      { partialTimeline: true, latestLocalTurnOrdinal: queued.ordinal },
    );
    expect(next?.visibleTurnItems.map((row) => row.sourceItemId)).toEqual([
      active.id,
      incoming.id,
      queued.id,
    ]);
    expect(next?.runs.find((candidate) => candidate.id === queuedRunId)?.status).toBe("queued");
  });

  it("retains visibility fences when inserting a late partial-window sibling", () => {
    const anchor = commandItem("rolled-back-anchor", "visible", 2_000_001);
    const incoming = commandItem("rolled-back-sibling", "hidden", 2_000_002);
    const projection: OrchestrationV2ThreadProjection = {
      ...emptyProjection,
      runs: [{ ...run, status: "rolled_back" }],
      turnItems: [anchor],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: anchor.id,
          item: anchor,
        },
      ],
    };
    const next = applyOrchestrationV2ProjectionEvent(
      projection,
      {
        id: "rolled-back-sibling-event",
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: incoming,
      } as OrchestrationV2DomainEvent,
      { partialTimeline: true, latestLocalTurnOrdinal: 3_000_001 },
    );
    expect(next?.turnItems.some((item) => item.id === incoming.id)).toBe(true);
    expect(next?.visibleTurnItems.some((row) => row.sourceItemId === incoming.id)).toBe(false);
  });

  it("inserts live turn items by authoritative ordinal", () => {
    const queuedFuture = commandItem("item-queued-future", "queued", 300);
    const activeAssistant = commandItem("item-active-assistant", "done", 201);
    const queuedRow = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: queuedFuture.id,
      item: queuedFuture,
    };
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: [queuedFuture],
      visibleTurnItems: [queuedRow],
    };
    const event = {
      id: "event-active-assistant",
      type: "turn-item.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: activeAssistant,
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems.map((row) => row.item.id)).toEqual([
      activeAssistant.id,
      queuedFuture.id,
    ]);
    expect(next?.visibleTurnItems.map((row) => row.position)).toEqual([0, 1]);
  });

  it("removes only hidden local items while preserving inherited rows", () => {
    const inherited = commandItem("item-inherited");
    const local = commandItem("item-local");
    const inheritedRow = {
      position: 0,
      visibility: "inherited" as const,
      sourceThreadId: ThreadId.make("thread-source"),
      sourceItemId: inherited.id,
      item: inherited,
    };
    const localRow = {
      position: 1,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: local.id,
      item: local,
    };
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: [local],
      visibleTurnItems: [inheritedRow, localRow],
    };
    const event = {
      id: "event-run-rollback",
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status: "rolled_back" },
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems).toEqual([inheritedRow]);
    expect(next?.visibleTurnItems[0]).toBe(inheritedRow);
  });
});

it("does not scan every row against every run for a streaming item update", () => {
  let runReads = 0;
  const runs = Array.from({ length: 100 }, (_, index) => ({
    ...run,
    get id() {
      runReads++;
      return RunId.make(`run-${index}`);
    },
  }));
  const items = Array.from({ length: 1000 }, (_, index) =>
    commandItem(`item-${index}`, "before", index),
  );
  const projection = {
    ...emptyProjection,
    runs,
    turnItems: items,
    visibleTurnItems: items.map((item, position) => ({
      item,
      position,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: item.id,
    })),
  };
  const payload = commandItem("item-999", "after", 999);
  const next = applyOrchestrationV2ProjectionEvent(projection, {
    id: "stream-update",
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload,
  } as OrchestrationV2DomainEvent);
  expect(next?.visibleTurnItems.at(-1)?.item).toBe(payload);
  expect(next?.visibleTurnItems[0]).toBe(projection.visibleTurnItems[0]);
  expect(runReads).toBeLessThanOrEqual(100);
});
