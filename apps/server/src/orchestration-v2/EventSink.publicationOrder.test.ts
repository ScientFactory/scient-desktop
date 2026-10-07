import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";

const threadFixture = (threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread => {
  const instanceId = ProviderInstanceId.make("controlled-publication-provider");
  return {
    id: threadId,
    projectId: ProjectId.make("controlled-publication-project"),
    title: "Publication order",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "controlled-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
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
};

for (const database of ["memory", "file"] as const) {
  it.live(`publishes committed user and provider events in SQL order: ${database} SQLite`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "scient-publication-order-" });
      const persistence =
        database === "memory"
          ? SqlitePersistenceMemory
          : makeSqlitePersistenceLive(path.join(directory, "events.sqlite"));
      const applicationStore = OrchestrationEventStoreLive.pipe(Layer.provideMerge(persistence));
      const stores = Layer.mergeAll(
        EventStore.layerFromOrchestrationEventStore,
        ProjectionStore.layer,
        CommandReceiptStore.layer,
        EffectOutbox.layer,
        ProjectStore.layer,
        TurnItemPositionStore.layer,
      ).pipe(Layer.provideMerge(applicationStore));

      yield* Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const notificationReached = yield* Deferred.make<void>();
        const releasePublisher = yield* Deferred.make<void>();
        // Test-only descheduling after the real post-commit notification. All
        // persistence, publication and subscription implementations stay real.
        const gatedOutbox = EffectOutbox.EffectOutboxV2.of({
          ...outbox,
          notifyAvailable: (count) =>
            outbox
              .notifyAvailable(count)
              .pipe(
                Effect.andThen(Deferred.succeed(notificationReached, undefined)),
                Effect.andThen(Deferred.await(releasePublisher)),
              ),
        });
        const sinkContext = yield* Layer.build(EventSink.layerFromStores).pipe(
          Effect.provideService(EffectOutbox.EffectOutboxV2, gatedOutbox),
        );
        const sink = Context.get(sinkContext, EventSink.EventSinkV2);
        const eventStore = yield* EventStore.EventStoreV2;
        const applicationEvents = yield* OrchestrationEventStore;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`publication-order:${database}`);
        const thread = threadFixture(threadId, now);
        const seed = (yield* sink.write({
          events: [
            {
              id: EventId.make(`${database}:seed`),
              type: "thread.created",
              threadId,
              occurredAt: now,
              payload: thread,
            },
          ],
        }))[0]!;
        const message = (role: "user" | "assistant"): OrchestrationV2ConversationMessage => ({
          id: MessageId.make(`${database}:${role}`),
          threadId,
          runId: null,
          nodeId: null,
          role,
          text: role === "user" ? "The committed user message" : "Independent provider activity",
          attachments: [],
          streaming: false,
          createdBy: role === "user" ? "user" : "agent",
          creationSource: role === "user" ? "web" : "provider",
          createdAt: now,
          updatedAt: now,
        });
        const userEvent: OrchestrationV2DomainEvent = {
          id: EventId.make(`${database}:user-event`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: message("user"),
        };
        const providerEvent: OrchestrationV2DomainEvent = {
          ...userEvent,
          id: EventId.make(`${database}:provider-event`),
          payload: message("assistant"),
        };

        yield* Effect.gen(function* () {
          const applicationReady = yield* Deferred.make<void>();
          const sinkReady = yield* Deferred.make<void>();
          const applicationReader = yield* applicationEvents.streamApplicationEvents().pipe(
            Stream.tap((event) =>
              event.sequence === seed.sequence
                ? Deferred.succeed(applicationReady, undefined)
                : Effect.void,
            ),
            Stream.take(3),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          );
          const sinkReader = yield* sink.stream({ threadId, bounded: true }).pipe(
            Stream.tap((event) =>
              event.sequence === seed.sequence
                ? Deferred.succeed(sinkReady, undefined)
                : Effect.void,
            ),
            Stream.take(3),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* Deferred.await(applicationReady);
          yield* Deferred.await(sinkReady);

          const commandId = CommandId.make(`${database}:user-command`);
          const commandWriter = yield* sink
            .commitCommand({
              commandId,
              threadId,
              commandType: "message.send",
              acceptedAt: now,
              events: [userEvent],
              effects: [
                {
                  id: `${database}:durable-effect`,
                  commandId,
                  threadId,
                  request: { type: "terminal.cleanup" },
                },
              ],
            })
            .pipe(Effect.forkScoped({ startImmediately: true }));
          yield* Deferred.await(notificationReached);
          const atGate = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
          assert.deepEqual(
            atGate.map((entry) => entry.event.id),
            [seed.event.id, userEvent.id],
          );
          const lower = atGate[1]!;
          const receiptAtGate = yield* receipts.getByCommandId(commandId);
          assert.isTrue(Option.isSome(receiptAtGate));
          if (Option.isNone(receiptAtGate)) return assert.fail("Expected committed receipt");
          assert.equal(receiptAtGate.value.resultSequence, lower.sequence);
          assert.equal(receiptAtGate.value.status, "accepted");
          const queued = yield* outbox.listByCommandId(commandId);
          assert.lengthOf(queued, 1);
          assert.equal(queued[0]!.status, "pending");
          assert.include(
            (yield* projections.getThreadProjection(threadId)).messages.map((entry) => entry.id),
            userEvent.payload.id,
          );

          const providerStarted = yield* Deferred.make<void>();
          const providerWriter = yield* Deferred.succeed(providerStarted, undefined).pipe(
            Effect.andThen(sink.write({ events: [providerEvent] })),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* Deferred.await(providerStarted);
          // A bounded cooperative scheduler window, not a requirement that the
          // second writer commit while the first is gated. A serialization fix
          // may leave it waiting here; this same schedule must still complete.
          for (let turn = 0; turn < 16; turn++) yield* Effect.yieldNow;
          yield* Deferred.succeed(releasePublisher, undefined);
          const command = yield* Fiber.join(commandWriter);
          const provider = yield* Fiber.join(providerWriter);
          const applicationPublished = yield* Fiber.join(applicationReader);
          const sinkPublished = yield* Fiber.join(sinkReader);
          const durable = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
          const highestPublished = Math.max(...sinkPublished.map((entry) => entry.sequence));
          const resume = yield* eventStore
            .read({ threadId, afterSequence: highestPublished })
            .pipe(Stream.runCollect);
          const projected = yield* projections.getThreadProjection(threadId);
          const witness = {
            database,
            gateAfterCommittedUserSequence: lower.sequence,
            receiptSequence: receiptAtGate.value.resultSequence,
            durableSqlSequences: durable.map((entry) => entry.sequence),
            durableEventIds: durable.map((entry) => entry.event.id),
            applicationPublishedSequences: applicationPublished.map((entry) => entry.sequence),
            sinkPublishedSequences: sinkPublished.map((entry) => entry.sequence),
            resumeAfterHighestPublishedEventIds: resume.map((entry) => entry.event.id),
            snapshotContainsUserMessage: projected.messages.some(
              (entry) => entry.id === userEvent.payload.id,
            ),
          };
          yield* Effect.logInfo("Real EventSink publication-order witness", {
            witness,
          });
          assert.isTrue(command.committed);
          assert.equal(command.receipt.resultSequence, lower.sequence);
          assert.isAbove(provider[0]!.sequence, lower.sequence);
          assert.deepEqual(
            durable.map((entry) => entry.event.id),
            [seed.event.id, userEvent.id, providerEvent.id],
          );
          assert.isEmpty(resume);
          assert.isTrue(witness.snapshotContainsUserMessage);
          // The required behavior is SQL order, never acceptance of inversion.
          assert.deepEqual(
            applicationPublished.map((entry) => entry.sequence),
            durable.map((entry) => entry.sequence),
          );
          assert.deepEqual(
            sinkPublished.map((entry) => entry.sequence),
            durable.map((entry) => entry.sequence),
          );
        }).pipe(Effect.ensuring(Deferred.succeed(releasePublisher, undefined)));
      }).pipe(Effect.provide(stores));
    }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(NodeServices.layer)),
  );
}

