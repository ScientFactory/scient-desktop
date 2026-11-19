import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { terminatePiProcess } from "./rpc.ts";

const group = (input: {
  /** Whether Pi itself, the group leader, exits on SIGTERM. */
  readonly leaderExits: boolean;
  /** How many group probes after SIGTERM still find a member running. */
  readonly probesUntilGone: number;
  /** What `hasExited` reports, when it differs from the leader (a recycled id). */
  readonly hasExited?: () => boolean;
}) => {
  const signals: Array<NodeJS.Signals> = [];
  let terminated = false;
  let probes = 0;
  return {
    signals,
    kill: (signal: NodeJS.Signals) => {
      signals.push(signal);
      if (signal === "SIGTERM") terminated = true;
      return true;
    },
    hasExited: input.hasExited ?? (() => terminated && input.leaderExits),
    groupGone: () => terminated && ++probes > input.probesUntilGone,
  };
};

const teardown = (pi: ReturnType<typeof group>) =>
  Effect.forkChild(terminatePiProcess(pi.kill, pi.hasExited, pi.groupGone));

describe("PiRpc teardown grace", () => {
  it.effect("returns once the whole group has exited during the grace", () =>
    Effect.gen(function* () {
      const pi = group({ leaderExits: true, probesUntilGone: 2 });
      const fiber = yield* teardown(pi);
      yield* TestClock.adjust("40 millis");
      assert.isUndefined(fiber.pollUnsafe(), "teardown returned while the group still ran");
      yield* TestClock.adjust("20 millis");
      assert.isDefined(fiber.pollUnsafe(), "teardown still waiting after the group exited");
      yield* Fiber.join(fiber);
      assert.deepEqual(pi.signals, ["SIGTERM"]);
    }),
  );

  it.effect("waits the full grace for extension children after Pi itself exits", () =>
    Effect.gen(function* () {
      const pi = group({ leaderExits: true, probesUntilGone: Infinity });
      const fiber = yield* teardown(pi);
      yield* TestClock.adjust("999 millis");
      assert.isUndefined(fiber.pollUnsafe(), "teardown ended while the group was still alive");
      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(fiber);
      // With the leader gone its group id may be recycled, so it is not escalated.
      assert.deepEqual(pi.signals, ["SIGTERM"]);
    }),
  );

  it.effect("never escalates a group it has seen gone", () =>
    Effect.gen(function* () {
      // The leader lookup succeeds again, as it would for a recycled id.
      const pi = group({ leaderExits: false, probesUntilGone: 0, hasExited: () => false });
      const fiber = yield* teardown(pi);
      yield* TestClock.adjust("20 millis");
      assert.isDefined(fiber.pollUnsafe(), "teardown still waiting after the group exited");
      yield* Fiber.join(fiber);
      assert.deepEqual(pi.signals, ["SIGTERM"]);
    }),
  );

  it.effect("sends SIGKILL when Pi outlives the grace", () =>
    Effect.gen(function* () {
      const pi = group({ leaderExits: false, probesUntilGone: Infinity });
      const fiber = yield* teardown(pi);
      yield* TestClock.adjust("999 millis");
      assert.deepEqual(pi.signals, ["SIGTERM"]);
      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(fiber);
      assert.deepEqual(pi.signals, ["SIGTERM", "SIGKILL"]);
    }),
  );
});
