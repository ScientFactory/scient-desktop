/**
 * SCIENT-FORK cross-area integration tests for PR 14.
 *
 * These tests exercise multiple layers in one synthetic flow to verify the
 * cross-area assertions that no single unit test covers:
 *
 * - VAL-CROSS-005: Exact boundary survives projection and persistence.
 *   A non-final selected assistant remains the exact endpoint across the SQL
 *   read model, decider prefix, fork event payload, destination projection,
 *   and Scient lineage row.
 *
 * - VAL-CROSS-010: Revert then fork is correct.
 *   Revert preserves the immutable baseline, removes later projection
 *   boundaries, permits a boundary at or before the revert point, and rejects
 *   a reverted-away assistant with no side effects.
 *
 * The tests use the real projection pipeline (in-memory SQLite) so events
 * flow through the actual SQL-backed projectors, the Scient-owned boundary
 * resolver, the pure fork decider, and the Scient lineage projector together.
 */
import {
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadForkCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationProjectionPipelineLive } from "../Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ensureScientForkSchema } from "./schema.ts";
import { makeForkBoundaryResolver } from "./ForkBoundaryReadModel.ts";
import { forkThread } from "./forkDecider.ts";
import { withForkOriginDetail } from "./forkDecisionReadModel.ts";
import { createEmptyReadModel } from "../projector.ts";

const makeCrossAreaTestLayer = (prefix: string) =>
  Layer.mergeAll(
    OrchestrationProjectionPipelineLive,
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );

// ---------------------------------------------------------------------------
// Shared event-construction helpers
// ---------------------------------------------------------------------------

const NOW = "2026-04-01T00:00:00.000Z";
const PROJECT = ProjectId.make("cross-area-project");
const ORIGIN = ThreadId.make("cross-origin");
const PROVIDER = ProviderInstanceId.make("codex");

const T1 = TurnId.make("origin-turn-1");
const T2 = TurnId.make("origin-turn-2");
const T3 = TurnId.make("origin-turn-3");
const U1 = MessageId.make("origin-user-1");
const U2 = MessageId.make("origin-user-2");
const U3 = MessageId.make("origin-user-3");
const A1 = MessageId.make("origin-assistant-1");
const A2 = MessageId.make("origin-assistant-2");
const A3 = MessageId.make("origin-assistant-3");

type EventInput = Omit<OrchestrationEvent, "sequence">;

