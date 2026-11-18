import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { terminatePiProcess } from "./rpc.ts";

// Teardown sends SIGTERM, then waits at most one second for the process group before SIGKILL.
const group = (exitsAfterSigterm: boolean) => {
  const signals: Array<NodeJS.Signals> = [];
  return {
    signals,
    kill: (signal: NodeJS.Signals) => {
      signals.push(signal);
      return true;
    },
    hasExited: () => exitsAfterSigterm && signals.includes("SIGTERM"),
  };
};

describe("PiRpc teardown grace", () => {
  it.effect("stops waiting once the group has exited after SIGTERM", () =>
    Effect.gen(function* () {
      const pi = group(true);
      const teardown = yield* Effect.forkChild(terminatePiProcess(pi.kill, pi.hasExited));
      yield* TestClock.adjust("100 millis");
      assert.isDefined(teardown.pollUnsafe(), "teardown still waiting after the group exited");
      yield* Fiber.join(teardown);
      assert.deepEqual(pi.signals, ["SIGTERM"]);
    }),
  );

  it.effect("sends SIGKILL when the group outlives the grace", () =>
    Effect.gen(function* () {
      const pi = group(false);
      const teardown = yield* Effect.forkChild(terminatePiProcess(pi.kill, pi.hasExited));
      yield* TestClock.adjust("999 millis");
      assert.deepEqual(pi.signals, ["SIGTERM"]);
      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(teardown);
      assert.deepEqual(pi.signals, ["SIGTERM", "SIGKILL"]);
    }),
  );
});