it.live("publishes no legacy shell events when its final import-ledger insert rolls back", () => {
  const applicationStore = OrchestrationEventStoreLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const stores = Layer.merge(
    EventStore.layerFromOrchestrationEventStore,
    ProjectionStore.layer,
  ).pipe(Layer.provideMerge(applicationStore));
  const sinkLayer = EventSink.layer.pipe(Layer.provideMerge(stores));
  const importerLayer = LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(sinkLayer));
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const applicationEvents = yield* OrchestrationEventStore;
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const now = yield* DateTime.now;
    const controlThreadId = ThreadId.make("publication-order:legacy-control");
    const legacyThreadId = ThreadId.make("publication-order:failed-legacy-import");
    const thread = threadFixture(controlThreadId, now);
    const seed = (yield* sink.write({
      events: [
        {
          id: EventId.make("legacy-control:seed"),
          type: "thread.created",
          threadId: controlThreadId,
          occurredAt: now,
          payload: thread,
        },
      ],
    }))[0]!;
    yield* sql`INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES (
      'publication-order:legacy-project', 'Legacy publication control', '/tmp/synthetic-legacy-publication',
      '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )`;
    yield* sql`INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at
    ) VALUES (
      ${legacyThreadId}, 'publication-order:legacy-project', 'Legacy shell',
      '{"instanceId":"codex","model":"controlled-model"}', 'full-access', 'default',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )`;
    yield* sql`INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at
    ) VALUES (
      'legacy-publication:user', ${legacyThreadId}, NULL, 'user', 'Original legacy user message', '[]', 0,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )`;
    // Abort at final ledger insertion after the events and projections are prepared.
    yield* sql.unsafe(`CREATE TRIGGER controlled_legacy_ledger_failure
      BEFORE INSERT ON orchestration_v2_legacy_imports
      WHEN NEW.thread_id = 'publication-order:failed-legacy-import'
      BEGIN SELECT RAISE(ABORT, 'controlled legacy ledger abort'); END`);

    const marker: OrchestrationV2DomainEvent = {
      id: EventId.make("legacy-control:after-failed-import"),
      type: "thread.metadata-updated",
      threadId: controlThreadId,
      occurredAt: now,
      payload: thread,
    };
    const applicationReady = yield* Deferred.make<void>();
    const sinkReady = yield* Deferred.make<void>();
    const applicationReader = yield* applicationEvents.streamApplicationEvents().pipe(
      Stream.tap((event) =>
        event.sequence === seed.sequence
          ? Deferred.succeed(applicationReady, undefined)
          : Effect.void,
      ),
      Stream.takeUntil((event) => "event" in event && event.event.id === marker.id),
      Stream.runCollect,
      Effect.forkScoped({ startImmediately: true }),
    );
    const sinkReader = yield* sink.stream({ bounded: true }).pipe(
      Stream.tap((event) =>
        event.sequence === seed.sequence ? Deferred.succeed(sinkReady, undefined) : Effect.void,
      ),
      Stream.takeUntil((event) => event.event.id === marker.id),
      Stream.runCollect,
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Deferred.await(applicationReady);
    yield* Deferred.await(sinkReady);
    const imported = yield* importer.reconcileShells.pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(imported));
    if (Exit.isSuccess(imported)) return assert.fail("Expected controlled import-ledger failure");
    assert.include(Cause.pretty(imported.cause), "controlled legacy ledger abort");
    yield* sink.write({ events: [marker] });
    const applicationPublished = yield* Fiber.join(applicationReader);
    const sinkPublished = yield* Fiber.join(sinkReader);
    const durable = yield* eventStore.read({ threadId: legacyThreadId }).pipe(Stream.runCollect);
    const ledger =
      yield* sql`SELECT thread_id FROM orchestration_v2_legacy_imports WHERE thread_id = ${legacyThreadId}`;
    const positions =
      yield* sql`SELECT turn_item_id FROM orchestration_v2_turn_item_positions WHERE thread_id = ${legacyThreadId}`;
    const threads =
      yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${legacyThreadId}`;
    const messages =
      yield* sql`SELECT message_id FROM orchestration_v2_projection_messages WHERE thread_id = ${legacyThreadId}`;
    const applicationLeaked = applicationPublished.filter(
      (event) => "event" in event && event.event.threadId === legacyThreadId,
    );
    const sinkLeaked = sinkPublished.filter((event) => event.event.threadId === legacyThreadId);
    yield* Effect.logInfo("Real legacy shell rollback publication witness", {
      witness: {
        applicationPublishedEventIds: applicationLeaked.map((event) =>
          "event" in event ? event.event.id : null,
        ),
        sinkPublishedEventIds: sinkLeaked.map((event) => event.event.id),
        durableEventCount: durable.length,
        ledgerRows: ledger.length,
        historyPositionRows: positions.length,
        projectedThreadRows: threads.length,
        projectedMessageRows: messages.length,
      },
    });
    assert.isEmpty(durable);
    assert.isEmpty(ledger);
    assert.isEmpty(positions);
    assert.isEmpty(threads);
    assert.isEmpty(messages);
    assert.isEmpty(applicationLeaked);
    assert.isEmpty(sinkLeaked);
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(importerLayer));
});
