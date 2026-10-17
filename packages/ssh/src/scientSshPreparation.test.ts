import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { makeSharedSshPreparation } from "./scientSshPreparation.ts";

const KEY = "user@host:22";

// Counts how often the shared preparation actually runs.
function harness() {
  const preparations = makeSharedSshPreparation<string, string>(() => "still preparing");
  let runs = 0;
  const prepare = (outcome: Effect.Effect<string, string>) =>
    Effect.suspend(() => {
      runs += 1;
      return outcome;
    });
  return { run: preparations.run, prepare, runs: () => runs };
}

describe("shared SSH preparation", () => {
  it.effect("returns a lone caller's failure without replaying it", () =>
    Effect.gen(function* () {
      const { run, prepare, runs } = harness();
      assert.equal(yield* Effect.flip(run(KEY, prepare(Effect.fail("disk full")))), "disk full");
      assert.equal(yield* run(KEY, prepare(Effect.succeed("ready"))), "ready");
      assert.equal(runs(), 2);
    }),
  );

  it.effect("answers a retry within its budget and replays the later failure once", () =>
    Effect.gen(function* () {
      const { run, prepare, runs } = harness();
      const slowFailure = Effect.sleep("60 seconds").pipe(Effect.andThen(Effect.fail("disk full")));
      const abandoned = yield* Effect.forkChild(run(KEY, prepare(slowFailure)));
      yield* Effect.yieldNow;
      const retry = yield* Effect.forkChild(run(KEY, prepare(Effect.succeed("unused"))));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("8 seconds");
      assert.equal(yield* Effect.flip(Fiber.join(retry)), "still preparing");

      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Effect.flip(Fiber.join(abandoned)), "disk full");
      assert.equal(yield* Effect.flip(run(KEY, prepare(Effect.succeed("unused")))), "disk full");
      assert.equal(runs(), 1);

      assert.equal(yield* run(KEY, prepare(Effect.succeed("ready"))), "ready");
      assert.equal(runs(), 2);
    }),
  );

  it.effect("lets a retry prepare again after the preparation it waited for succeeds", () =>
    Effect.gen(function* () {
      const { run, prepare, runs } = harness();
      const slowSuccess = Effect.sleep("3 seconds").pipe(Effect.as("first"));
      const first = yield* Effect.forkChild(run(KEY, prepare(slowSuccess)));
      yield* Effect.yieldNow;
      const retry = yield* Effect.forkChild(run(KEY, prepare(Effect.succeed("reused"))));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("3 seconds");
      assert.equal(yield* Fiber.join(first), "first");
      assert.equal(yield* Fiber.join(retry), "reused");
      assert.equal(runs(), 2);
    }),
  );

  it.effect("gives a failure within the budget to the waiting retry and does not replay it", () =>
    Effect.gen(function* () {
      const { run, prepare, runs } = harness();
      const quickFailure = Effect.sleep("3 seconds").pipe(Effect.andThen(Effect.fail("refused")));
      const first = yield* Effect.forkChild(run(KEY, prepare(quickFailure)));
      yield* Effect.yieldNow;
      const retry = yield* Effect.forkChild(run(KEY, prepare(Effect.succeed("unused"))));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("3 seconds");
      assert.equal(yield* Effect.flip(Fiber.join(first)), "refused");
      assert.equal(yield* Effect.flip(Fiber.join(retry)), "refused");
      assert.equal(yield* run(KEY, prepare(Effect.succeed("ready"))), "ready");
      assert.equal(runs(), 2);
    }),
  );

  it.effect("lets a waiting retry prepare itself when the preparation is interrupted", () =>
    Effect.gen(function* () {
      const { run, prepare, runs } = harness();
      const first = yield* Effect.forkChild(run(KEY, prepare(Effect.never)));
      yield* Effect.yieldNow;
      const retry = yield* Effect.forkChild(run(KEY, prepare(Effect.succeed("ready"))));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(first);
      assert.equal(yield* Fiber.join(retry), "ready");
      assert.equal(runs(), 2);
    }),
  );

  it.effect("keeps hosts independent", () =>
    Effect.gen(function* () {
      const { run, prepare } = harness();
      const busy = yield* Effect.forkChild(run(KEY, prepare(Effect.never)));
      yield* Effect.yieldNow;
      assert.equal(yield* run("user@other:22", prepare(Effect.succeed("ready"))), "ready");
      yield* Fiber.interrupt(busy);
    }),
  );
});
