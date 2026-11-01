import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
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
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const forkCases = (["codex", "claudeAgent"] as const).map((driverName) => {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "test-model" };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () =>
      Effect.succeed(
        driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Execution is paused after dispatch for handoff inspection"),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: `fork-boundary-${driver}` },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false },
  );
  return { driver, instanceId, modelSelection, layer };
});

it.effect("a persisted fork leaves PR watching with its parent until explicitly opted in", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { instanceId, modelSelection } = forkCases[0]!;
    const sourceThreadId = ThreadId.make("fork-watch-source");
    const targetThreadId = ThreadId.make("fork-watch-target");
    const sourceRunId = RunId.make("fork-watch-source-run");
    const key = { host: "github.com", repository: "example/repo", number: 1 };
    const link = { url: "https://github.com/example/repo/pull/1", source: "agent" as const };

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("fork-watch-create"),
      threadId: sourceThreadId,
      projectId: ProjectId.make("fork-watch-project"),
      title: "Watching source",
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
          id: EventId.make("fork-watch-source-run"),
          type: "run.created",
          threadId: sourceThreadId,
          runId: sourceRunId,
          occurredAt: now,
          payload: {
            id: sourceRunId,
            threadId: sourceThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("fork-watch-source-message"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-parent-start"),
      threadId: sourceThreadId,
      ...key,
      watching: true,
      link,
    });
    const parentBefore = yield* orchestrator.getThreadShell(sourceThreadId);
    const parentWatch = parentBefore?.pullRequests?.[0]?.watch;
    assert.isDefined(parentWatch);
    assert.lengthOf(parentBefore?.pendingBackgroundTasks ?? [], 1);

    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork-watch-fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "run", runId: sourceRunId },
      createdBy: "user",
      creationSource: "mcp",
    });
    const fork = yield* orchestrator.getThreadShell(targetThreadId);
    assert.isNotNull(fork);
    assert.deepEqual(fork.pullRequests, [
      {
        ...key,
        ...link,
        linkedAt: parentWatch.startedAt,
        snapshot: null,
        stack: null,
      },
    ]);
    assert.deepEqual(fork.pendingBackgroundTasks, []);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);

    const stale = yield* orchestrator
      .dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("fork-watch-stale-sync"),
        threadId: targetThreadId,
        ...key,
        startedAt: parentWatch.startedAt,
        watch: parentWatch,
        wake: {
          messageId: MessageId.make("fork-watch-unwanted-wake"),
          text: "A check failed",
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "A check failed",
          },
        },
      })
      .pipe(Effect.flip);
    assert.equal(stale._tag, "OrchestratorDispatchError");
    assert.deepEqual((yield* orchestrator.getThreadProjection(targetThreadId)).runs, []);

    yield* TestClock.adjust("1 second");
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-opt-in"),
      threadId: targetThreadId,
      ...key,
      watching: true,
      link,
    });
    const watchingFork = yield* orchestrator.getThreadShell(targetThreadId);
    assert.isDefined(watchingFork?.pullRequests?.[0]?.watch);
    assert.notEqual(watchingFork.pullRequests[0].watch.startedAt, parentWatch.startedAt);
    assert.lengthOf(watchingFork.pendingBackgroundTasks ?? [], 1);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);

    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-opt-out"),
      threadId: targetThreadId,
      ...key,
      watching: false,
    });
    const stoppedFork = yield* orchestrator.getThreadShell(targetThreadId);
    const [forkLink] = fork.pullRequests ?? [];
    assert.isDefined(forkLink);
    assert.deepEqual(stoppedFork?.pullRequests, [
      { ...forkLink, endedWatch: watchingFork.pullRequests[0].watch },
    ]);
    assert.deepEqual(stoppedFork?.pendingBackgroundTasks, []);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect.each(
  forkCases.flatMap((forkCase) =>
    (["live", "deleted", "source"] as const).map((destinationState) => ({
      ...forkCase,
      destinationState,
    })),
  ),
)(
  "preserves $driver fork identities for a $destinationState destination",
  ({ destinationState, instanceId, modelSelection, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("immutable-native-source");
      const occupiedThreadId =
        destinationState === "source" ? sourceThreadId : ThreadId.make("immutable-native-occupied");
      const freshThreadId = ThreadId.make("immutable-native-fresh");
      const sourceRunId = RunId.make("immutable-native-source-run");
      for (const threadId of new Set([sourceThreadId, occupiedThreadId])) {
        const runId =
          threadId === sourceThreadId ? sourceRunId : RunId.make("immutable-native-occupied-run");
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
      assert.deepEqual(yield* orchestrator.getThreadProjection(sourceThreadId), sourceBefore);
      assert.deepEqual(yield* orchestrator.getThreadProjection(occupiedThreadId), occupiedBefore);
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
      const inheritedRows = fresh.visibleTurnItems.filter((row) => row.visibility === "inherited");
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
          (item) => item.inheritedFrom?.threadId === sourceThreadId && item.runId === null,
        ),
      );
      const boundary = fresh.turnItems.filter((item) => item.inheritedFrom === undefined);
      assert.lengthOf(boundary, 1);
      assert.equal(boundary[0]?.type, "fork");
      if (boundary[0]?.type !== "fork") return assert.fail("Expected destination boundary");
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
        fresh.turnItems.every((item) => item.runId === null && item.threadId === freshThreadId),
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
            owned.turnItems.every((item) => item.threadId === racedTargetId && item.runId === null),
          );
          const racedRows = owned.visibleTurnItems.filter((row) => row.visibility === "inherited");
          const racedPrefix = racedRows.map((row) => row.item);
          assert.deepEqual(
            racedRows.map((row) => [row.sourceThreadId, row.sourceItemId]),
            sourceBefore.visibleTurnItems.map((row) => [sourceThreadId, row.item.id]),
          );
          assert.isTrue(
            racedPrefix.every(
              (item) => item.inheritedFrom?.threadId === sourceThreadId && item.runId === null,
            ),
          );
          assert.deepEqual(
            racedPrefix.map((item) => item.type),
            sourceBefore.visibleTurnItems.map((row) => row.item.type),
          );
          const racedBoundary = owned.turnItems.filter((item) => item.inheritedFrom === undefined);
          assert.lengthOf(racedBoundary, 1);
          if (racedBoundary[0]?.type !== "fork")
            return assert.fail("Expected raced destination boundary");
          assert.equal(racedBoundary[0].id, TurnItemId.make(`turn-item:fork:${racedTargetId}`));
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
        assert.deepEqual(yield* orchestrator.getThreadProjection(occupiedThreadId), occupiedBefore);
    }).pipe(Effect.provide(layer)),
);

