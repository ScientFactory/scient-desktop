import { assert, it } from "@effect/vitest";
import { ProviderTurnId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  emptyState,
  modelSelection,
  CODEX_DRIVER,
  runtimePolicy,
  makeProviderSession,
  makeThreadCreatedEvent,
  makeProviderThread,
  makeTestLayer,
} from "./testkit/ProviderSessionManagerTestHarness.ts";

it.effect.each(
  (["ready", "running", "waiting"] as const).map((status) => ({
    caseTitle: `ProviderSessionManagerV2 retains a healthy live ${status} owner`,
    status,
  })),
)("$caseTitle", ({ status }) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const events = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const threadId = ThreadId.make(`healthy-live-${status}`);
      const providerSessionId = ProviderSessionId.make(`healthy-live-${status}`);
      yield* events.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now: yield* DateTime.now }),
        ],
      });
      const input = { threadId, providerSessionId, modelSelection, runtimePolicy };
      const original = yield* manager.open(input);
      assert.strictEqual(yield* manager.open(input), original);
      assert.equal((yield* Ref.get(state)).openCount, 1);
      assert.equal((yield* Ref.get(state)).closeCount, 0);
    }).pipe(
      Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000, liveStatus: () => status })),
    );
  }),
);

for (const status of ["error", "stopped"] as const) {
  it.effect.each(
    (["success", "pending", "failure"] as const).map((close) => ({
      caseTitle: `ProviderSessionManagerV2 retires the exact live ${status} owner only after ${close} close`,
      close,
    })),
  )("$caseTitle", ({ close }) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const closeEntered = yield* Deferred.make<void>();
      const closeRelease = yield* Deferred.make<void>();
      let unhealthy = false;
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const events = yield* EventSink.EventSinkV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const threadId = ThreadId.make(`unusable-live-${status}-${close}`);
        const providerSessionId = ProviderSessionId.make(`unusable-live-${status}-${close}`);
        yield* events.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator: ids,
              threadId,
              now: yield* DateTime.now,
            }),
          ],
        });
        const input = { threadId, providerSessionId, modelSelection, runtimePolicy };
        const original = yield* manager.open(input);
        assert.equal(original.providerSession.status, "ready");
        yield* Effect.sync(() => {
          unhealthy = true;
        });
        // The exposed opening snapshot remains ready; internal live status decides.
        assert.equal(original.providerSession.status, "ready");
        const reopening = yield* manager.open(input).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(closeEntered);
        assert.equal((yield* Ref.get(state)).openCount, 1);
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        if (close === "pending") {
          yield* TestClock.adjust("31 seconds");
          const refused = yield* Fiber.join(reopening);
          assert.isTrue(Exit.isFailure(refused));
          assert.equal(
            Option.getOrUndefined(yield* manager.getCloseState!(providerSessionId))?.state,
            "pending",
          );
          assert.isTrue(Exit.isFailure(yield* manager.open(input).pipe(Effect.exit)));
          assert.equal((yield* Ref.get(state)).openCount, 1);
        }
        yield* Deferred.succeed(closeRelease, undefined);
        const result = yield* Fiber.join(reopening);
        if (close === "failure") {
          assert.isTrue(Exit.isFailure(result));
          assert.equal(
            Option.getOrUndefined(yield* manager.getCloseState!(providerSessionId))?.state,
            "failed",
          );
          assert.isTrue(Exit.isFailure(yield* manager.open(input).pipe(Effect.exit)));
          assert.equal((yield* Ref.get(state)).openCount, 1);
        } else {
          if (close === "pending") yield* manager.close(providerSessionId);
          const replacement =
            close === "pending"
              ? yield* manager.open(input)
              : Exit.isSuccess(result)
                ? result.value
                : undefined;
          assert.ok(replacement);
          assert.notStrictEqual(replacement, original);
          assert.equal((yield* Ref.get(state)).openCount, 2);
          assert.strictEqual(yield* manager.open(input), replacement);
          assert.equal((yield* Ref.get(state)).closeCount, 1);
        }
      }).pipe(
        Effect.ensuring(Deferred.succeed(closeRelease, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 60_000,
            liveStatus: (ordinal) => (ordinal === 1 && unhealthy ? status : "ready"),
            closeSession: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(closeEntered, undefined);
                yield* Deferred.await(closeRelease);
                if (close === "failure")
                  return yield* Effect.die("Controlled exact-owner close failure");
              }),
          }),
        ),
      );
    }),
  );
}