function projectCreatedEvent(): EventInput {
  return {
    type: "project.created",
    eventId: EventId.make("evt-cross-project"),
    aggregateKind: "project",
    aggregateId: PROJECT,
    occurredAt: NOW,
    commandId: CommandId.make("cmd-cross-project"),
    causationEventId: null,
    correlationId: CorrelationId.make("cmd-cross-project"),
    metadata: {},
    payload: {
      projectId: PROJECT,
      title: "Cross Area Project",
      workspaceRoot: "/tmp/cross-area",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function threadCreatedEvent(threadId: ThreadId, title: string, eventId: string): EventInput {
  return {
    type: "thread.created",
    eventId: EventId.make(eventId),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW,
    commandId: CommandId.make(`cmd-${eventId}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-${eventId}`),
    metadata: {},
    payload: {
      threadId,
      projectId: PROJECT,
      title,
      modelSelection: { instanceId: PROVIDER, model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function messageSentEvent(
  threadId: ThreadId,
  messageId: MessageId,
  role: "user" | "assistant",
  text: string,
  turnId: TurnId | null,
  createdAt: string,
  eventId: string,
): EventInput {
  return {
    type: "thread.message-sent",
    eventId: EventId.make(eventId),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: createdAt,
    commandId: CommandId.make(`cmd-${eventId}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-${eventId}`),
    metadata: {},
    payload: {
      threadId,
      messageId,
      role,
      text,
      turnId,
      streaming: false,
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function turnDiffCompletedEvent(
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: number,
  assistantMessageId: MessageId,
  completedAt: string,
  eventId: string,
): EventInput {
  return {
    type: "thread.turn-diff-completed",
    eventId: EventId.make(eventId),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: completedAt,
    commandId: CommandId.make(`cmd-${eventId}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-${eventId}`),
    metadata: {},
    payload: {
      threadId,
      turnId,
      checkpointTurnCount,
      checkpointRef: CheckpointRef.make(
        `refs/t3/checkpoints/${threadId}/turn/${checkpointTurnCount}`,
      ),
      status: "ready",
      files: [],
      assistantMessageId,
      completedAt,
    },
  };
}

function revertedEvent(threadId: ThreadId, turnCount: number, eventId: string): EventInput {
  return {
    type: "thread.reverted",
    eventId: EventId.make(eventId),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW,
    commandId: CommandId.make(`cmd-${eventId}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-${eventId}`),
    metadata: {},
    payload: {
      threadId,
      turnCount,
    },
  };
}

// ---------------------------------------------------------------------------
// VAL-CROSS-005: Exact boundary survives projection and persistence
// ---------------------------------------------------------------------------

it.layer(Layer.fresh(makeCrossAreaTestLayer("t3-cross-005-")))(
  "VAL-CROSS-005: exact boundary survives projection and persistence",
  (it) => {
    it.effect("non-final selected assistant is the exact endpoint across all layers", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        yield* ensureScientForkSchema(sql);

        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore.append(event).pipe(Effect.flatMap((saved) => pipeline.projectEvent(saved)));

        // 1. Seed the origin thread with three completed turns.
        yield* appendAndProject(projectCreatedEvent());
        yield* appendAndProject(threadCreatedEvent(ORIGIN, "Origin", "evt-cross-origin"));

        // Turn 1: u1 -> a1
        yield* appendAndProject(
          messageSentEvent(
            ORIGIN,
            U1,
            "user",
            "first prompt",
            T1,
            "2026-04-01T00:00:01.000Z",
            "evt-u1",
          ),
        );
        yield* appendAndProject(
          messageSentEvent(
            ORIGIN,
            A1,
            "assistant",
            "first answer",
            T1,
            "2026-04-01T00:00:02.000Z",
            "evt-a1",
          ),
        );
        yield* appendAndProject(
          turnDiffCompletedEvent(ORIGIN, T1, 1, A1, "2026-04-01T00:00:02.500Z", "evt-tdc-1"),
        );

        // Turn 2: u2 -> a2
        yield* appendAndProject(
          messageSentEvent(
            ORIGIN,
            U2,
            "user",
            "second prompt",
            T2,
            "2026-04-01T00:00:03.000Z",
            "evt-u2",
          ),
        );
        yield* appendAndProject(
          messageSentEvent(
            ORIGIN,
            A2,
            "assistant",
            "second answer",
            T2,
            "2026-04-01T00:00:04.000Z",
            "evt-a2",
          ),
        );
        yield* appendAndProject(
          turnDiffCompletedEvent(ORIGIN, T2, 2, A2, "2026-04-01T00:00:04.500Z", "evt-tdc-2"),
        );

        // Turn 3: u3 -> a3
        yield* appendAndProject(
          messageSentEvent(
            ORIGIN,
            U3,
            "user",
            "third prompt",
            T3,
            "2026-04-01T00:00:05.000Z",
            "evt-u3",
          ),
        );
        yield* appendAndProject(
          messageSentEvent(
            ORIGIN,
            A3,
            "assistant",
            "third answer",
            T3,
            "2026-04-01T00:00:06.000Z",
            "evt-a3",
          ),
        );
        yield* appendAndProject(
          turnDiffCompletedEvent(ORIGIN, T3, 3, A3, "2026-04-01T00:00:06.500Z", "evt-tdc-3"),
        );

        // 2. Resolve boundaries from SQL — select the non-final assistant a2.
        const resolver = makeForkBoundaryResolver(sql);
        const resolved = yield* resolver.resolve({
          originThreadId: ORIGIN,
          sourceAssistantMessageId: A2,
          threadCreatedAt: NOW,
        });

        // Assert the resolver selected the exact boundary.
        assert.strictEqual(resolved.selectedBoundary.assistantMessageId, A2);
        assert.strictEqual(resolved.selectedBoundary.turnId, T2);
        assert.strictEqual(resolved.selectedBoundary.conversationTurnCount, 2);

        // 3. Hydrate the origin thread detail and run the fork decider with
        //    the SQL-resolved boundaries.
        const originOption = yield* snapshotQuery.getThreadDetailById(ORIGIN);
        if (!Option.isSome(originOption)) {
          return assert.fail("Origin thread detail not found in projection");
        }
        const origin = originOption.value;

        const baseReadModel: OrchestrationReadModel = {
          ...createEmptyReadModel(NOW),
          projects: [
            {
              id: PROJECT,
              title: "Cross Area Project",
              workspaceRoot: "/tmp/cross-area",
              defaultModelSelection: null,
              scripts: [],
              createdAt: NOW,
              updatedAt: NOW,
              deletedAt: null,
            },
          ],
          threads: [],
          updatedAt: NOW,
        };
        const decisionReadModel = withForkOriginDetail(baseReadModel, origin);

        const forkCmd: ThreadForkCommand = {
          type: "thread.fork",
          commandId: CommandId.make("cmd-cross-fork-005"),
          originThreadId: ORIGIN,
          newThreadId: ThreadId.make("cross-fork-005"),
          sourceAssistantMessageId: A2,
          workspaceMode: "local",
        };

        const plannedEvents = yield* forkThread({
          command: forkCmd,
          readModel: decisionReadModel,
          resolvedBoundaries: resolved.boundaries,
        }).pipe(Effect.provideService(Crypto.Crypto, yield* Crypto.Crypto));

        // 4. Assert the fork event payload carries the exact boundary.
        const forkedEvent = plannedEvents.find((e) => e.type === "thread.forked");
        if (!forkedEvent || forkedEvent.type !== "thread.forked") {
          return assert.fail("thread.forked event not found in planned events");
        }
        assert.strictEqual(forkedEvent.payload.forkAtTurnId, T2);
        assert.strictEqual(forkedEvent.payload.forkAtTurnCount, 2);

        // 5. Assert the retained prefix includes only messages through a2
        //    (u1, a1, u2, a2) and excludes turn 3 content.
        const messageEvents = plannedEvents.filter((e) => e.type === "thread.message-sent");
        const prefixTexts = messageEvents.map((e) =>
          e.type === "thread.message-sent" ? `${e.payload.role}:${e.payload.text}` : "",
        );
        assert.deepEqual(prefixTexts, [
          "user:first prompt",
          "assistant:first answer",
          "user:second prompt",
          "assistant:second answer",
        ]);

        // 6. Persist and project the fork events so the lineage row and
        //    destination projection are written to SQL.
        for (const planned of plannedEvents) {
          const saved = yield* eventStore.append(planned);
          yield* pipeline.projectEvent(saved);
        }

        // 7. Assert the Scient lineage row agrees with the exact boundary.
        const lineageRow = yield* sql<{
          readonly fork_point_turn_id: string | null;
          readonly fork_point_turn_count: number;
          readonly baseline_turn_id: string;
          readonly thread_id: string;
        }>`
          SELECT fork_point_turn_id, fork_point_turn_count, baseline_turn_id, thread_id
          FROM scient_thread_lineage
          WHERE thread_id = 'cross-fork-005'
        `;
        assert.strictEqual(lineageRow.length, 1);
        assert.strictEqual(lineageRow[0]?.fork_point_turn_id, T2);
        assert.strictEqual(lineageRow[0]?.fork_point_turn_count, 2);

        // 8. Assert the destination projection has completed turns including
        //    the baseline. The fork decider re-emits prefix messages with
        //    imported turn IDs; the turn projector creates a completed turn
        //    for each imported assistant message, and thread.forked creates
        //    the baseline turn. All must be completed.
        const destTurns = yield* sql<{ readonly turn_id: string | null; readonly state: string }>`
          SELECT turn_id, state FROM projection_turns
          WHERE thread_id = 'cross-fork-005' ORDER BY requested_at ASC
        `;
        assert.isTrue(destTurns.length >= 1);
        for (const t of destTurns) {
          assert.strictEqual(t.state, "completed");
        }
        // The baseline turn (from thread.forked) must be present.
        const baselineTurnInDest = destTurns.some(
          (t) => t.turn_id === forkedEvent.payload.baselineTurnId,
        );
        assert.isTrue(baselineTurnInDest);

        // 9. Assert the origin projection is unchanged — still 3 turns.
        const originTurns = yield* sql<{ readonly turn_id: string | null }>`
          SELECT turn_id FROM projection_turns
          WHERE thread_id = 'cross-origin' ORDER BY requested_at ASC
        `;
        assert.deepEqual(
          originTurns.map((t) => t.turn_id),
          [T1, T2, T3],
        );
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// VAL-CROSS-010: Revert then fork is correct
// ---------------------------------------------------------------------------

it.layer(Layer.fresh(makeCrossAreaTestLayer("t3-cross-010-")))(
  "VAL-CROSS-010: revert then fork is correct",
  (it) => {
    it.effect("revert preserves baseline, permits valid fork, rejects stale boundary", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        yield* ensureScientForkSchema(sql);

        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore.append(event).pipe(Effect.flatMap((saved) => pipeline.projectEvent(saved)));

        // 1. Create origin thread with two completed turns.
        yield* appendAndProject(projectCreatedEvent());
        yield* appendAndProject(threadCreatedEvent(ORIGIN, "Origin 010", "evt-010-origin"));

        // Turn 1
        yield* appendAndProject(
          messageSentEvent(
            ORIGIN,
            U1,
            "user",
            "first prompt",
            T1,
            "2026-04-02T00:00:01.000Z",
            "evt-010-u1",
          ),
        );
        yield* appendAndProject(
          messageSentEvent(
            ORIGIN,
            A1,
            "assistant",
            "first answer",
            T1,
            "2026-04-02T00:00:02.000Z",
            "evt-010-a1",
          ),
        );
        yield* appendAndProject(
          turnDiffCompletedEvent(ORIGIN, T1, 1, A1, "2026-04-02T00:00:02.500Z", "evt-010-tdc-1"),
        );

        // Turn 2
        yield* appendAndProject(
          messageSentEvent(
            ORIGIN,
            U2,
            "user",
            "second prompt",
            T2,
            "2026-04-02T00:00:03.000Z",
            "evt-010-u2",
          ),
        );
        yield* appendAndProject(
          messageSentEvent(
            ORIGIN,
            A2,
            "assistant",
            "second answer",
            T2,
            "2026-04-02T00:00:04.000Z",
            "evt-010-a2",
          ),
        );
        yield* appendAndProject(
          turnDiffCompletedEvent(ORIGIN, T2, 2, A2, "2026-04-02T00:00:04.500Z", "evt-010-tdc-2"),
        );

        // 2. Fork the origin at turn 1 (a1) to create a forked thread with
        //    an inherited baseline.
        const resolver = makeForkBoundaryResolver(sql);
        const resolved = yield* resolver.resolve({
          originThreadId: ORIGIN,
          sourceAssistantMessageId: A1,
          threadCreatedAt: NOW,
        });

        const originOption = yield* snapshotQuery.getThreadDetailById(ORIGIN);
        if (!Option.isSome(originOption)) {
          return assert.fail("Origin thread detail not found");
        }
        const origin = originOption.value;

        const baseReadModel: OrchestrationReadModel = {
          ...createEmptyReadModel(NOW),
          projects: [
            {
              id: PROJECT,
              title: "Cross Area Project",
              workspaceRoot: "/tmp/cross-area",
              defaultModelSelection: null,
              scripts: [],
              createdAt: NOW,
              updatedAt: NOW,
              deletedAt: null,
            },
          ],
          threads: [],
          updatedAt: NOW,
        };
        const decisionReadModel = withForkOriginDetail(baseReadModel, origin);

        const FORK = ThreadId.make("cross-010-fork");
        const forkCmd: ThreadForkCommand = {
          type: "thread.fork",
          commandId: CommandId.make("cmd-010-fork"),
          originThreadId: ORIGIN,
          newThreadId: FORK,
          sourceAssistantMessageId: A1,
          workspaceMode: "local",
        };

        const plannedForkEvents = yield* forkThread({
          command: forkCmd,
          readModel: decisionReadModel,
          resolvedBoundaries: resolved.boundaries,
        }).pipe(Effect.provideService(Crypto.Crypto, yield* Crypto.Crypto));

        const forkedEvent = plannedForkEvents.find((e) => e.type === "thread.forked");
        if (!forkedEvent || forkedEvent.type !== "thread.forked") {
          return assert.fail("thread.forked event not found");
        }
        const baselineTurnId = forkedEvent.payload.baselineTurnId;
        const baselineAssistantId = forkedEvent.payload.baselineAssistantMessageId;
        if (!baselineAssistantId) {
          return assert.fail("baseline assistant message ID is null");
        }

        for (const planned of plannedForkEvents) {
          const saved = yield* eventStore.append(planned);
          yield* pipeline.projectEvent(saved);
        }

        // 3. Add a post-fork turn to the forked thread.
        const POST_T1 = TurnId.make("fork-post-turn-1");
        const POST_U1 = MessageId.make("fork-post-user-1");
        const POST_A1 = MessageId.make("fork-post-assistant-1");
        yield* appendAndProject(
          messageSentEvent(
            FORK,
            POST_U1,
            "user",
            "new question",
            POST_T1,
            "2026-04-02T00:00:10.000Z",
            "evt-010-post-u1",
          ),
        );
        yield* appendAndProject(
          messageSentEvent(
            FORK,
            POST_A1,
            "assistant",
            "new answer",
            POST_T1,
            "2026-04-02T00:00:11.000Z",
            "evt-010-post-a1",
          ),
        );
        yield* appendAndProject(
          turnDiffCompletedEvent(
            FORK,
            POST_T1,
            1,
            POST_A1,
            "2026-04-02T00:00:11.500Z",
            "evt-010-post-tdc-1",
          ),
        );

        // Verify the forked thread now has baseline + 1 post-fork turn.
        const forkTurnsBefore = yield* sql<{ readonly turn_id: string | null }>`
          SELECT turn_id FROM projection_turns
          WHERE thread_id = 'cross-010-fork' ORDER BY requested_at ASC
        `;
        assert.strictEqual(forkTurnsBefore.length, 2);

        // 4. Revert the forked thread to baseline (turnCount = 0), removing
        //    the post-fork turn.
        yield* appendAndProject(revertedEvent(FORK, 0, "evt-010-revert"));

        // Assert the baseline turn survives the revert.
        const forkTurnsAfter = yield* sql<{
          readonly turn_id: string | null;
          readonly state: string;
        }>`
          SELECT turn_id, state FROM projection_turns
          WHERE thread_id = 'cross-010-fork' ORDER BY requested_at ASC
        `;
        assert.strictEqual(forkTurnsAfter.length, 1);
        assert.strictEqual(forkTurnsAfter[0]?.turn_id, baselineTurnId);

        // Assert the post-fork messages were removed.
        const forkMessagesAfter = yield* sql<{ readonly message_id: string }>`
          SELECT message_id FROM projection_thread_messages
          WHERE thread_id = 'cross-010-fork' ORDER BY created_at ASC
        `;
        const remainingMessageIds = new Set(forkMessagesAfter.map((m) => m.message_id));
        assert.isFalse(remainingMessageIds.has(POST_U1));
        assert.isFalse(remainingMessageIds.has(POST_A1));

        // 5. Resolve boundaries on the forked thread after revert.
        //    The baseline assistant should be selectable; the reverted-away
        //    post-fork assistant should not.
        const baselineResolve = yield* resolver.resolve({
          originThreadId: FORK,
          sourceAssistantMessageId: baselineAssistantId,
          threadCreatedAt: NOW,
        });
        assert.strictEqual(baselineResolve.selectedBoundary.conversationTurnCount, 0);
        assert.strictEqual(baselineResolve.selectedBoundary.turnId, baselineTurnId);

        // The reverted-away assistant must fail closed.
        const staleError = yield* resolver
          .resolve({
            originThreadId: FORK,
            sourceAssistantMessageId: POST_A1,
            threadCreatedAt: NOW,
          })
          .pipe(Effect.flip);
        assert.isTrue(staleError instanceof Error);

        // 6. Fork from the valid baseline boundary — should succeed.
        const RE_FORK = ThreadId.make("cross-010-refork");
        const forkedThreadOption = yield* snapshotQuery.getThreadDetailById(FORK);
        if (!Option.isSome(forkedThreadOption)) {
          return assert.fail("Forked thread detail not found");
        }
        const forkedThread = forkedThreadOption.value;

        const readModelForRefork = withForkOriginDetail(baseReadModel, forkedThread);
        const reforkCmd: ThreadForkCommand = {
          type: "thread.fork",
          commandId: CommandId.make("cmd-010-refork"),
          originThreadId: FORK,
          newThreadId: RE_FORK,
          sourceAssistantMessageId: baselineAssistantId,
          workspaceMode: "local",
        };

        const reforkEvents = yield* forkThread({
          command: reforkCmd,
          readModel: readModelForRefork,
          resolvedBoundaries: baselineResolve.boundaries,
        }).pipe(Effect.provideService(Crypto.Crypto, yield* Crypto.Crypto));

        // Assert the re-fork produced a valid forked event at count 0.
        const reforkedEvent = reforkEvents.find((e) => e.type === "thread.forked");
        if (!reforkedEvent || reforkedEvent.type !== "thread.forked") {
          return assert.fail("re-fork thread.forked event not found");
        }
        assert.strictEqual(reforkedEvent.payload.forkAtTurnCount, 0);

        // 7. Assert the origin thread is unchanged throughout — still 2 turns.
        const originTurnsFinal = yield* sql<{ readonly turn_id: string | null }>`
          SELECT turn_id FROM projection_turns
          WHERE thread_id = 'cross-origin' ORDER BY requested_at ASC
        `;
        assert.deepEqual(
          originTurnsFinal.map((t) => t.turn_id),
          [T1, T2],
        );

        // Assert origin messages are unchanged.
        const originMessagesFinal = yield* sql<{ readonly message_id: string }>`
          SELECT message_id FROM projection_thread_messages
          WHERE thread_id = 'cross-origin' ORDER BY created_at ASC
        `;
        assert.deepEqual(
          originMessagesFinal.map((m) => m.message_id),
          [U1, A1, U2, A2],
        );
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// Fresh startup and T3/Scient migration separation
// ---------------------------------------------------------------------------

it.layer(Layer.fresh(makeCrossAreaTestLayer("t3-cross-startup-")))(
  "fresh startup and T3/Scient migration separation",
  (it) => {
    it.effect("fresh startup creates both ledgers and resolves a valid fork", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        yield* pipeline.bootstrap;

        // 1. SqlitePersistenceMemory initializes the Scient schema and its
        //    separate ledger while the layer is constructed, before
        //    pipeline.bootstrap runs T3 migrations; the ledgers remain
        //    independent.
        const t3Ledger = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC
        `;
        assert.isTrue(t3Ledger.length > 0);

        const scientLedger = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM scient_schema_migrations ORDER BY migration_id ASC
        `;
        assert.isTrue(scientLedger.length > 0);

        // T3 and Scient ledgers are separate tables.  Both use integer IDs
        // starting from 1, but they are independent — the assertion is that
        // the Scient schema bootstrap never inserts into or modifies the T3
        // ledger, not that the numeric ID ranges are disjoint.
        const scientIds = new Set(scientLedger.map((row) => row.migration_id));
        // Scient ledger must contain the legacy IDs 1 and 2.
        assert.isTrue(scientIds.has(1));
        assert.isTrue(scientIds.has(2));

        // 2. Seed a minimal origin and verify the resolver works on fresh SQL.
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore.append(event).pipe(Effect.flatMap((saved) => pipeline.projectEvent(saved)));

        yield* appendAndProject(projectCreatedEvent());
        yield* appendAndProject(threadCreatedEvent(ORIGIN, "Fresh Start", "evt-fresh-origin"));

        yield* appendAndProject(
          messageSentEvent(
            ORIGIN,
            U1,
            "user",
            "hello",
            T1,
            "2026-04-03T00:00:01.000Z",
            "evt-fresh-u1",
          ),
        );
        yield* appendAndProject(
          messageSentEvent(
            ORIGIN,
            A1,
            "assistant",
            "world",
            T1,
            "2026-04-03T00:00:02.000Z",
            "evt-fresh-a1",
          ),
        );
        yield* appendAndProject(
          turnDiffCompletedEvent(ORIGIN, T1, 1, A1, "2026-04-03T00:00:02.500Z", "evt-fresh-tdc-1"),
        );

        const resolver = makeForkBoundaryResolver(sql);
        const resolved = yield* resolver.resolve({
          originThreadId: ORIGIN,
          sourceAssistantMessageId: A1,
          threadCreatedAt: NOW,
        });

        assert.strictEqual(resolved.selectedBoundary.assistantMessageId, A1);
        assert.strictEqual(resolved.selectedBoundary.turnId, T1);
        assert.strictEqual(resolved.selectedBoundary.conversationTurnCount, 1);

        // 3. Verify the T3 ledger is unchanged after Scient schema operations.
        const t3LedgerAfter = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC
        `;
        assert.deepEqual(
          t3Ledger.map((r) => ({ id: r.migration_id, name: r.name })),
          t3LedgerAfter.map((r) => ({ id: r.migration_id, name: r.name })),
        );
      }),
    );
  },
);
