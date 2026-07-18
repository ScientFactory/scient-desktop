import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { bufferLiveWhileInitialStreamLoads } from "./wsRpc.ts";

describe("wsRpc subscription startup", () => {
  it("buffers live events until the initial snapshot is delivered", async () => {
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const releaseSnapshot = yield* Deferred.make<void>();
          const liveSubscribed = yield* Deferred.make<void>();
          const liveEventCaptured = yield* Deferred.make<void>();
          const liveQueue = yield* Queue.unbounded<string>();
          const initialStream = Stream.fromEffect(
            Deferred.await(releaseSnapshot).pipe(Effect.as("snapshot")),
          );
          const liveStream = Stream.unwrap(
            Deferred.succeed(liveSubscribed, undefined).pipe(
              Effect.as(Stream.fromQueue(liveQueue)),
            ),
          ).pipe(
            Stream.tap(() => Deferred.succeed(liveEventCaptured, undefined).pipe(Effect.asVoid)),
          );
          const collectionFiber = yield* bufferLiveWhileInitialStreamLoads(
            initialStream,
            liveStream,
          ).pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped);

          yield* Deferred.await(liveSubscribed);
          yield* Queue.offer(liveQueue, "event-during-snapshot");
          yield* Deferred.await(liveEventCaptured);
          yield* Deferred.succeed(releaseSnapshot, undefined);
          yield* Queue.offer(liveQueue, "event-after-snapshot");

          return yield* Fiber.join(collectionFiber);
        }),
      ),
    );

    expect(Array.from(items)).toEqual([
      "snapshot",
      "event-during-snapshot",
      "event-after-snapshot",
    ]);
  });
});
