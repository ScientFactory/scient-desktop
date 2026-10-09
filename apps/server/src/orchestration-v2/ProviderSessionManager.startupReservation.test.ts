import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { reserveSessionForStartup } from "./scient-provider/StartupSessionHold.ts";
import {
  emptyState,
  modelSelection,
  CODEX_DRIVER,
  runtimePolicy,
  makeThreadCreatedEvent,
  makeProviderThread,
  makeTestLayer,
} from "./testkit/ProviderSessionManagerTestHarness.ts";

const setup = (fixtureName: string) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const now = yield* DateTime.now;
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName,
      projectId: yield* idAllocator.allocate.project({ fixtureName }),
    });
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: modelSelection.instanceId,
      threadId,
    });
    yield* eventSink.write({
      events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
    });
    return {
      idAllocator,
      threadId,
      providerSessionId,
      providerThread: makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
    };
  });

it.effect(
  "ProviderSessionManagerV2 keeps a reserved start's session through idle and unpaired turn terminals",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const { idAllocator, threadId, providerSessionId, providerThread } = yield* setup(
          "provider-session-manager-startup-reservation",
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            // Reserved before open: the timer armed by open cannot retire the pending start.
            yield* reserveSessionForStartup(manager, providerSessionId);
            yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
            yield* TestClock.adjust("2 seconds");
            yield* Effect.yieldNow;
            assert.equal((yield* Ref.get(state)).closeCount, 0);

            // Another turn's terminal is not paired with this start and cannot consume it.
            const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
            assert.isDefined(queue);
            yield* Queue.offer(queue!, {
              type: "turn.terminal",
              driver: CODEX_DRIVER,
              providerThreadId: providerThread.id,
              providerTurnId: idAllocator.derive.providerTurn({
                driver: CODEX_DRIVER,
                nativeTurnId: "compaction-turn",
              }),
              runOrdinal: 1,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* TestClock.adjust("2 seconds");
            yield* Effect.yieldNow;
            assert.equal((yield* Ref.get(state)).closeCount, 0);
          }),
        );

        // Ending the start re-arms the declined idle release.
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 1);
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      });

      yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 ends a startup reservation without re-arming a replacement session",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const { threadId, providerSessionId } = yield* setup(
          "provider-session-manager-startup-replacement",
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* reserveSessionForStartup(manager, providerSessionId);
            yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
            // The first runtime's idle retirement is declined while reserved.
            yield* TestClock.adjust("2 seconds");
            yield* Effect.yieldNow;
            assert.equal((yield* Ref.get(state)).closeCount, 0);
            // Explicit close ignores the reservation; a replacement arms its own timer.
            yield* manager.close(providerSessionId);
            assert.equal((yield* Ref.get(state)).closeCount, 1);
            yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
            assert.equal((yield* Ref.get(state)).openCount, 2);
            yield* TestClock.adjust("600 millis");
            yield* Effect.yieldNow;
          }),
        );

        // The replacement keeps its original deadline instead of a re-armed one.
        yield* TestClock.adjust("401 millis");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 2);
      });

      yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
    }),
);
