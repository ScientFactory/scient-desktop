import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { terminatePiProcess } from "./rpc.ts";

// Teardown sends SIGTERM, then waits at most one second for the whole process group before SIGKILL.
// The group is Pi (the leader) plus any extension children it started.
const group = (onSigterm: { readonly leaderExits: boolean; readonly childrenExit: boolean }) => {
  const signals: Array<NodeJS.Signals> = [];
  let leader = true;
  let children = true;
  return {
    signals,
    kill: (signal: NodeJS.Signals | 0) => {
      if (!leader && !children) return false;
      if (signal === 0) return true;
      signals.push(signal);
      if (signal === "SIGTERM") {
        leader = !onSigterm.leaderExits;
        children = !onSigterm.childrenExit;
      }
      return true;
    },
    // As in rpc.ts: true once the direct child has exited, whatever its group still holds.
    hasExited: () => !leader,
  };
};

describe("PiRpc teardown grace", () => {
  it.effect("stops waiting once the whole group has exited after SIGTERM", () =>
    Effect.gen(function* () {
      const pi = group({ leaderExits: true, childrenExit: true });
      const teardown = yield* Effect.forkChild(terminatePiProcess(pi.kill, pi.hasExited));
      yield* TestClock.adjust("100 millis");
      assert.isDefined(teardown.pollUnsafe(), "teardown still waiting after the group exited");
      yield* Fiber.join(teardown);
      assert.deepEqual(pi.signals, ["SIGTERM"]);
    }),
  );

  it.effect("keeps the grace for extension children when only Pi itself has exited", () =>
    Effect.gen(function* () {
      const pi = group({ leaderExits: true, childrenExit: false });
      const teardown = yield* Effect.forkChild(terminatePiProcess(pi.kill, pi.hasExited));
      yield* TestClock.adjust("999 millis");
      assert.isUndefined(teardown.pollUnsafe(), "teardown ended while the group was still alive");
      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(teardown);
      // Unchanged from T3: with the leader gone, its group id may be recycled, so no SIGKILL.
      assert.deepEqual(pi.signals, ["SIGTERM"]);
    }),
  );

  it.effect("sends SIGKILL when Pi outlives the grace", () =>
    Effect.gen(function* () {
      const pi = group({ leaderExits: false, childrenExit: false });
      const teardown = yield* Effect.forkChild(terminatePiProcess(pi.kill, pi.hasExited));
      yield* TestClock.adjust("999 millis");
      assert.deepEqual(pi.signals, ["SIGTERM"]);
      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(teardown);
      assert.deepEqual(pi.signals, ["SIGTERM", "SIGKILL"]);
    }),
  );
});