it.effect.each(
  (["success", "failure", "interrupted-waiter"] as const).map((close) => ({
    caseTitle: `ProviderSessionManagerV2 joins exact sealed-prefix retirement with ${close} without losing peers or same-ID fencing`,
    close,
  })),
)("$caseTitle", ({ close }) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const closeEntered = yield* Deferred.make<void>();
    const closeRelease = yield* Deferred.make<void>();
    let stopped = false;
    const id = ProviderSessionId.make(`sealed-owner-${close}`);
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`sealed-owner-${close}`);
      const peerThreadId = ThreadId.make(`sealed-peer-${close}`);
      const peerId = ProviderSessionId.make(`sealed-peer-${close}`);
      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now }),
          yield* makeThreadCreatedEvent({ idAllocator: ids, threadId: peerThreadId, now }),
        ],
      });
      const input = { threadId, providerSessionId: id, modelSelection, runtimePolicy };
      const original = yield* manager.open(input);
      const peer = yield* manager.open({
        ...input,
        threadId: peerThreadId,
        providerSessionId: peerId,
      });
      const oldQueue = (yield* Ref.get(state)).eventQueues.get(String(id))!;
      const subscription = yield* original.subscribeEvents!;
      const prefix = yield* subscription.events.pipe(Stream.runCollect, Effect.forkScoped);
      const providerThread = makeProviderThread({
        idAllocator: ids,
        threadId,
        providerSessionId: id,
        now,
      });
      const interruption = yield* original
        .interruptTurn({ providerThread, providerTurnId: ProviderTurnId.make("sealed-turn") })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(closeEntered);
      assert.isUndefined(interruption.pollUnsafe());
      assert.isTrue(Option.isNone(yield* manager.get(id)));
      assert.equal(Option.getOrUndefined(yield* manager.getCloseState!(id))?.state, "pending");
      assert.isTrue(Exit.isFailure(yield* manager.open(input).pipe(Effect.exit)));
      assert.strictEqual(Option.getOrUndefined(yield* manager.get(peerId)), peer);
      const drained = Array.from(yield* Fiber.join(prefix));
      assert.deepEqual(
        drained.map((e) => e.type),
        ["provider_session.updated"],
      );
      assert.equal(
        drained[0]?.type === "provider_session.updated"
          ? drained[0].providerSession.status
          : undefined,
        "stopped",
      );
      if (close === "interrupted-waiter") yield* Fiber.interrupt(interruption);
      yield* Deferred.succeed(closeRelease, undefined);
      if (close === "interrupted-waiter") yield* manager.close(id);
      else assert.equal(Exit.isFailure(yield* Fiber.join(interruption)), close === "failure");
      assert.equal((yield* Ref.get(state)).closeCount, 1);
      if (close === "failure") {
        assert.equal(Option.getOrUndefined(yield* manager.getCloseState!(id))?.state, "failed");
        assert.isTrue(Exit.isFailure(yield* manager.open(input).pipe(Effect.exit)));
        assert.equal((yield* Ref.get(state)).openCount, 2);
      } else {
        assert.isTrue(Option.isNone(yield* manager.getCloseState!(id)));
        const replacement = yield* manager.open(input);
        assert.notStrictEqual(replacement, original);
        yield* Queue.end(oldQueue);
        assert.strictEqual(yield* manager.open(input), replacement);
        assert.strictEqual(Option.getOrUndefined(yield* manager.get(id)), replacement);
        assert.equal((yield* Ref.get(state)).openCount, 3);
      }
      assert.strictEqual(Option.getOrUndefined(yield* manager.get(peerId)), peer);
    }).pipe(
      Effect.ensuring(Deferred.succeed(closeRelease, undefined)),
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          liveStatus: (ordinal) => (ordinal === 1 && stopped ? "stopped" : "ready"),
          interruptSession: (sessionId, events) =>
            Effect.gen(function* () {
              assert.equal(sessionId, id);
              stopped = true;
              const providerSession = makeProviderSession({
                providerSessionId: id,
                now: yield* DateTime.now,
              });
              yield* Queue.offer(events, {
                type: "provider_session.updated",
                driver: CODEX_DRIVER,
                providerSession: { ...providerSession, status: "stopped" },
              });
              yield* Queue.end(events);
            }),
          closeSession: (sessionId) =>
            Effect.suspend(() =>
              sessionId !== id || !stopped
                ? Effect.void
                : Deferred.succeed(closeEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(closeRelease)),
                    Effect.andThen(
                      close === "failure" ? Effect.die("Original close unconfirmed") : Effect.void,
                    ),
                  ),
            ),
        }),
      ),
    );
  }),
);
