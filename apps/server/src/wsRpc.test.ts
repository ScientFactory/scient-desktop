import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { bufferLiveWhileInitialStreamLoads, tryWsRpcPromise } from "./wsRpc.ts";

describe("wsRpc promise error mapping", () => {
  it("preserves an actionable error from a rejected project-source operation", async () => {
    const error = await Effect.runPromise(
      tryWsRpcPromise(
        () => Promise.reject(new Error("The clone destination already exists.")),
        "Failed to clone repository",
      ).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      _tag: "WsRpcError",
      message: "The clone destination already exists.",
    });
    expect(error.message).not.toContain("Effect.tryPromise");
  });

  it("uses the operation fallback for a non-Error rejection", async () => {
    const error = await Effect.runPromise(
      tryWsRpcPromise(
        () => Promise.reject("opaque rejection"),
        "Failed to inspect repository sources",
      ).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      _tag: "WsRpcError",
      message: "Failed to inspect repository sources",
    });
  });
});

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
