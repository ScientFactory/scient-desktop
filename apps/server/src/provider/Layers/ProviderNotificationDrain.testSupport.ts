import { Deferred, Effect, Exit, Fiber, Option, Scope } from "effect";

export type ProviderNotificationDrainFork = typeof Effect.forkIn;

const startNotificationDrain = (
  forkDrain: ProviderNotificationDrainFork,
  drain: Effect.Effect<void, never>,
  sessionScope: Scope.Closeable,
) =>
  Effect.gen(function* () {
    return yield* drain.pipe(forkDrain(sessionScope));
  }).pipe(Effect.forkChild, Effect.flatMap(Fiber.join));

const makeObservedDrain = (
  release: Deferred.Deferred<void>,
  delivered: Deferred.Deferred<void>,
  interrupted: Deferred.Deferred<void>,
) =>
  Deferred.await(release).pipe(
    Effect.andThen(Deferred.succeed(delivered, undefined)),
    Effect.andThen(Effect.never),
    Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)),
  );

export async function observeNotificationDrainLifetime(
  forkDrain: ProviderNotificationDrainFork,
): Promise<{
  readonly deliveredAfterCallerCompleted: boolean;
  readonly interruptedBeforeSessionTeardown: boolean;
  readonly interruptedAfterSessionTeardown: boolean;
}> {
  const sessionScope = await Effect.runPromise(Scope.make("sequential"));
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();

        yield* startNotificationDrain(
          forkDrain,
          makeObservedDrain(release, delivered, interrupted),
          sessionScope,
        );

        const interruptedBeforeSessionTeardown = yield* Deferred.isDone(interrupted);
        yield* Deferred.succeed(release, undefined);
        const deliveredAfterCallerCompleted = Option.isSome(
          yield* Deferred.await(delivered).pipe(Effect.timeoutOption("250 millis")),
        );

        yield* Scope.close(sessionScope, Exit.void);
        const interruptedAfterSessionTeardown = yield* Deferred.isDone(interrupted);

        return {
          deliveredAfterCallerCompleted,
          interruptedBeforeSessionTeardown,
          interruptedAfterSessionTeardown,
        };
      }),
    );
  } finally {
    await Effect.runPromise(Scope.close(sessionScope, Exit.void));
  }
}

export async function observeNotificationDrainReplacement(
  forkDrain: ProviderNotificationDrainFork,
): Promise<{
  readonly stoppedDrainDelivered: boolean;
  readonly stoppedDrainInterrupted: boolean;
  readonly replacementDrainDelivered: boolean;
  readonly replacementDrainInterruptedAfterTeardown: boolean;
}> {
  const stoppedScope = await Effect.runPromise(Scope.make("sequential"));
  const replacementScope = await Effect.runPromise(Scope.make("sequential"));
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const stoppedRelease = yield* Deferred.make<void>();
        const stoppedDelivered = yield* Deferred.make<void>();
        const stoppedInterrupted = yield* Deferred.make<void>();
        const replacementRelease = yield* Deferred.make<void>();
        const replacementDelivered = yield* Deferred.make<void>();
        const replacementInterrupted = yield* Deferred.make<void>();

        yield* startNotificationDrain(
          forkDrain,
          makeObservedDrain(stoppedRelease, stoppedDelivered, stoppedInterrupted),
          stoppedScope,
        );
        yield* startNotificationDrain(
          forkDrain,
          makeObservedDrain(replacementRelease, replacementDelivered, replacementInterrupted),
          replacementScope,
        );

        yield* Scope.close(stoppedScope, Exit.void);
        yield* Deferred.succeed(stoppedRelease, undefined);
        yield* Deferred.succeed(replacementRelease, undefined);
        const replacementDrainDelivered = Option.isSome(
          yield* Deferred.await(replacementDelivered).pipe(Effect.timeoutOption("250 millis")),
        );
        yield* Effect.sleep("10 millis");

        const stoppedDrainDelivered = yield* Deferred.isDone(stoppedDelivered);
        const stoppedDrainInterrupted = yield* Deferred.isDone(stoppedInterrupted);
        yield* Scope.close(replacementScope, Exit.void);
        const replacementDrainInterruptedAfterTeardown =
          yield* Deferred.isDone(replacementInterrupted);

        return {
          stoppedDrainDelivered,
          stoppedDrainInterrupted,
          replacementDrainDelivered,
          replacementDrainInterruptedAfterTeardown,
        };
      }),
    );
  } finally {
    await Effect.runPromise(
      Effect.all([Scope.close(stoppedScope, Exit.void), Scope.close(replacementScope, Exit.void)], {
        discard: true,
      }),
    );
  }
}

export async function observeNotificationDrainAbandonedStart(
  forkDrain: ProviderNotificationDrainFork,
): Promise<{
  readonly deliveredAfterStartupFailure: boolean;
  readonly interruptedByStartupCleanup: boolean;
}> {
  const sessionScope = await Effect.runPromise(Scope.make("sequential"));
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();

        const notificationFiber = yield* startNotificationDrain(
          forkDrain,
          makeObservedDrain(release, delivered, interrupted),
          sessionScope,
        );

        // startSession uses this same scope close when startup fails before its
        // session ownership transfer completes.
        yield* Scope.close(sessionScope, Exit.void);
        const notificationExit = yield* Fiber.await(notificationFiber);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.sleep("10 millis");

        return {
          deliveredAfterStartupFailure: yield* Deferred.isDone(delivered),
          interruptedByStartupCleanup: Exit.isFailure(notificationExit),
        };
      }),
    );
  } finally {
    await Effect.runPromise(Scope.close(sessionScope, Exit.void));
  }
}