it.effect.each(
  forkCases.flatMap((forkCase) =>
    (["failed", "interrupted", "cancelled"] as const).map((status) => ({
      ...forkCase,
      status,
    })),
  ),
)(
  "bounds $driver context when continuing a fork of a $status run",
  ({ driver, status, instanceId, modelSelection, layer }) =>
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
      const grandparentThreadId = ThreadId.make("fork-boundary-grandparent");
      const grandparentRunId = RunId.make("fork-boundary-grandparent-run");

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-grandparent"),
        threadId: grandparentThreadId,
        projectId: ProjectId.make("fork-boundary-project"),
        title: "Fork boundary grandparent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* writeParentRun({
        threadId: grandparentThreadId,
        runId: RunId.make("fork-boundary-grandparent-rolled-back-run"),
        ordinal: 1,
        status: "rolled_back",
        text: "ROLLED_BACK_MARKER",
      });
      yield* writeParentRun({
        threadId: grandparentThreadId,
        runId: grandparentRunId,
        ordinal: 2,
        status: "completed",
        text: "GRANDPARENT_MARKER",
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-grandparent"),
        sourceThreadId: grandparentThreadId,
        targetThreadId: sourceThreadId,
        sourcePoint: { type: "run", runId: grandparentRunId },
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
              firstRunOrdinal: 2,
              lastRunOrdinal: 3,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
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
      yield* writeParentRun({
        threadId: sourceThreadId,
        runId: RunId.make("fork-boundary-source-rolled-back-run"),
        ordinal: 1,
        status: "rolled_back",
        text: "SOURCE_ROLLED_BACK_MARKER",
      });
      for (const ordinal of [2, 3]) {
        const runId = ordinal === 2 ? sourceRunId : RunId.make("later-run");
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
                activeAttemptId: ordinal === 2 && status === "interrupted" ? attemptId : null,
                status: ordinal === 2 ? status : "completed",
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
                text: ordinal === 2 ? "INCLUDED_SOURCE_MARKER" : "EXCLUDED_LATER_MARKER",
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
      const retained = yield* (yield* ProjectionStoreV2).resolveContextHistory({
        handoffs: [handoff],
        coverage: handoff.history?.coverage ?? "Retained fork",
        budget: 1_000_000,
        alreadyDeliveredItemIds: new Set(),
      });
      const history = retained.messages.map((message) => message.text).join("\n");
      assert.include(`${handoff.summaryText}\n${history}`, "GRANDPARENT_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "SOURCE_ROLLED_BACK_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "ROLLED_BACK_MARKER");
      assert.include(`${handoff.summaryText}\n${history}`, "INCLUDED_SOURCE_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "EXCLUDED_LATER_MARKER");
      assert.isNull(target.providerThreads[0]?.forkedFrom);
    }).pipe(Effect.provide(layer)),
);

// SCIENT-FORK:START — Scient forks natively only with exact native boundary evidence
// This fixture lacks that evidence, so its same-provider fork carries frozen portable history.
// Handoff retains history by reference, including oversized messages.
it.effect.each([{ name: "same-provider", sameProvider: true }] as const)(
  "a $name fork's first /compact compacts its inherited history",
  ({ name, sameProvider }) => {
    const messageLength = 17_000;
    // SCIENT-FORK:END
    const opened: Array<ProviderInstanceId> = [];
    const adapter = (driverName: "claudeAgent" | "codex") => {
      const driver = ProviderDriverKind.make(driverName);
      const instanceId = ProviderInstanceId.make(driverName);
      return {
        instanceId,
        driver,
        getCapabilities: () =>
          Effect.succeed(
            driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
          ),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.sync(() => opened.push(instanceId)).pipe(
            Effect.andThen(
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
              }),
            ),
          ),
      } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
    };
    const claude = adapter("claudeAgent");
    // SCIENT-FORK:START
    const target = sameProvider ? claude : adapter("codex");
    // SCIENT-FORK:END
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("fork-compact-source");
      const targetThreadId = ThreadId.make("fork-compact-target");
      const providerThreadId = ProviderThreadId.make("fork-compact-native-thread");
      const sourceRunId = RunId.make("fork-compact-source-run");
      const userMessageId = MessageId.make("fork-compact-source-message");
      const sourceSelection = { instanceId: claude.instanceId, model: "test-model" };

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("fork-compact-create-source"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("fork-compact-project"),
        title: "Fork compact source",
        modelSelection: sourceSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const item = {
        threadId: sourceThreadId,
        runId: sourceRunId,
        nodeId: null,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      } as const;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("fork-compact-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver: claude.driver,
              providerInstanceId: claude.instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver: claude.driver,
                nativeId: "native-fork-compact-source",
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("fork-compact-source-run"),
            type: "run.created",
            threadId: sourceThreadId,
            runId: sourceRunId,
            occurredAt: now,
            payload: {
              id: sourceRunId,
              threadId: sourceThreadId,
              ordinal: 1,
              providerInstanceId: claude.instanceId,
              modelSelection: sourceSelection,
              providerThreadId,
              userMessageId,
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
          // SCIENT-FORK:START — a sent user message has its conversation record.
          {
            id: EventId.make("fork-compact-user-message"),
            type: "message.updated",
            threadId: sourceThreadId,
            runId: sourceRunId,
            occurredAt: now,
            payload: {
              id: userMessageId,
              threadId: sourceThreadId,
              runId: sourceRunId,
              nodeId: null,
              role: "user",
              text: "u".repeat(messageLength),
              attachments: [],
              streaming: false,
              createdBy: "user",
              creationSource: "web",
              createdAt: now,
              updatedAt: now,
            },
          },
          // SCIENT-FORK:END
          // Each message alone exceeds the default 16k handoff budget, so a
          // portable handoff omits both whole items.
          {
            id: EventId.make("fork-compact-user-item"),
            type: "turn-item.updated",
            threadId: sourceThreadId,
            runId: sourceRunId,
            occurredAt: now,
            payload: {
              ...item,
              id: TurnItemId.make("fork-compact-user-item"),
              ordinal: 1,
              type: "user_message",
              createdBy: "user",
              creationSource: "web",
              inputIntent: "turn_start",
              messageId: userMessageId,
              text: "u".repeat(messageLength),
              attachments: [],
            },
          },
          {
            id: EventId.make("fork-compact-assistant-item"),
            type: "turn-item.updated",
            threadId: sourceThreadId,
            runId: sourceRunId,
            occurredAt: now,
            payload: {
              ...item,
              id: TurnItemId.make("fork-compact-assistant-item"),
              ordinal: 2,
              type: "assistant_message",
              messageId: MessageId.make("fork-compact-assistant-message"),
              text: "a".repeat(messageLength),
              streaming: false,
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-compact-fork"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("fork-compact-compact"),
        threadId: targetThreadId,
        messageId: MessageId.make("fork-compact-compact"),
        text: "/compact",
        attachments: [],
        modelSelection: { instanceId: target.instanceId, model: "test-model" },
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();

      const projection = yield* orchestrator.getThreadProjection(targetThreadId);
      // SCIENT-FORK:START
      assert.equal(projection.contextTransfers[0]?.resolution?.strategy, "portable_context");
      assert.equal(projection.contextHandoffs[0]?.historySource?.itemCount, 2);
      const rejected = false;
      // SCIENT-FORK:END
      const emptyCompaction = projection.turnItems.some(
        (turnItem) =>
          turnItem.type === "error" &&
          turnItem.failure.message === "Start a conversation before compacting this thread.",
      );
      assert.equal(emptyCompaction, rejected);
      assert.deepEqual(opened, rejected ? [] : [target.instanceId]);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: `fork-compact-${name.replaceAll(" ", "-")}` },
          ProviderAdapterRegistry.layerFromAdapters(
            target === claude ? [claude] : [claude, target],
          ),
        ),
      ),
    );
  },
);

