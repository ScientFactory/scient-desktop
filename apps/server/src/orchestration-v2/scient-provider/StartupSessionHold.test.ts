import { assert, it } from "@effect/vitest";
import { ProviderSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import type { ProviderAdapterV2SessionRuntime } from "../ProviderAdapter.ts";
import { makeStartupSessionReservations } from "./StartupSessionHold.ts";

const providerSessionId = ProviderSessionId.make("provider-session:startup-hold");
const key = String(providerSessionId);
const runtimeA = { label: "A" } as unknown as ProviderAdapterV2SessionRuntime;
const runtimeB = { label: "B" } as unknown as ProviderAdapterV2SessionRuntime;

type Entry = {
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly idleGeneration: number;
  readonly busyCount: number;
  readonly idleFiber: Fiber.Fiber<void, never> | null;
  readonly lastActivityAtMs: number;
};

const entry = (
  runtime: ProviderAdapterV2SessionRuntime,
  idleFiber: Fiber.Fiber<void, never> | null,
): Entry => ({ runtime, idleGeneration: 1, busyCount: 0, idleFiber, lastActivityAtMs: 0 });

/** A runtime A whose idle retirement was declined while one start held its reservation. */
const makeScenario = (
  onForkIdleTimer: (sessions: Ref.Ref<Map<string, Entry>>) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map([[key, entry(runtimeA, null)]]));
    const cancelled: Array<Fiber.Fiber<void, never>> = [];
    const forked: Array<{
      readonly generation: number;
      readonly expectedRuntime: ProviderAdapterV2SessionRuntime;
      readonly fiber: Fiber.Fiber<void, never>;
    }> = [];
    const reservations = makeStartupSessionReservations({
      sessions,
      sessionKey: String,
      isReleasing: () => false,
      cancelIdleFiber: (fiber) => {
        if (fiber === null) return Effect.void;
        cancelled.push(fiber);
        return Fiber.interrupt(fiber).pipe(Effect.ignore);
      },
      forkIdleTimer: (input) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkDetach(Effect.never);
          forked.push({ ...input, fiber });
          yield* onForkIdleTimer(sessions);
          return fiber;
        }),
    });
    const timerB = yield* Effect.forkDetach(Effect.never);
    return { sessions, cancelled, forked, reservations, timerB };
  });

it.effect("re-arms the exact declined runtime when its start ends", () =>
  Effect.gen(function* () {
    const { sessions, cancelled, forked, reservations } = yield* makeScenario(() => Effect.void);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* reservations.reserve(providerSessionId);
        assert.isTrue(
          reservations.declinesIdleRetirement(providerSessionId, entry(runtimeA, null)),
        );
      }),
    );
    assert.equal(forked.length, 1);
    assert.equal(forked[0]!.generation, 2);
    assert.strictEqual(forked[0]!.expectedRuntime, runtimeA);
    const current = (yield* Ref.get(sessions)).get(key)!;
    assert.strictEqual(current.runtime, runtimeA);
    assert.equal(current.idleGeneration, 2);
    assert.strictEqual(current.idleFiber, forked[0]!.fiber);
    assert.deepEqual(cancelled, []);
    assert.isFalse(reservations.declinesIdleRetirement(providerSessionId, current));
  }),
);

it.effect("does not touch a replacement that took the id before the start ended", () =>
  Effect.gen(function* () {
    const { sessions, cancelled, forked, reservations, timerB } = yield* makeScenario(
      () => Effect.void,
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* reservations.reserve(providerSessionId);
        assert.isTrue(
          reservations.declinesIdleRetirement(providerSessionId, entry(runtimeA, null)),
        );
        // Explicit close of A, then B opens under the same id with its own timer.
        yield* Ref.set(sessions, new Map([[key, entry(runtimeB, timerB)]]));
      }),
    );
    assert.deepEqual(forked, []);
    assert.deepEqual(cancelled, []);
    const current = (yield* Ref.get(sessions)).get(key)!;
    assert.strictEqual(current.runtime, runtimeB);
    assert.strictEqual(current.idleFiber, timerB);
  }),
);

it.effect("discards its timer when a replacement takes the id between claim and install", () =>
  Effect.gen(function* () {
    let replacement: Entry | undefined;
    const { sessions, cancelled, forked, reservations, timerB } = yield* makeScenario((sessions) =>
      // The finalizer is suspended after its claim: A is closed and B opens.
      Ref.set(sessions, new Map([[key, replacement!]])),
    );
    replacement = entry(runtimeB, timerB);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* reservations.reserve(providerSessionId);
        assert.isTrue(
          reservations.declinesIdleRetirement(providerSessionId, entry(runtimeA, null)),
        );
      }),
    );
    assert.equal(forked.length, 1);
    const current = (yield* Ref.get(sessions)).get(key)!;
    // B keeps its own generation and timer; only A's stale timer is cancelled.
    assert.strictEqual(current, replacement);
    assert.deepEqual(cancelled, [forked[0]!.fiber]);
  }),
);

it.effect(
  "discards its timer when new activity re-arms the runtime between claim and install",
  () =>
    Effect.gen(function* () {
      const { sessions, cancelled, forked, reservations, timerB } = yield* makeScenario(
        (sessions) =>
          // Ordinary activity on A advances its generation and installs its own timer.
          Ref.update(sessions, (current) => {
            const updated = new Map(current);
            updated.set(key, { ...current.get(key)!, idleGeneration: 3, idleFiber: timerB });
            return updated;
          }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* reservations.reserve(providerSessionId);
          assert.isTrue(
            reservations.declinesIdleRetirement(providerSessionId, entry(runtimeA, null)),
          );
        }),
      );
      const current = (yield* Ref.get(sessions)).get(key)!;
      assert.equal(current.idleGeneration, 3);
      assert.strictEqual(current.idleFiber, timerB);
      assert.deepEqual(cancelled, [forked[0]!.fiber]);
    }),
);
