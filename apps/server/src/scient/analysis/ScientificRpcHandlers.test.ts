import { WS_METHODS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeScientificRpcHandlers } from "./ScientificRpcHandlers.ts";

it.effect("reports running work once, then only when the count changes", () =>
  Effect.gen(function* () {
    const sessions = yield* Ref.make(0);
    const files = yield* Ref.make(0);
    const handlers = makeScientificRpcHandlers({
      observeRpcEffect: <A, E, R>(_method: string, effect: Effect.Effect<A, E, R>) => effect,
      observeRpcStreamEffect: <A, SE, SR, E, R>(
        _method: string,
        effect: Effect.Effect<Stream.Stream<A, SE, SR>, E, R>,
      ) => Stream.unwrap(effect),
      computeGateway: { activeWork: Ref.get(sessions) },
      analysis: { activeRunCount: Ref.get(files) },
    } as unknown as Parameters<typeof makeScientificRpcHandlers>[0]);
    const counts = yield* Queue.unbounded<number>();
    const fiber = yield* handlers[WS_METHODS.subscribeComputeActiveWork]().pipe(
      Stream.runForEach(({ count }) => Queue.offer(counts, count)),
      Effect.forkChild,
    );

    expect(yield* Queue.take(counts)).toBe(0);
    yield* TestClock.adjust("3 seconds");
    yield* Ref.set(sessions, 2);
    yield* TestClock.adjust("1 second");
    expect(yield* Queue.take(counts)).toBe(2);
    yield* Ref.set(files, 1);
    yield* TestClock.adjust("1 second");
    expect(yield* Queue.take(counts)).toBe(3);
    yield* Ref.set(sessions, 0);
    yield* Ref.set(files, 0);
    yield* TestClock.adjust("1 second");
    expect(yield* Queue.take(counts)).toBe(0);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Queue.size(counts)).toBe(0);
    yield* Fiber.interrupt(fiber);
  }),
);