const writeParentRun = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  /** Preparing, failed, and interrupted runs asked for a new worktree. */
  readonly status:
    | "preparing"
    | "running"
    | "queued"
    | "completed"
    | "rolled_back"
    | "failed"
    | "interrupted"
    | "cancelled";
  readonly text: string;
  /** A checkpointed run on a native provider thread, which `latest_stable` forks start from. */
  readonly stable?: boolean;
  readonly inputIntent?: "turn_start" | "queued_turn";
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { driver, instanceId, modelSelection } = forkCases[0]!;
    const messageId = MessageId.make(`${input.runId}:message`);
    const providerThreadId = input.stable
      ? ProviderThreadId.make(`${input.runId}:provider-thread`)
      : null;
    yield* eventSink.write({
      events: [
        ...(providerThreadId === null
          ? []
          : [
              {
                id: EventId.make(`${input.runId}:provider-thread`),
                type: "provider-thread.updated" as const,
                threadId: input.threadId,
                occurredAt: now,
                payload: {
                  id: providerThreadId,
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: null,
                  appThreadId: input.threadId,
                  ownerNodeId: null,
                  nativeThreadRef: {
                    driver,
                    nativeId: `${input.runId}:native`,
                    strength: "strong" as const,
                  },
                  nativeConversationHeadRef: null,
                  status: "idle" as const,
                  firstRunOrdinal: input.ordinal,
                  lastRunOrdinal: input.ordinal,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ]),
        {
          id: EventId.make(`${input.runId}:created`),
          type: "run.created",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: input.ordinal,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: messageId,
            rootNodeId: null,
            activeAttemptId: null,
            status: input.status,
            queuePosition: null,
            requestedAt: now,
            startedAt: now,
            completedAt: input.status === "completed" ? now : null,
            checkpointId: input.stable ? CheckpointId.make(`${input.runId}:checkpoint`) : null,
            contextHandoffId: null,
            ...(input.status === "preparing" ||
            input.status === "failed" ||
            input.status === "interrupted"
              ? { workspacePreparation: { type: "worktree" as const, baseRef: "main" } }
              : {}),
          },
        },
        {
          id: EventId.make(`${input.runId}:item`),
          type: "turn-item.updated",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`${input.runId}:item`),
            threadId: input.threadId,
            runId: input.runId,
            nodeId: null,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: input.ordinal * 100,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            createdBy: "user",
            creationSource: "web",
            inputIntent: input.inputIntent ?? "turn_start",
            messageId,
            text: input.text,
            attachments: [],
          },
        },
      ],
    });
  });

