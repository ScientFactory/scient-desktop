import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { layer as OrchestrationEventStoreLive } from "../persistence/OrchestrationEventStore.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/OrchestrationEventStore.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const stores = Layer.mergeAll(
  EventStore.layerFromOrchestrationEventStore,
  ProjectionStore.layer,
  CommandReceiptStore.layer,
  EffectOutbox.layer,
  ProjectStore.layer,
  TurnItemPositionStore.layer,
).pipe(
  Layer.provideMerge(OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
);

const controls = [
  {
    phase: "body",
    name: "rolls back an interrupted transaction body without publishing and admits the next writer",
  },
  {
    phase: "publication",
    name: "delivers both live buses after a committed writer is interrupted and admits the next writer",
  },
  {
    phase: "ambient",
    name: "rejects an ambient SQL transaction before mutation and admits an ordinary write",
  },
] as const;

it.live.each(controls.map(({ phase, name }) => ({ caseTitle: name, phase, name })))(
  "$caseTitle",
  ({ phase, name }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const eventStore = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const applicationEvents = yield* OrchestrationEventStore;
      const gateReached = yield* Deferred.make<void>();
      const releaseGate = yield* Deferred.make<void>();
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`publication-cancellation:${phase}`);
      const targetId = EventId.make(`${phase}:target`);
      const instanceId = ProviderInstanceId.make("controlled-cancellation-provider");
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: ProjectId.make("controlled-cancellation-project"),
        title: "Before cancellation",
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
      // Only the scheduler yields are decorated. SQL, projection mutations and
      // both publication buses retain their real implementations.
      const controlledProjections = ProjectionStore.ProjectionStoreV2.of({
        ...projections,
        apply: (event) =>
          projections
            .apply(event)
            .pipe(
              Effect.andThen(
                phase === "body" && event.id === targetId
                  ? Deferred.succeed(gateReached, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseGate)),
                    )
                  : Effect.void,
              ),
            ),
      });
      const controlledEvents = EventStore.EventStoreV2.of({
        ...eventStore,
        publishCommitted: (events) =>
          Effect.gen(function* () {
            if (
              phase === "publication" &&
              events.some((entry) => "event" in entry && entry.event.id === targetId)
            ) {
              yield* Deferred.succeed(gateReached, undefined);
              yield* Deferred.await(releaseGate);
            }
            yield* eventStore.publishCommitted(events);
          }),
      });
      const sinkContext = yield* Layer.build(EventSink.layerFromStores).pipe(
        Effect.provideService(EventStore.EventStoreV2, controlledEvents),
        Effect.provideService(ProjectionStore.ProjectionStoreV2, controlledProjections),
      );
      const sink = Context.get(sinkContext, EventSink.EventSinkV2);
      const seed = (yield* sink.write({
        events: [
          {
            id: EventId.make(`${phase}:seed`),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
        ],
      }))[0]!;
      const target: OrchestrationV2DomainEvent = {
        id: targetId,
        type: "thread.metadata-updated",
        threadId,
        occurredAt: now,
        payload: { ...thread, title: "Inside interrupted write" },
      };
      const marker: OrchestrationV2DomainEvent = {
        ...target,
        id: EventId.make(`${phase}:next-writer`),
        payload: { ...thread, title: "Next writer succeeded" },
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
          Stream.takeUntil((event) => "event" in event && event.event.id === marker.id),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        const sinkReader = yield* sink.stream({ threadId, bounded: true }).pipe(
          Stream.tap((event) =>
            event.sequence === seed.sequence ? Deferred.succeed(sinkReady, undefined) : Effect.void,
          ),
          Stream.takeUntil((event) => event.event.id === marker.id),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Deferred.await(applicationReady);
        yield* Deferred.await(sinkReady);

        if (phase === "ambient") {
          // A bounded deadline also detects SQL/permit acquisition inversion.
          const result = yield* sql
            .withTransaction(sink.write({ events: [target] }))
            .pipe(Effect.exit, Effect.timeout("1 second"));
          assert.isTrue(Exit.isFailure(result));
          if (Exit.isSuccess(result)) return assert.fail("Expected ambient transaction rejection");
          assert.include(Cause.pretty(result.cause), "must own their SQL transaction");
        } else {
          const writer = yield* sink
            .write({ events: [target] })
            .pipe(Effect.forkScoped({ startImmediately: true }));
          yield* Deferred.await(gateReached);
          if (phase === "publication") {
            const committed = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
            assert.deepEqual(
              committed.map((entry) => entry.event.id),
              [seed.event.id, target.id],
            );
            assert.equal(
              (yield* projections.getThreadProjection(threadId)).thread.title,
              target.payload.title,
            );
          }
          const interruptRequested = yield* Deferred.make<void>();
          const interrupter = yield* Deferred.succeed(interruptRequested, undefined).pipe(
            Effect.andThen(Fiber.interrupt(writer)),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* Deferred.await(interruptRequested);
          if (phase === "body") {
            // Cancellation must complete while the transaction body stays gated.
            yield* Fiber.join(interrupter).pipe(Effect.timeout("1 second"));
          } else {
            // Release the actual publisher before waiting for interruption. A
            // correct protected publication tail cannot finish while gated.
            for (let turn = 0; turn < 16; turn++) yield* Effect.yieldNow;
            yield* Deferred.succeed(releaseGate, undefined);
            yield* Fiber.join(interrupter);
          }
          const interrupted = yield* Fiber.await(writer);
          assert.isTrue(Exit.isFailure(interrupted));
          if (Exit.isSuccess(interrupted)) return assert.fail("Expected requested interruption");
          assert.isTrue(Cause.hasInterrupts(interrupted.cause));
        }
        if (phase !== "publication") {
          const rolledBack = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
          assert.deepEqual(
            rolledBack.map((entry) => entry.event.id),
            [seed.event.id],
          );
          assert.equal(
            (yield* projections.getThreadProjection(threadId)).thread.title,
            thread.title,
          );
        }
        yield* sink.write({ events: [marker] });
        const applicationPublished = yield* Fiber.join(applicationReader);
        const sinkPublished = yield* Fiber.join(sinkReader);
        const durable = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
        const expected =
          phase === "publication"
            ? [seed.event.id, target.id, marker.id]
            : [seed.event.id, marker.id];
        const applicationIds = applicationPublished.map((entry) =>
          "event" in entry ? entry.event.id : null,
        );
        const sinkIds = sinkPublished.map((entry) => entry.event.id);
        yield* Effect.logInfo("Real EventSink cancellation witness", {
          phase,
          durableEventIds: durable.map((entry) => entry.event.id),
          applicationPublishedEventIds: applicationIds,
          sinkPublishedEventIds: sinkIds,
        });
        assert.deepEqual(
          durable.map((entry) => entry.event.id),
          expected,
        );
        assert.deepEqual(applicationIds, expected);
        assert.deepEqual(sinkIds, expected);
        assert.deepEqual(
          applicationPublished.map((entry) => entry.sequence),
          durable.map((entry) => entry.sequence),
        );
        assert.deepEqual(
          sinkPublished.map((entry) => entry.sequence),
          durable.map((entry) => entry.sequence),
        );
        assert.equal(
          (yield* projections.getThreadProjection(threadId)).thread.title,
          marker.payload.title,
        );
      }).pipe(Effect.ensuring(Deferred.succeed(releaseGate, undefined)));
    }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(stores)),
);
