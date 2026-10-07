import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

const testLayer = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistenceMemory));

it.effect("broadcasts durable terminal transitions independently of worker availability", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const cleanupSubscription = yield* outbox.subscribeCompletions;
    const secondSubscription = yield* outbox.subscribeCompletions;
    const threadId = ThreadId.make("thread:completion-hints");
    yield* outbox.enqueue([
      {
        id: "effect:completion-hints",
        threadId,
        commandId: CommandId.make("command:completion-hints"),
        request: { type: "terminal.cleanup" },
      },
    ]);
    const claimed = yield* outbox.claimNext({
      workerId: "completion-test",
      leaseDurationMs: 30_000,
    });
    assert.isTrue(Option.isSome(claimed));
    if (Option.isNone(claimed)) return;
    assert.isFalse(yield* outbox.succeed({ effectId: claimed.value.id, workerId: "stale-worker" }));
    assert.strictEqual(Option.getOrNull(yield* outbox.get(claimed.value.id))?.status, "running");
    assert.isTrue(
      yield* outbox.succeed({ effectId: claimed.value.id, workerId: "completion-test" }),
    );
    // Cleanup observers cannot consume the worker's wake or each other's wake.
    yield* outbox.awaitAvailable;
    yield* Stream.runCollect(cleanupSubscription.pipe(Stream.take(1)));
    yield* Stream.runCollect(secondSubscription.pipe(Stream.take(1)));
    assert.strictEqual(Option.getOrNull(yield* outbox.get(claimed.value.id))?.status, "succeeded");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("publishes cancellation only after its durable transaction commits", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const subscription = yield* outbox.subscribeCompletions;
    const threadId = ThreadId.make("thread:cancel-completion");
    yield* outbox.enqueue([
      {
        id: "effect:cancel-completion",
        threadId,
        commandId: CommandId.make("command:cancel-completion"),
        request: { type: "terminal.cleanup" },
      },
    ]);
    const ids = yield* outbox.cancelUnsettled({
      threadId,
      effectTypes: ["terminal.cleanup"],
      reason: "cancelled",
    });
    assert.deepStrictEqual(ids, ["effect:cancel-completion"]);
    yield* outbox.signalCancellations(ids);
    yield* Stream.runCollect(subscription.pipe(Stream.take(1)));
    assert.strictEqual(Option.getOrNull(yield* outbox.get(ids[0]!))?.status, "cancelled");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