/** Marks `threadId` as imported from V1 and gives it one runless imported user message. */
const writeImportedHistory = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { thread } = yield* orchestrator.getThreadProjection(threadId);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${threadId}:imported`),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: { ...thread, historyOrigin: "v1_import" },
        },
        {
          id: EventId.make(`${threadId}:imported-item`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`${threadId}:imported-item`),
            threadId,
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
            type: "user_message",
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            messageId: MessageId.make(`${threadId}:imported-message`),
            text,
            attachments: [],
          },
        },
      ],
    });
  });

const createParent = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId: ProjectId.make("side-chat-project"),
      title: "Side chat parent",
      modelSelection: forkCases[0]!.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const forkSideChat = (commandId: string, sourceThreadId: ThreadId, targetThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make(commandId),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "latest_stable" },
      sideChat: true,
      createdBy: "user",
      creationSource: "web",
    });
  });

const askSideChat = (threadId: ThreadId, commandId: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(commandId),
      threadId,
      messageId: MessageId.make(commandId),
      text: "What is the main thread doing?",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("resolves an explicit checkpoint fork to its source run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const parentId = ThreadId.make("checkpoint-fork-parent");
    const childId = ThreadId.make("checkpoint-fork-child");
    const runId = RunId.make("checkpoint-fork-run");
    const checkpointId = CheckpointId.make("checkpoint-fork-checkpoint");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId,
      ordinal: 1,
      status: "completed",
      text: "Work",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("checkpoint-fork-captured"),
          type: "checkpoint.captured",
          threadId: parentId,
          occurredAt: now,
          payload: {
            id: checkpointId,
            threadId: parentId,
            scopeId: CheckpointScopeId.make("checkpoint-fork-scope"),
            runId,
            nodeId: NodeId.make("checkpoint-fork-node"),
            parentCheckpointId: null,
            ordinalWithinScope: 1,
            appRunOrdinal: 1,
            ref: CheckpointRef.make("refs/t3/checkpoint-fork/1"),
            status: "ready",
            files: [],
            capturedAt: now,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("checkpoint-fork"),
      sourceThreadId: parentId,
      targetThreadId: childId,
      sourcePoint: { type: "checkpoint", checkpointId },
      createdBy: "user",
      creationSource: "mcp",
    });
    // SCIENT-FORK: a Scient fork has no `forkedFrom`; its transfer names the source run.
    const child = yield* orchestrator.getThreadProjection(childId);
    assert.equal(child.contextTransfers[0]?.sourcePoint.runId, runId);
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat of an idle parent still starts with the framing note", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("side-chat-idle-parent");
    const sideChatId = ThreadId.make("side-chat-idle-child");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-idle-parent-run"),
      ordinal: 1,
      status: "completed",
      text: "Parent work",
      stable: true,
    });

    yield* forkSideChat("side-chat-idle-fork", parentId, sideChatId);
    yield* askSideChat(sideChatId, "side-chat-idle-first-message");

    const started = yield* orchestrator.getThreadProjection(sideChatId);
    assert.isNotNull(started.providerThreads[0]?.forkedFrom);
    assert.lengthOf(started.contextHandoffs, 1);
    const [handoff] = started.contextHandoffs;
    assert.isTrue(
      handoff!.summaryText.startsWith("You are in a side chat beside the main thread."),
    );
    assert.notInclude(handoff!.summaryText, "Main thread activity");
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat waits for the parent's new worktree, also after its setup ended", () =>
  Effect.gen(function* () {
    for (const status of ["preparing", "failed", "interrupted"] as const) {
      const parentId = ThreadId.make(`side-chat-worktree-parent-${status}`);
      yield* createParent(parentId);
      yield* writeParentRun({
        threadId: parentId,
        runId: RunId.make(`side-chat-worktree-parent-run-${status}`),
        ordinal: 1,
        status,
        text: "Parent work",
      });

      const rejected = yield* forkSideChat(
        `side-chat-worktree-fork-${status}`,
        parentId,
        ThreadId.make(`side-chat-worktree-child-${status}`),
      ).pipe(Effect.flip);
      assert.include(String(rejected.cause), "has no worktree yet", status);
    }
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("closing a side chat deletes it only while unused; a deleted parent takes no more", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("side-chat-close-parent");
    const unused = ThreadId.make("side-chat-close-unused");
    const used = ThreadId.make("side-chat-close-used");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-close-parent-run"),
      ordinal: 1,
      status: "completed",
      text: "Parent work",
      stable: true,
    });
    yield* forkSideChat("side-chat-close-fork-unused", parentId, unused);
    yield* forkSideChat("side-chat-close-fork-used", parentId, used);
    yield* askSideChat(used, "side-chat-close-used-message");
    const close = (threadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`side-chat-close:${threadId}`),
        threadId,
        onlyIfUnused: true,
      });

    yield* close(unused);
    yield* close(used);
    assert.isNotNull((yield* orchestrator.getThreadProjection(unused)).thread.deletedAt);
    assert.isNull((yield* orchestrator.getThreadProjection(used)).thread.deletedAt);

    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("side-chat-close-delete-parent"),
      threadId: parentId,
    });
    assert.isNotNull((yield* orchestrator.getThreadProjection(used)).thread.deletedAt);
    const orphan = yield* forkSideChat(
      "side-chat-close-orphan",
      parentId,
      ThreadId.make("side-chat-close-orphan"),
    ).pipe(Effect.flip);
    assert.include(String(orphan.cause), "was deleted");
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat opened during the parent's first turn starts from a digest", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const grandparentId = ThreadId.make("side-chat-busy-grandparent");
    const grandparentRunId = RunId.make("side-chat-busy-grandparent-run");
    const parentId = ThreadId.make("side-chat-busy-parent");
    const sideChatId = ThreadId.make("side-chat-busy-child");
    yield* createParent(grandparentId);
    yield* writeParentRun({
      threadId: grandparentId,
      runId: grandparentRunId,
      ordinal: 1,
      status: "completed",
      text: "GRANDPARENT_MARKER",
      stable: true,
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("side-chat-busy-parent-fork"),
      sourceThreadId: grandparentId,
      targetThreadId: parentId,
      sourcePoint: { type: "run", runId: grandparentRunId },
      createdBy: "user",
      creationSource: "web",
    });
    yield* writeImportedHistory(parentId, "PARENT_IMPORTED_MARKER");
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-rewound-parent-run"),
      ordinal: 1,
      status: "rolled_back",
      text: "PARENT_ROLLED_BACK_MARKER",
    });
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-busy-parent-run"),
      ordinal: 2,
      status: "running",
      text: "PARENT_RUNNING_MARKER",
    });
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-queued-parent-run"),
      ordinal: 3,
      status: "queued",
      text: "PARENT_QUEUED_MARKER",
    });
    const fork = (commandId: string, sourceThreadId: ThreadId, targetThreadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make(commandId),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        sideChat: true,
        createdBy: "user",
        creationSource: "web",
      });

    yield* fork("side-chat-busy-fork", parentId, sideChatId);
    const created = yield* orchestrator.getThreadProjection(sideChatId);
    assert.isTrue(created.thread.lineage.sideChat);
    assert.equal(created.thread.runtimeMode, "approval-required");
    assert.isNull(created.thread.forkedFrom);
    assert.deepEqual(created.contextTransfers[0]?.sourcePoint, { threadId: parentId });

    const nested = yield* fork(
      "side-chat-busy-nested",
      sideChatId,
      ThreadId.make("side-chat-busy-nested"),
    ).pipe(Effect.flip);
    assert.equal(nested._tag, "OrchestratorDispatchError");
    // Either would take the side chat's lock before the parent's, against the delete cascade.
    const ontoParent = yield* fork("side-chat-busy-onto-parent", sideChatId, parentId).pipe(
      Effect.flip,
    );
    assert.equal(ontoParent._tag, "OrchestratorThreadAlreadyExistsError");
    const ontoExisting = yield* fork("side-chat-busy-onto-existing", parentId, sideChatId).pipe(
      Effect.flip,
    );
    assert.equal(ontoExisting._tag, "OrchestratorThreadAlreadyExistsError");
    const plainOntoExisting = yield* orchestrator
      .dispatch({
        type: "thread.fork",
        commandId: CommandId.make("side-chat-busy-plain-onto-existing"),
        sourceThreadId: parentId,
        targetThreadId: sideChatId,
        sourcePoint: { type: "latest_stable" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    // SCIENT-FORK:START — a normal fork keeps Scient's refusal of a taken identity.
    assert.equal(plainOntoExisting._tag, "OrchestratorCommandRejectedError");
    // SCIENT-FORK:END
    const busyMergeBack = yield* orchestrator
      .dispatch({
        type: "thread.merge_back",
        commandId: CommandId.make("side-chat-busy-merge-back"),
        sourceThreadId: sideChatId,
        targetThreadId: parentId,
        sourcePoint: { type: "latest_stable" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    assert.include(String(busyMergeBack.cause), "active work");

    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("side-chat-busy-first-message"),
      threadId: sideChatId,
      messageId: MessageId.make("side-chat-busy-first-message"),
      text: "What is the main thread doing?",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const started = yield* orchestrator.getThreadProjection(sideChatId);
    const [handoff] = started.contextHandoffs;
    assert.lengthOf(started.contextHandoffs, 1);
    assert.deepEqual(started.contextTransfers[0]?.resolution, {
      strategy: "portable_context",
      contextHandoffId: handoff!.id,
    });
    assert.include(handoff!.summaryText, "You are in a side chat beside the main thread.");
    // Inherited rows come first, so the cap truncates them first.
    assert.isAbove(
      handoff!.summaryText.indexOf("- User: PARENT_IMPORTED_MARKER"),
      handoff!.summaryText.indexOf("- User: GRANDPARENT_MARKER"),
    );
    assert.include(handoff!.summaryText, "- User: GRANDPARENT_MARKER");
    assert.notInclude(handoff!.summaryText, "PARENT_ROLLED_BACK_MARKER");
    assert.notInclude(handoff!.summaryText, "PARENT_QUEUED_MARKER");
    assert.include(handoff!.summaryText, "- User: PARENT_IMPORTED_MARKER");
    assert.include(handoff!.summaryText, "- User: PARENT_RUNNING_MARKER");
    assert.include(handoff!.summaryText, `scient_thread_inspect on thread ${parentId}`);
    assert.equal(
      started.messages.find((message) => message.role === "user")?.text,
      "What is the main thread doing?",
    );

    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("side-chat-busy-delete-parent"),
      threadId: parentId,
    });
    assert.isNotNull((yield* orchestrator.getThreadProjection(sideChatId)).thread.deletedAt);
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

// SCIENT-FORK:START — a Scient-forked parent's history is frozen, not reachable by `forkedFrom`.
const forkFrozenParent = (grandparentId: ThreadId, parentId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const grandparentRunId = RunId.make(`${grandparentId}:run`);
    yield* createParent(grandparentId);
    yield* writeParentRun({
      threadId: grandparentId,
      runId: grandparentRunId,
      ordinal: 1,
      status: "completed",
      text: "GRANDPARENT_MARKER",
      stable: true,
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make(`${parentId}:fork`),
      sourceThreadId: grandparentId,
      targetThreadId: parentId,
      sourcePoint: { type: "run", runId: grandparentRunId },
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("a side chat of a busy Scient fork carries its frozen history by reference", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("side-chat-frozen-parent");
    const sideChatId = ThreadId.make("side-chat-frozen-child");
    const stableRunId = RunId.make("side-chat-frozen-parent-stable-run");
    yield* forkFrozenParent(ThreadId.make("side-chat-frozen-grandparent"), parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-frozen-parent-rolled-back-run"),
      ordinal: 1,
      status: "rolled_back",
      text: "PARENT_ROLLED_BACK_MARKER",
    });
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-frozen-parent-cancelled-run"),
      ordinal: 2,
      status: "cancelled",
      text: "PARENT_CANCELLED_QUEUED_MARKER",
      inputIntent: "queued_turn",
    });
    yield* writeParentRun({
      threadId: parentId,
      runId: stableRunId,
      ordinal: 3,
      status: "completed",
      text: "PARENT_STABLE_MARKER",
      stable: true,
    });
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-frozen-parent-later-run"),
      ordinal: 4,
      status: "running",
      text: "PARENT_LATER_MARKER",
    });

    yield* forkSideChat("side-chat-frozen-fork", parentId, sideChatId);
    const created = yield* orchestrator.getThreadProjection(sideChatId);
    assert.isTrue(created.thread.lineage.sideChat);
    assert.deepEqual(created.thread.forkedFrom, {
      type: "run",
      threadId: parentId,
      runId: stableRunId,
    });
    assert.equal(created.thread.historyOrigin, "native");
    assert.isNull(created.thread.conversationFork);
    assert.lengthOf(created.visibleTurnItems, 0);

    yield* askSideChat(sideChatId, "side-chat-frozen-first-message");
    const started = yield* orchestrator.getThreadProjection(sideChatId);
    const resolution = started.contextTransfers[0]?.resolution;
    assert.equal(resolution?.strategy, "portable_context");
    assert.lengthOf(started.contextHandoffs, 2);
    const portable = started.contextHandoffs.find(
      (handoff) =>
        resolution?.strategy === "portable_context" && handoff.id === resolution.contextHandoffId,
    );
    const digest = started.contextHandoffs.find((handoff) => handoff !== portable);
    assert.ok(portable);
    assert.ok(digest);
    const retained = yield* (yield* ProjectionStoreV2).resolveContextHistory({
      handoffs: [portable],
      coverage: "Retained side chat history",
      budget: 1_000_000,
      alreadyDeliveredItemIds: new Set(),
    });
    const history = retained.messages.map((message) => message.text).join("\n");
    assert.include(history, "GRANDPARENT_MARKER");
    assert.include(history, "PARENT_STABLE_MARKER");
    assert.notInclude(history, "PARENT_ROLLED_BACK_MARKER");
    assert.notInclude(history, "PARENT_CANCELLED_QUEUED_MARKER");
    assert.notInclude(history, "PARENT_LATER_MARKER");
    assert.include(digest.summaryText, "You are in a side chat beside the main thread.");
    assert.include(digest.summaryText, "- User: PARENT_LATER_MARKER");
    assert.notInclude(digest.summaryText, "GRANDPARENT_MARKER");
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat of an idle Scient fork forks its native thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("side-chat-native-frozen-parent");
    const sideChatId = ThreadId.make("side-chat-native-frozen-child");
    yield* forkFrozenParent(ThreadId.make("side-chat-native-frozen-grandparent"), parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-native-frozen-parent-run"),
      ordinal: 1,
      status: "completed",
      text: "PARENT_STABLE_MARKER",
      stable: true,
    });

    yield* forkSideChat("side-chat-native-frozen-fork", parentId, sideChatId);
    yield* askSideChat(sideChatId, "side-chat-native-frozen-first-message");

    const started = yield* orchestrator.getThreadProjection(sideChatId);
    assert.isNotNull(started.providerThreads[0]?.forkedFrom);
    assert.lengthOf(started.contextHandoffs, 1);
    assert.isTrue(
      started.contextHandoffs[0]!.summaryText.startsWith(
        "You are in a side chat beside the main thread.",
      ),
    );
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);
// SCIENT-FORK:END

it.effect("merge-back rejects a second fork's context until the first is consumed", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("merge-back-guard-parent");
    const parentRunId = RunId.make("merge-back-guard-parent-run");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: parentRunId,
      ordinal: 1,
      status: "completed",
      text: "Parent work",
    });
    const forkAndRun = (name: string) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(`merge-back-guard-${name}`);
        const runId = RunId.make(`merge-back-guard-${name}-run`);
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`merge-back-guard-fork-${name}`),
          sourceThreadId: parentId,
          targetThreadId: threadId,
          sourcePoint: { type: "run", runId: parentRunId },
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });
        yield* writeParentRun({ threadId, runId, ordinal: 1, status: "completed", text: name });
        return { threadId, runId };
      });
    const mergeBack = (commandId: string, fork: { threadId: ThreadId; runId: RunId }) =>
      orchestrator.dispatch({
        type: "thread.merge_back",
        commandId: CommandId.make(commandId),
        sourceThreadId: fork.threadId,
        targetThreadId: parentId,
        sourcePoint: { type: "run", runId: fork.runId },
        createdBy: "user",
        creationSource: "web",
      });
    const first = yield* forkAndRun("first");
    const second = yield* forkAndRun("second");

    yield* mergeBack("merge-back-guard-first", first);
    const rejected = yield* mergeBack("merge-back-guard-second", second).pipe(Effect.flip);
    assert.include(String(rejected.cause), "pending context from another side chat or fork");
    yield* mergeBack("merge-back-guard-first-again", first);
    // That pending merge-back targets the parent, so it does not block one into `first`.
    const nested = { threadId: ThreadId.make("merge-back-guard-nested") };
    const nestedRunId = RunId.make("merge-back-guard-nested-run");
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("merge-back-guard-fork-nested"),
      sourceThreadId: first.threadId,
      targetThreadId: nested.threadId,
      sourcePoint: { type: "run", runId: first.runId },
      createdBy: "user",
      creationSource: "web",
    });
    yield* writeParentRun({
      threadId: nested.threadId,
      runId: nestedRunId,
      ordinal: 1,
      status: "completed",
      text: "nested",
    });
    yield* orchestrator.dispatch({
      type: "thread.merge_back",
      commandId: CommandId.make("merge-back-guard-nested"),
      sourceThreadId: nested.threadId,
      targetThreadId: first.threadId,
      sourcePoint: { type: "run", runId: nestedRunId },
      createdBy: "user",
      creationSource: "web",
    });

    const parent = yield* orchestrator.getThreadProjection(parentId);
    assert.deepEqual(
      parent.contextTransfers
        .filter((transfer) => transfer.type === "merge_back")
        .map((transfer) => [transfer.sourceThreadId, transfer.status]),
      [
        [first.threadId, "superseded"],
        [first.threadId, "pending"],
      ],
    );
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);
