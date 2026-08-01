import { Deferred, Effect, Exit, Fiber, Option, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { forkProviderNotificationDrain } from "./ProviderNotificationDrain.ts";

describe("forkProviderNotificationDrain", () => {
  it("survives its start caller and terminates with the session scope", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sessionScope = yield* Scope.make("sequential");
        const release = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();

        const startCaller = yield* Effect.gen(function* () {
          return yield* Deferred.await(release).pipe(
            Effect.andThen(Deferred.succeed(delivered, undefined)),
            Effect.andThen(Effect.never),
            forkProviderNotificationDrain(sessionScope),
          );
        }).pipe(Effect.forkChild);
        const notificationFiber = yield* Fiber.join(startCaller);

        yield* Deferred.succeed(release, undefined);
        const deliveredAfterCaller = Option.isSome(
          yield* Deferred.await(delivered).pipe(Effect.timeoutOption("1 second")),
        );
        yield* Scope.close(sessionScope, Exit.void);
        const notificationExit = yield* Fiber.await(notificationFiber);

        return {
          deliveredAfterCaller,
          interruptedAtSessionClose: Exit.isFailure(notificationExit),
        };
      }),
    );

    expect(result).toEqual({
      deliveredAfterCaller: true,
      interruptedAtSessionClose: true,
    });
  });
});
