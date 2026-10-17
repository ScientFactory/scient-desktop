import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { makeSharedSshPreparation } from "./scientSshPreparation.ts";

const KEY = "user@host:22";
const BOUNDED = true;
const FULL = false;

// Counts how often a preparation job actually starts.
const harness = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const preparations = makeSharedSshPreparation<string>(scope, () => "still preparing");
  let runs = 0;
  const job = (outcome: Effect.Effect<void, string>) =>
    Effect.suspend(() => {
      runs += 1;
      return outcome;
    });
  return { await: preparations.await, job, runs: () => runs };
});

const failAfter = (duration: Duration.Input, error: string) =>
  Effect.sleep(duration).pipe(Effect.andThen(Effect.fail(error)));

describe("shared SSH preparation", () => {
  it.effect("lets a full-wait caller wait for the whole preparation", () =>
    Effect.gen(function* () {
      const prep = yield* harness;
      const onboarding = yield* Effect.forkChild(
        prep.await(KEY, prep.job(failAfter("60 seconds", "disk full")), FULL),
      );
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Effect.flip(Fiber.join(onboarding)), "disk full");
      yield* prep.await(KEY, prep.job(Effect.void), FULL);
      assert.equal(prep.runs(), 2);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "answers a saved connection within its budget and keeps a later failure for the next one",
    () =>
      Effect.gen(function* () {
        const prep = yield* harness;
        const first = yield* Effect.forkChild(
          prep.await(KEY, prep.job(failAfter("15500 millis", "disk full")), BOUNDED),
        );
        yield* TestClock.adjust("8 seconds");
        assert.equal(yield* Effect.flip(Fiber.join(first)), "still preparing");
        // The preparation fails while no attempt is waiting, during the retry backoff.
        yield* TestClock.adjust("8 seconds");
        assert.equal(
          yield* Effect.flip(prep.await(KEY, prep.job(Effect.void), BOUNDED)),
          "disk full",
        );
        assert.equal(prep.runs(), 1);
        yield* prep.await(KEY, prep.job(Effect.void), BOUNDED);
        assert.equal(prep.runs(), 2);
      }).pipe(Effect.scoped),
  );

  it.effect("gives an outcome inside the budget to the waiting caller, once", () =>
    Effect.gen(function* () {
      const prep = yield* harness;
      const waiting = yield* Effect.forkChild(
        prep.await(KEY, prep.job(failAfter("3 seconds", "refused")), BOUNDED),
      );
      yield* TestClock.adjust("3 seconds");
      assert.equal(yield* Effect.flip(Fiber.join(waiting)), "refused");
      yield* prep.await(KEY, prep.job(Effect.void), BOUNDED);
      assert.equal(prep.runs(), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a full-wait caller join a running preparation beyond the budget", () =>
    Effect.gen(function* () {
      const prep = yield* harness;
      const saved = yield* Effect.forkChild(
        prep.await(KEY, prep.job(Effect.sleep("60 seconds")), BOUNDED),
      );
      yield* Effect.yieldNow;
      const onboarding = yield* Effect.forkChild(prep.await(KEY, prep.job(Effect.void), FULL));
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Effect.flip(Fiber.join(saved)), "still preparing");
      yield* Fiber.join(onboarding);
      assert.equal(prep.runs(), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the preparation running when its caller is interrupted", () =>
    Effect.gen(function* () {
      const prep = yield* harness;
      const caller = yield* Effect.forkChild(
        prep.await(KEY, prep.job(failAfter("30 seconds", "disk full")), FULL),
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(caller);
      yield* TestClock.adjust("30 seconds");
      assert.equal(
        yield* Effect.flip(prep.await(KEY, prep.job(Effect.void), BOUNDED)),
        "disk full",
      );
      assert.equal(prep.runs(), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("starts one preparation per host for concurrent callers, and a newer one after", () =>
    Effect.gen(function* () {
      const prep = yield* harness;
      const callers = yield* Effect.forkChild(
        Effect.all(
          [1, 2, 3].map(() =>
            Effect.flip(prep.await(KEY, prep.job(failAfter("2 seconds", "refused")), BOUNDED)),
          ),
          { concurrency: "unbounded" },
        ),
      );
      yield* TestClock.adjust("2 seconds");
      assert.deepEqual(yield* Fiber.join(callers), ["refused", "refused", "refused"]);
      assert.equal(prep.runs(), 1);
      // The delivered outcome retires that job: the next caller starts a new one,
      // and a caller after it joins the new one rather than starting a third.
      const next = yield* Effect.forkChild(
        prep.await(KEY, prep.job(Effect.sleep("5 seconds")), BOUNDED),
      );
      yield* Effect.yieldNow;
      const joiner = yield* Effect.forkChild(prep.await(KEY, prep.job(Effect.void), BOUNDED));
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(next);
      yield* Fiber.join(joiner);
      assert.equal(prep.runs(), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("releases a waiting caller when the manager closes before its job starts", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const preparations = makeSharedSshPreparation<string>(scope, () => "still preparing");
      const caller = yield* Effect.forkChild(
        preparations.await(KEY, Effect.sleep("1 minute"), FULL),
      );
      yield* Scope.close(scope, Exit.void);
      const exit = yield* Fiber.await(caller);
      assert.isTrue(Exit.hasInterrupts(exit));
    }),
  );

  it.effect("keeps hosts independent", () =>
    Effect.gen(function* () {
      const prep = yield* harness;
      yield* Effect.forkChild(prep.await(KEY, prep.job(Effect.never), FULL));
      yield* Effect.yieldNow;
      yield* prep.await("user@other:22", prep.job(Effect.void), BOUNDED);
      assert.equal(prep.runs(), 2);
    }).pipe(Effect.scoped),
  );
});
