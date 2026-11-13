import { assert, it } from "@effect/vitest";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeNativeSessionShutdown } from "./NativeSessionShutdown.ts";

type NativeAdapter = ProviderAdapter.ProviderAdapterV2["Service"];
type OpenSessionInput = Parameters<NativeAdapter["openSession"]>[0];

// Quitting gives the server a few seconds before it is force-killed, and a force-killed server
// stops nothing it started. With many sessions open, closing them one after another does not fit.
it.effect("closes every owned session at the same time", () =>
  Effect.gen(function* () {
    const closed: Array<string> = [];
    const native = {
      driver: "test",
      openSession: (input: OpenSessionInput) =>
        Effect.gen(function* () {
          // Each session takes a second to stop, like a provider CLI asked to exit.
          yield* Effect.addFinalizer(() =>
            Effect.sleep("1 second").pipe(
              Effect.andThen(Effect.sync(() => closed.push(String(input.providerSessionId)))),
            ),
          );
          return { driver: "test", events: Stream.never } as never;
        }),
    } as unknown as NativeAdapter;
    const { adapter, closeSessions } = yield* makeNativeSessionShutdown(native);
    for (const id of ["a", "b", "c"]) {
      yield* adapter.openSession({ providerSessionId: id } as unknown as OpenSessionInput);
    }

    const closing = yield* Effect.forkChild(closeSessions);
    yield* TestClock.adjust("1 second");
    const closedAfterOneSecond = [...closed];
    const doneAfterOneSecond = closing.pollUnsafe() !== undefined;
    // Let any remaining closes finish so a failure reports instead of hanging the scope.
    yield* TestClock.adjust("10 seconds");
    yield* Fiber.join(closing);
    assert.sameMembers(closedAfterOneSecond, ["a", "b", "c"]);
    assert.isTrue(doneAfterOneSecond);
  }).pipe(Effect.scoped),
);
