import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { ProjectionStoreReadError } from "../ProjectionStore.ts";
import { pendingStartPreparation } from "./PendingStartOwner.ts";

const threadId = ThreadId.make("preparation-thread");
const runId = RunId.make("preparation-run");
const rootNodeId = NodeId.make("preparation-root");

function stopEvent(owner: {
  threadId: ThreadId;
  runId: RunId;
  nodeId: NodeId;
}): OrchestrationV2StoredEvent {
  const now = DateTime.makeUnsafe("2026-10-12T10:00:00Z");
  return {
    sequence: 1,
    commandId: null,
    event: {
      id: EventId.make("stop-request-event"),
      type: "turn-item.updated",
      ...owner,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("stop-request-item"),
        ...owner,
        providerThreadId: ProviderThreadId.make("preparation-provider-thread"),
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        message: "Stop requested",
      },
    },
  };
}

it.effect.each(["already-stopped", "cursor-subscription-gap"])(
  "declines preparation after Stop: %s",
  (timing) =>
    Effect.gen(function* () {
      let eligible = timing !== "already-stopped";
      let preparations = 0;
      let closed = 0;
      const prepare = pendingStartPreparation({
        threadId,
        runId,
        rootNodeId,
        shouldStartProviderTurn: () => Effect.succeed(eligible),
        eventSink: {
          latestSequence: () =>
            Effect.sync(() => {
              if (timing === "cursor-subscription-gap") eligible = false;
              return 0;
            }),
          stream: () =>
            Stream.unwrap(
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    closed += 1;
                  }),
                );
                return Stream.succeed(stopEvent({ threadId, runId, nodeId: rootNodeId }));
              }),
            ),
        },
      });
      yield* prepare(
        Effect.sync(() => {
          preparations += 1;
        }),
      );
      assert.equal(preparations, 0);
      assert.equal(closed, 0, "An unused lazy stream acquires no subscription");
    }).pipe(Effect.scoped),
);

it.effect.each(["other-thread", "other-run", "superseded-root"])(
  "ignores a Stop for %s while preparing this owner",
  (foreign) =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
      const started = yield* Deferred.make<void>();
      const subscribed = yield* Deferred.make<void>();
      const foreignConsumed = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      let eligible = true;
      let closed = 0;
      const prepare = pendingStartPreparation({
        threadId,
        runId,
        rootNodeId,
        shouldStartProviderTurn: () => Effect.succeed(eligible),
        eventSink: {
          latestSequence: () => Effect.succeed(0),
          stream: () =>
            Stream.unwrap(
              Effect.gen(function* () {
                const subscription = yield* PubSub.subscribe(events);
                yield* Deferred.succeed(subscribed, undefined);
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    closed += 1;
                  }),
                );
                return Stream.fromSubscription(subscription).pipe(
                  Stream.tap(() => Deferred.succeed(foreignConsumed, undefined)),
                );
              }),
            ),
        },
      });
      const preparing = yield* prepare(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Deferred.await(subscribed);
      eligible = false;
      yield* PubSub.publish(
        events,
        stopEvent({
          threadId: foreign === "other-thread" ? ThreadId.make("foreign-thread") : threadId,
          runId: foreign === "other-run" ? RunId.make("foreign-run") : runId,
          nodeId: foreign === "superseded-root" ? NodeId.make("old-root") : rootNodeId,
        }),
      );
      yield* Deferred.await(foreignConsumed);
      yield* Effect.yieldNow;
      assert.isFalse(yield* Deferred.isDone(interrupted));
      yield* PubSub.publish(events, stopEvent({ threadId, runId, nodeId: rootNodeId }));
      yield* Fiber.join(preparing);
      assert.isTrue(yield* Deferred.isDone(interrupted));
      assert.equal(closed, 1);
    }).pipe(Effect.scoped),
);

it.effect("closes the Stop subscription when preparation finishes, before native offering", () =>
  Effect.gen(function* () {
    let closed = 0;
    const subscribed = yield* Deferred.make<void>();
    const prepare = pendingStartPreparation({
      threadId,
      runId,
      rootNodeId,
      shouldStartProviderTurn: () => Effect.succeed(true),
      eventSink: {
        latestSequence: () => Effect.succeed(0),
        stream: () =>
          Stream.unwrap(
            Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed += 1;
              }),
            ).pipe(
              Effect.andThen(Deferred.succeed(subscribed, undefined)),
              Effect.as(Stream.never),
            ),
          ),
      },
    });
    yield* prepare(Deferred.await(subscribed));
    assert.equal(closed, 1);
  }).pipe(Effect.scoped),
);

it.effect("a failed ownership read prevents preparation without acquiring a subscription", () =>
  Effect.gen(function* () {
    let prepared = false;
    let closed = 0;
    const prepare = pendingStartPreparation({
      threadId,
      runId,
      rootNodeId,
      shouldStartProviderTurn: () =>
        Effect.fail(new ProjectionStoreReadError({ threadId, cause: "Read failed" })),
      eventSink: {
        latestSequence: () => Effect.succeed(0),
        stream: () =>
          Stream.unwrap(
            Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed += 1;
              }),
            ).pipe(Effect.as(Stream.never)),
          ),
      },
    });
    const result = yield* Effect.exit(
      prepare(
        Effect.sync(() => {
          prepared = true;
        }),
      ),
    );
    assert.isTrue(Exit.isFailure(result));
    assert.isFalse(prepared);
    assert.equal(closed, 0);
  }).pipe(Effect.scoped),
);
