import { assert, it } from "@effect/vitest";
import {
  CommandId,
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
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

it.effect.each(
  (["codex", "claudeAgent"] as const).flatMap((driverName) => {
    const driver = ProviderDriverKind.make(driverName);
    const instanceId = ProviderInstanceId.make(driver);
    const modelSelection = { instanceId, model: "test-model" };
    const adapter: ProviderAdapterV2Shape = {
      instanceId,
      driver,
      getCapabilities: () =>
        Effect.succeed(
          driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
        ),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Execution is paused after dispatch for handoff inspection"),
    };
    const layer = makeOrchestratorV2ReplayLayerWithRegistry(
      { name: `fork-boundary-${driver}` },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { runEffectWorker: false },
    );
    return [
      ...(["live", "deleted", "source"] as const).map(
        (destinationState) =>
          ({
            caseTitle: `preserves ${driver} fork identities for a ${destinationState} destination`,
            run: () =>
              Effect.gen(function* () {
                const orchestrator = yield* Orchestrator.OrchestratorV2;
                const eventSink = yield* EventSink.EventSinkV2;
                const now = yield* DateTime.now;
                const sourceThreadId = ThreadId.make("immutable-native-source");
                const occupiedThreadId =
                  destinationState === "source"
                    ? sourceThreadId
                    : ThreadId.make("immutable-native-occupied");
                const freshThreadId = ThreadId.make("immutable-native-fresh");
                const sourceRunId = RunId.make("immutable-native-source-run");
                for (const threadId of new Set([sourceThreadId, occupiedThreadId])) {
                  const runId =
                    threadId === sourceThreadId
                      ? sourceRunId
                      : RunId.make("immutable-native-occupied-run");
                  const messageId = MessageId.make(`history:${threadId}`);
                  yield* orchestrator.dispatch({
                    type: "thread.create",
                    commandId: CommandId.make(`create:${threadId}`),
                    threadId,
                    projectId: ProjectId.make("immutable-native-project"),
                    title: `History ${threadId}`,
                    modelSelection,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: null,
                    createdBy: "user",
                    creationSource: "web",
                  });
                  yield* eventSink.write({
                    events: [
                      {
                        id: EventId.make(`run:${threadId}`),
                        type: "run.created",
                        threadId,
                        runId,
                        occurredAt: now,
                        payload: {
                          id: runId,
                          threadId,
                          ordinal: 1,
                          providerInstanceId: instanceId,
                          modelSelection,
                          providerThreadId: null,
                          userMessageId: messageId,
                          rootNodeId: null,
                          activeAttemptId: null,
                          status: "completed",
                          queuePosition: null,
                          requestedAt: now,
                          startedAt: now,
                          completedAt: now,
                          checkpointId: null,
                          contextHandoffId: null,
                        },
                      },
                      {
                        id: EventId.make(`item:${threadId}`),
                        type: "turn-item.updated",
                        threadId,
                        runId,
                        occurredAt: now,
                        payload: {
                          id: TurnItemId.make(`item:${threadId}`),
                          threadId,
                          runId,
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
                          type: "user_message",
                          createdBy: "user",
                          creationSource: "web",
                          inputIntent: "turn_start",
                          messageId,
                          text: `Immutable history ${threadId}`,
                          attachments: [],
                        },
                      },
                    ],
                  });
                }
                if (destinationState === "deleted")
                  yield* orchestrator.dispatch({
                    type: "thread.delete",
                    commandId: CommandId.make("delete-occupied"),
                    threadId: occupiedThreadId,
                  });
                const sourceBefore = yield* orchestrator.getThreadProjection(sourceThreadId);
                const occupiedBefore = yield* orchestrator.getThreadProjection(occupiedThreadId);
                const rejected = yield* orchestrator
                  .dispatch({
                    type: "thread.fork",
                    commandId: CommandId.make("reject-identity-reuse"),
                    sourceThreadId,
                    targetThreadId: occupiedThreadId,
                    sourcePoint: { type: "run", runId: sourceRunId },
                    createdBy: "user",
                    creationSource: "web",
                  })
                  .pipe(Effect.flip);
                assert.equal(rejected._tag, "OrchestratorCommandRejectedError");
                assert.deepEqual(
                  yield* orchestrator.getThreadProjection(sourceThreadId),
                  sourceBefore,
                );
                assert.deepEqual(
                  yield* orchestrator.getThreadProjection(occupiedThreadId),
                  occupiedBefore,
                );
                const command = {
                  type: "thread.fork" as const,
                  commandId: CommandId.make("fresh-identity"),
                  sourceThreadId,
                  targetThreadId: freshThreadId,
                  sourcePoint: { type: "run" as const, runId: sourceRunId },
                  createdBy: "user" as const,
                  creationSource: "web" as const,
                };
                const first = yield* orchestrator.dispatch(command);
                const fresh = yield* orchestrator.getThreadProjection(freshThreadId);
                const retried = yield* orchestrator.dispatch(command);
                assert.equal(retried.sequence, first.sequence);
                assert.deepEqual(yield* orchestrator.getThreadProjection(freshThreadId), fresh);
                assert.equal(fresh.thread.lineage.parentThreadId, sourceThreadId);
                assert.equal(fresh.thread.lineage.relationshipToParent, "fork");
                assert.isNull(fresh.thread.deletedAt);
                assert.lengthOf(fresh.contextTransfers, 1);
                assert.lengthOf(fresh.runs, 0);
                // The fork shows the source's items by reference, frozen.
                const inheritedRows = fresh.visibleTurnItems.filter(
                  (row) => row.visibility === "inherited",
                );
                const copied = inheritedRows.map((row) => row.item);
                assert.deepEqual(
                  inheritedRows.map((row) => [row.sourceThreadId, row.sourceItemId]),
                  sourceBefore.visibleTurnItems.map((row) => [sourceThreadId, row.item.id]),
                );
                assert.deepEqual(
                  copied.map((item) => item.type),
                  sourceBefore.visibleTurnItems.map((row) => row.item.type),
                );
                assert.isTrue(
                  copied.every(
                    (item) =>
                      item.inheritedFrom?.threadId === sourceThreadId && item.runId === null,
                  ),
                );
                const boundary = fresh.turnItems.filter((item) => item.inheritedFrom === undefined);
                assert.lengthOf(boundary, 1);
                assert.equal(boundary[0]?.type, "fork");
                if (boundary[0]?.type !== "fork")
                  return assert.fail("Expected destination boundary");
                assert.equal(boundary[0].id, TurnItemId.make(`turn-item:fork:${freshThreadId}`));
                assert.equal(boundary[0].ordinal, copied.at(-1)!.ordinal + 1);
                assert.deepEqual(boundary[0].source, {
                  type: "run",
                  threadId: sourceThreadId,
                  runId: sourceRunId,
                });
                assert.equal(boundary[0].targetThreadId, freshThreadId);
                assert.isNull(boundary[0].nodeId);
                assert.isNull(boundary[0].providerTurnId);
                assert.isNull(boundary[0].nativeItemRef);
                assert.isUndefined(boundary[0].providerThreadId);
                assert.isTrue(
                  fresh.turnItems.every(
                    (item) => item.runId === null && item.threadId === freshThreadId,
                  ),
                );
                assert.isNull(fresh.thread.forkedFrom);
                assert.equal(fresh.thread.conversationFork?.sourceThreadId, sourceThreadId);
                assert.lengthOf(fresh.providerSessions, 0);
                const sourceAfter = yield* orchestrator.getThreadProjection(sourceThreadId);
                // The new fork adds its legitimate outgoing relation to the source
                // read model; all original identity, history and execution state stay intact.
                assert.deepEqual(
                  { ...sourceAfter, contextTransfers: sourceBefore.contextTransfers },
                  sourceBefore,
                );
                if (destinationState === "live") {
                  const opposite = yield* Effect.all(
                    [
                      orchestrator
                        .dispatch({
                          ...command,
                          commandId: CommandId.make("opposite-fork-forward"),
                          targetThreadId: occupiedThreadId,
                        })
                        .pipe(Effect.exit),
                      orchestrator
                        .dispatch({
                          ...command,
                          commandId: CommandId.make("opposite-fork-reverse"),
                          sourceThreadId: occupiedThreadId,
                          targetThreadId: sourceThreadId,
                        })
                        .pipe(Effect.exit),
                    ],
                    { concurrency: 2 },
                  ).pipe(Effect.timeout("5 seconds"));
                  assert.isTrue(opposite.every(Exit.isFailure));
                  const racedTargetId = ThreadId.make("native-fork-delete-race-target");
                  const racedCommand = {
                    ...command,
                    commandId: CommandId.make("native-fork-delete-race"),
                    targetThreadId: racedTargetId,
                  };
                  const [forked, deleted] = yield* Effect.all(
                    [
                      orchestrator.dispatch(racedCommand).pipe(Effect.exit),
                      orchestrator
                        .dispatch({
                          type: "thread.delete",
                          commandId: CommandId.make("delete-fork-source-race"),
                          threadId: sourceThreadId,
                        })
                        .pipe(Effect.exit),
                    ],
                    { concurrency: 2 },
                  ).pipe(Effect.timeout("5 seconds"));
                  assert.isTrue(Exit.isSuccess(deleted));
                  if (Exit.isSuccess(forked)) {
                    const owned = yield* orchestrator.getThreadProjection(racedTargetId);
                    assert.isTrue(
                      owned.turnItems.every(
                        (item) => item.threadId === racedTargetId && item.runId === null,
                      ),
                    );
                    const racedRows = owned.visibleTurnItems.filter(
                      (row) => row.visibility === "inherited",
                    );
                    const racedPrefix = racedRows.map((row) => row.item);
                    assert.deepEqual(
                      racedRows.map((row) => [row.sourceThreadId, row.sourceItemId]),
                      sourceBefore.visibleTurnItems.map((row) => [sourceThreadId, row.item.id]),
                    );
                    assert.isTrue(
                      racedPrefix.every(
                        (item) =>
                          item.inheritedFrom?.threadId === sourceThreadId && item.runId === null,
                      ),
                    );
                    assert.deepEqual(
                      racedPrefix.map((item) => item.type),
                      sourceBefore.visibleTurnItems.map((row) => row.item.type),
                    );
                    const racedBoundary = owned.turnItems.filter(
                      (item) => item.inheritedFrom === undefined,
                    );
                    assert.lengthOf(racedBoundary, 1);
                    if (racedBoundary[0]?.type !== "fork")
                      return assert.fail("Expected raced destination boundary");
                    assert.equal(
                      racedBoundary[0].id,
                      TurnItemId.make(`turn-item:fork:${racedTargetId}`),
                    );
                    assert.equal(racedBoundary[0].ordinal, racedPrefix.at(-1)!.ordinal + 1);
                    assert.deepEqual(racedBoundary[0].source, {
                      type: "run",
                      threadId: sourceThreadId,
                      runId: sourceRunId,
                    });
                    assert.equal(racedBoundary[0].targetThreadId, racedTargetId);
                    assert.isNull(racedBoundary[0].nodeId);
                    assert.isNull(racedBoundary[0].providerTurnId);
                    assert.isNull(racedBoundary[0].nativeItemRef);
                    assert.isUndefined(racedBoundary[0].providerThreadId);
                    assert.equal(
                      (yield* orchestrator.dispatch(racedCommand)).sequence,
                      forked.value.sequence,
                    );
                  } else {
                    assert.isTrue(
                      Exit.isFailure(
                        yield* orchestrator.getThreadProjection(racedTargetId).pipe(Effect.exit),
                      ),
                    );
                  }
                }
                assert.deepEqual(sourceAfter.contextTransfers, fresh.contextTransfers);
                assert.equal(sourceAfter.contextTransfers[0]?.type, "fork");
                assert.equal(sourceAfter.contextTransfers[0]?.sourceThreadId, sourceThreadId);
                assert.equal(sourceAfter.contextTransfers[0]?.targetThreadId, freshThreadId);
                if (occupiedThreadId !== sourceThreadId)
                  assert.deepEqual(
                    yield* orchestrator.getThreadProjection(occupiedThreadId),
                    occupiedBefore,
                  );
              }).pipe(Effect.provide(layer)),
          }) as const,
      ),
      ...(["failed", "interrupted", "cancelled"] as const).map(
        (status) =>
          ({
            caseTitle: `bounds ${driver} context when continuing a fork of a ${status} run`,
            run: () =>
              Effect.gen(function* () {
                const orchestrator = yield* Orchestrator.OrchestratorV2;
                const eventSink = yield* EventSink.EventSinkV2;
                const now = yield* DateTime.now;
                const sourceThreadId = ThreadId.make("fork-boundary-source");
                const targetThreadId = ThreadId.make("fork-boundary-target");
                const providerThreadId = ProviderThreadId.make("fork-boundary-native-thread");
                const sourceRunId = RunId.make("fork-boundary-source-run");
                const attemptId = RunAttemptId.make("interrupted-source-attempt");
                const providerTurnId = ProviderTurnId.make("interrupted-source-turn");
                const rootNodeId = NodeId.make("interrupted-source-root");

                yield* orchestrator.dispatch({
                  type: "thread.create",
                  commandId: CommandId.make("create-source"),
                  threadId: sourceThreadId,
                  projectId: ProjectId.make("fork-boundary-project"),
                  title: "Fork boundary source",
                  modelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  createdBy: "user",
                  creationSource: "web",
                });
                yield* eventSink.write({
                  events: [
                    {
                      id: EventId.make("source-provider-thread"),
                      type: "provider-thread.updated",
                      threadId: sourceThreadId,
                      occurredAt: now,
                      payload: {
                        id: providerThreadId,
                        driver,
                        providerInstanceId: instanceId,
                        providerSessionId: null,
                        appThreadId: sourceThreadId,
                        ownerNodeId: null,
                        nativeThreadRef: { driver, nativeId: "native-source", strength: "strong" },
                        nativeConversationHeadRef: null,
                        status: "idle",
                        firstRunOrdinal: 1,
                        lastRunOrdinal: 2,
                        handoffIds: [],
                        forkedFrom: null,
                        createdAt: now,
                        updatedAt: now,
                      },
                    },
                  ],
                });
                // A cancelled queue entry has no provider turn; an early interruption
                // can have a turn but no native assistant cursor.
                if (status === "interrupted") {
                  yield* eventSink.write({
                    events: [
                      {
                        id: EventId.make("source-attempt"),
                        type: "run-attempt.created",
                        threadId: sourceThreadId,
                        runId: sourceRunId,
                        occurredAt: now,
                        payload: {
                          id: attemptId,
                          runId: sourceRunId,
                          attemptOrdinal: 1,
                          rootNodeId,
                          providerInstanceId: instanceId,
                          providerThreadId,
                          providerTurnId,
                          reason: "initial",
                          status,
                          startedAt: now,
                          completedAt: now,
                        },
                      },
                      {
                        id: EventId.make("source-provider-turn"),
                        type: "provider-turn.updated",
                        threadId: sourceThreadId,
                        occurredAt: now,
                        payload: {
                          id: providerTurnId,
                          providerThreadId,
                          nodeId: rootNodeId,
                          runAttemptId: attemptId,
                          nativeTurnRef: { driver, nativeId: "turn:synthetic", strength: "weak" },
                          ordinal: 1,
                          status,
                          startedAt: now,
                          completedAt: now,
                        },
                      },
                    ],
                  });
                }
                for (const ordinal of [1, 2]) {
                  const runId = ordinal === 1 ? sourceRunId : RunId.make("later-run");
                  const messageId = MessageId.make(`source-message-${ordinal}`);
                  yield* eventSink.write({
                    events: [
                      {
                        id: EventId.make(`run-${ordinal}`),
                        type: "run.created",
                        threadId: sourceThreadId,
                        runId,
                        occurredAt: now,
                        payload: {
                          id: runId,
                          threadId: sourceThreadId,
                          ordinal,
                          providerInstanceId: instanceId,
                          modelSelection,
                          providerThreadId,
                          userMessageId: messageId,
                          rootNodeId: null,
                          activeAttemptId:
                            ordinal === 1 && status === "interrupted" ? attemptId : null,
                          status: ordinal === 1 ? status : "completed",
                          queuePosition: null,
                          requestedAt: now,
                          startedAt: now,
                          completedAt: now,
                          checkpointId: null,
                          contextHandoffId: null,
                        },
                      },
                      {
                        id: EventId.make(`item-${ordinal}`),
                        type: "turn-item.updated",
                        threadId: sourceThreadId,
                        runId,
                        occurredAt: now,
                        payload: {
                          id: TurnItemId.make(`item-${ordinal}`),
                          threadId: sourceThreadId,
                          runId,
                          nodeId: null,
                          providerThreadId,
                          providerTurnId: null,
                          nativeItemRef: null,
                          parentItemId: null,
                          ordinal,
                          status: "completed",
                          title: null,
                          startedAt: now,
                          completedAt: now,
                          updatedAt: now,
                          type: "user_message",
                          createdBy: "user",
                          creationSource: "web",
                          inputIntent: "turn_start",
                          messageId,
                          text: ordinal === 1 ? "INCLUDED_SOURCE_MARKER" : "EXCLUDED_LATER_MARKER",
                          attachments: [],
                        },
                      },
                    ],
                  });
                }
                yield* orchestrator.dispatch({
                  type: "thread.fork",
                  commandId: CommandId.make("fork-source"),
                  sourceThreadId,
                  targetThreadId,
                  sourcePoint: { type: "run", runId: sourceRunId },
                  createdBy: "user",
                  creationSource: "web",
                });
                yield* orchestrator.dispatch({
                  type: "message.dispatch",
                  commandId: CommandId.make("continue-fork"),
                  threadId: targetThreadId,
                  messageId: MessageId.make("continue-fork"),
                  text: "Continue from the selected source run",
                  attachments: [],
                  modelSelection,
                  dispatchMode: { type: "start_immediately" },
                  createdBy: "user",
                  creationSource: "web",
                });
                const target = yield* orchestrator.getThreadProjection(targetThreadId);
                assert.equal(target.contextTransfers[0]?.resolution?.strategy, "portable_context");
                assert.lengthOf(target.contextHandoffs, 1);
                const handoff = target.contextHandoffs[0]!;
                const history =
                  handoff.history?.messages.map((message) => message.text).join("\n") ?? "";
                assert.include(`${handoff.summaryText}\n${history}`, "INCLUDED_SOURCE_MARKER");
                assert.notInclude(`${handoff.summaryText}\n${history}`, "EXCLUDED_LATER_MARKER");
                assert.isNull(target.providerThreads[0]?.forkedFrom);
              }).pipe(Effect.provide(layer)),
          }) as const,
      ),
    ];
  }),
)("$caseTitle", ({ run }) => run());
