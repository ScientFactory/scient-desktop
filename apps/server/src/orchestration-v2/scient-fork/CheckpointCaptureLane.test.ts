import { assert, it } from "@effect/vitest";
import { CheckpointScopeId, CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as EffectWorker from "../EffectWorker.ts";

const threadId = ThreadId.make("thread:checkpoint-capture-lane");
const otherThreadId = ThreadId.make("thread:checkpoint-capture-lane:other");
const stoppedRunId = RunId.make("run:checkpoint-capture-lane:stopped");
const nextRunId = RunId.make("run:checkpoint-capture-lane:next");
const captureEffectId = `effect:checkpoint.capture:${stoppedRunId}`;

const captureEffect: EffectOutbox.PendingOrchestrationEffectV2 = {
  id: captureEffectId,
  commandId: CommandId.make(`command:effect:checkpoint.capture:${stoppedRunId}`),
  threadId,
  request: {
    type: "checkpoint.capture",
    runId: stoppedRunId,
    scopeId: CheckpointScopeId.make("checkpoint-scope:checkpoint-capture-lane"),
  },
};

const startEffect = (
  id: string,
  forThreadId: ThreadId,
  runId: RunId,
): EffectOutbox.PendingOrchestrationEffectV2 => ({
  id,
  commandId: CommandId.make(`command:${id}`),
  threadId: forThreadId,
  request: { type: "provider-turn.start", runId },
});

it.effect(
  "a later run's provider start waits for an earlier checkpoint capture that is waiting to retry",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const executed = yield* Ref.make<ReadonlyArray<string>>([]);
      const executorLayer = Layer.succeed(
        EffectWorker.OrchestrationEffectExecutorV2,
        EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: (effect) =>
            Effect.gen(function* () {
              const attempt = `${effect.id}#${effect.attemptCount}`;
              yield* Ref.update(executed, (entries) => [...entries, attempt]);
              // The stopped run's first capture fails before committing, e.g. on a
              // busy database, and the worker schedules a retry.
              if (effect.id === captureEffectId && effect.attemptCount === 1) {
                return yield* new EffectWorker.OrchestrationEffectExecutionError({
                  effectId: effect.id,
                  effectType: effect.request.type,
                  cause: "Synthetic capture commit failure",
                });
              }
            }),
        }),
      );
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
        Effect.provide(
          EffectWorker.layerWithOptions({ workerId: "checkpoint-capture-lane" }).pipe(
            Layer.provide(
              Layer.merge(Layer.succeed(EffectOutbox.EffectOutboxV2, outbox), executorLayer),
            ),
          ),
        ),
      );

      yield* outbox.enqueue([captureEffect]);
      assert.equal(yield* worker.drain(), 1);
      assert.deepEqual(yield* Ref.get(executed), [`${captureEffectId}#1`]);

      // The next message is sent while the capture waits for its retry. Another
      // thread's work is unaffected.
      yield* outbox.enqueue([
        startEffect("effect:next-start", threadId, nextRunId),
        startEffect("effect:other-thread-start", otherThreadId, nextRunId),
      ]);
      yield* worker.drain();
      assert.deepEqual(yield* Ref.get(executed), [
        `${captureEffectId}#1`,
        "effect:other-thread-start#1",
      ]);

      // At the retry deadline the capture runs first, then the start.
      yield* TestClock.adjust("100 millis");
      yield* worker.drain();
      assert.deepEqual(yield* Ref.get(executed), [
        `${captureEffectId}#1`,
        "effect:other-thread-start#1",
        `${captureEffectId}#2`,
        "effect:next-start#1",
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          EffectOutbox.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
          TestClock.layer(),
        ),
      ),
    ),
);
