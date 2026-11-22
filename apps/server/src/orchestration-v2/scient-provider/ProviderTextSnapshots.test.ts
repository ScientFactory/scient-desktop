import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  ProviderTextSnapshotError,
  type ProviderAdapterV2InternalEvent,
  type ProviderAdapterV2SessionRuntime,
  type ProviderTextSnapshotBatch,
  type ProviderTextSnapshotOwner,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeProviderTextSnapshots } from "./ProviderTextSnapshots.ts";

const owner: ProviderTextSnapshotOwner = {
  threadId: ThreadId.make("thread:snapshot"),
  runId: RunId.make("run:snapshot"),
  activeAttemptId: RunAttemptId.make("attempt:snapshot"),
  rootNodeId: NodeId.make("node:snapshot"),
  runOrdinal: 1,
  providerThreadId: ProviderThreadId.make("provider-thread:snapshot"),
  nativeThreadId: "native-thread",
  providerTurnId: ProviderTurnId.make("provider-turn:snapshot"),
  nativeTurnId: "native-turn",
  providerSessionId: ProviderSessionId.make("session:snapshot"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
};
const {
  nativeThreadId: _thread,
  providerTurnId: _turn,
  nativeTurnId: _native,
  ...consumerOwner
} = owner;
const projection = {
  workspaceRoot: "/workspace",
  sourceSequence: 7,
  projection: {} as OrchestrationV2ThreadProjection,
};

class WriteFailed extends Schema.TaggedError<WriteFailed>()("WriteFailed", {}) {}

type ConsumerQueue = Queue.Queue<
  { readonly type: "event"; readonly event: ProviderAdapterV2InternalEvent },
  Cause.Done
>;

/**
 * A Codex-like runtime whose capture request is answered through the registry's own route, as
 * the session pump answers it, and a run consumer that writes each batch it receives.
 */
const fixture = Effect.fn("fixture")(function* (options?: {
  readonly withSnapshots?: boolean;
  readonly write?: Effect.Effect<typeof projection, WriteFailed>;
  readonly answer?: boolean;
}) {
  const ended = yield* Deferred.make<never, ProviderTextSnapshotError>();
  const released: Array<symbol> = [];
  const routeRef: { route?: (batch: ProviderTextSnapshotBatch) => Effect.Effect<void> } = {};
  const runtime = {
    instanceId: owner.providerInstanceId,
    driver: owner.driver,
    providerSessionId: owner.providerSessionId,
    ...(options?.withSnapshots === false
      ? {}
      : {
          textSnapshots: {
            events: Stream.empty,
            ended: Deferred.await(ended),
            request: (requestOwner: ProviderTextSnapshotOwner, token: symbol) =>
              options?.answer === false
                ? Effect.void
                : (routeRef.route?.({
                    type: "internal.text_snapshot",
                    token,
                    owner: requestOwner,
                    watermark: 3,
                    events: [],
                  }) ?? Effect.void),
            withCurrent: <A, E, R>(
              _token: symbol,
              _watermark: number | undefined,
              commit: Effect.Effect<A, E, R>,
            ) => commit,
            release: (token: symbol) =>
              Effect.sync(() => {
                released.push(token);
              }),
          },
        }),
  } as unknown as ProviderAdapterV2SessionRuntime;
  const scope = yield* Scope.make();
  const sessions = yield* Ref.make(
    new Map([
      [
        owner.providerSessionId as string,
        { runtime, scope, attachedThreadIds: new Set([owner.threadId]) },
      ],
    ]),
  );
  const releasing = new WeakSet<ProviderAdapterV2SessionRuntime>();
  const registry = yield* makeProviderTextSnapshots({
    sessions,
    sessionKey: (id) => id,
    releasingRuntimes: releasing,
  });
  routeRef.route = (batch) => registry.route(runtime, batch);
  const queue: ConsumerQueue = yield* Queue.unbounded<
    { readonly type: "event"; readonly event: ProviderAdapterV2InternalEvent },
    Cause.Done
  >();
  const subscription = registry.subscription({
    subscriberId: 1,
    runtime,
    queue,
    events: Stream.empty,
    close: Effect.void,
  });
  const write = options?.write ?? Effect.succeed(projection);
  // The run consumer: it writes each snapshot batch routed to it.
  yield* Effect.forkScoped(
    Effect.forever(
      Queue.take(queue).pipe(
        Effect.flatMap(({ event }) =>
          event.type === "internal.text_snapshot"
            ? subscription.textSnapshotConsumer.consume(event, write)
            : Effect.void,
        ),
      ),
    ),
  );
  return { registry, runtime, sessions, subscription, released, ended, releasing };
});

it.effect("captures through the run's own consumer and releases the native token", () =>
  Effect.gen(function* () {
    const { registry, subscription, released } = yield* fixture();
    yield* subscription.textSnapshotConsumer.bind(consumerOwner);

    const captured = yield* registry.manager.captureRunningForkText!(owner);

    assert.equal(captured.owner, owner);
    assert.equal(captured.watermark, 3);
    assert.equal(captured.sourceSequence, projection.sourceSequence);
    assert.equal(
      yield* registry.manager.withCapturedForkText!(captured, Effect.succeed("ok")),
      "ok",
    );
    yield* registry.manager.releaseCapturedForkText!(captured);
    assert.deepEqual(released, [captured.token]);
    // A released capture cannot commit the fork any more.
    const after = yield* Effect.flip(
      registry.manager.withCapturedForkText!(captured, Effect.succeed("late")),
    );
    assert.equal(after.reason, "owner-lost");
  }).pipe(Effect.scoped),
);

it.effect("refuses a capture it cannot own", () =>
  Effect.gen(function* () {
    const unsupported = yield* fixture({ withSnapshots: false });
    assert.equal(
      (yield* Effect.flip(unsupported.registry.manager.captureRunningForkText!(owner))).reason,
      "unsupported",
    );
    const unbound = yield* fixture();
    assert.equal(
      (yield* Effect.flip(unbound.registry.manager.captureRunningForkText!(owner))).reason,
      "consumer-ended",
    );
    const detached = yield* fixture();
    yield* detached.subscription.textSnapshotConsumer.bind(consumerOwner);
    assert.equal(
      (yield* Effect.flip(
        detached.registry.manager.captureRunningForkText!({
          ...owner,
          threadId: ThreadId.make("thread:other"),
        }),
      )).reason,
      "owner-lost",
    );
    detached.releasing.add(detached.runtime);
    assert.equal(
      (yield* Effect.flip(detached.registry.manager.captureRunningForkText!(owner))).reason,
      "owner-lost",
    );
  }).pipe(Effect.scoped),
);

it.effect("allows one pending capture per run owner", () =>
  Effect.gen(function* () {
    const { registry, subscription } = yield* fixture({ answer: false });
    yield* subscription.textSnapshotConsumer.bind(consumerOwner);
    const first = yield* Effect.forkChild(registry.manager.captureRunningForkText!(owner));
    yield* Effect.yieldNow;
    assert.equal(
      (yield* Effect.flip(registry.manager.captureRunningForkText!(owner))).reason,
      "busy",
    );
    yield* Fiber.interrupt(first);
  }).pipe(Effect.scoped),
);

it.effect(
  "ends a waiting capture when its run retires, its consumer closes or its write fails",
  () =>
    Effect.gen(function* () {
      const retired = yield* fixture({ answer: false });
      yield* retired.subscription.textSnapshotConsumer.bind(consumerOwner);
      const waiting = yield* Effect.forkChild(
        Effect.flip(retired.registry.manager.captureRunningForkText!(owner)),
      );
      yield* Effect.yieldNow;
      yield* retired.registry.retire(retired.runtime);
      assert.equal((yield* Fiber.join(waiting)).reason, "owner-lost");

      const closed = yield* fixture({ answer: false });
      yield* closed.subscription.textSnapshotConsumer.bind(consumerOwner);
      const closing = yield* Effect.forkChild(
        Effect.flip(closed.registry.manager.captureRunningForkText!(owner)),
      );
      yield* Effect.yieldNow;
      yield* closed.registry.closeSubscription(1, Effect.void);
      assert.equal((yield* Fiber.join(closing)).reason, "consumer-ended");

      const failing = yield* fixture({ write: Effect.fail(new WriteFailed()) });
      yield* failing.subscription.textSnapshotConsumer.bind(consumerOwner);
      assert.equal(
        (yield* Effect.flip(failing.registry.manager.captureRunningForkText!(owner))).reason,
        "capture-failed",
      );
    }).pipe(Effect.scoped),
);

it.effect("gives up after its pre-admission deadline and releases its native token", () =>
  Effect.gen(function* () {
    const { registry, subscription, released } = yield* fixture({ answer: false });
    yield* subscription.textSnapshotConsumer.bind(consumerOwner);
    const waiting = yield* Effect.forkChild(
      Effect.flip(registry.manager.captureRunningForkText!(owner)),
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust("12 seconds");
    assert.equal((yield* Fiber.join(waiting)).reason, "timed-out");
    assert.lengthOf(released, 1);
  }).pipe(Effect.scoped),
);

it.effect("refuses a commit once the captured session is replaced", () =>
  Effect.gen(function* () {
    const { registry, subscription, sessions } = yield* fixture();
    yield* subscription.textSnapshotConsumer.bind(consumerOwner);
    const captured = yield* registry.manager.captureRunningForkText!(owner);
    yield* Ref.set(sessions, new Map());
    const refused = yield* Effect.flip(
      registry.manager.withCapturedForkText!(captured, Effect.succeed("stale")),
    );
    assert.instanceOf(refused, ProviderTextSnapshotError);
    assert.equal(refused.reason, "owner-lost");
  }).pipe(Effect.scoped),
);
