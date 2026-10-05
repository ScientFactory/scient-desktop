import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterCloseSessionError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterProtocolError,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
} from "../orchestration-v2/ProviderAdapter.ts";

const guardRuntime = (
  runtime: ProviderAdapterV2SessionRuntime,
  isRetired: () => boolean,
  closed: Deferred.Deferred<void>,
): ProviderAdapterV2SessionRuntime => {
  const guard = <A, E>(operation: () => Effect.Effect<A, E>) =>
    Effect.suspend((): Effect.Effect<A, E | ProviderAdapterProtocolError> =>
      isRetired()
        ? Effect.fail(
            new ProviderAdapterProtocolError({
              driver: runtime.driver,
              detail: "The native session lifetime has ended.",
            }),
          )
        : operation(),
    );
  const {
    injectHistory,
    compactThread,
    unloadThread,
    uploadFeedback,
    hasPendingBackgroundWork,
    hasPendingBackgroundWorkForThread,
    subscribeEvents,
  } = runtime;
  return {
    ...runtime,
    get providerSession() {
      return runtime.providerSession;
    },
    // Ending this stream lets the manager release its own entry and MCP binding.
    // It is not a successful provider terminal or an acknowledgement.
    events: runtime.events.pipe(Stream.interruptWhen(Deferred.await(closed))),
    ...(subscribeEvents
      ? {
          subscribeEvents: Effect.suspend(() =>
            isRetired()
              ? Effect.succeed({ events: Stream.empty, close: Effect.void })
              : subscribeEvents.pipe(
                  Effect.map((subscription) => ({
                    ...subscription,
                    events: subscription.events.pipe(Stream.interruptWhen(Deferred.await(closed))),
                  })),
                ),
          ),
        }
      : {}),
    ensureThread: (input) => guard(() => runtime.ensureThread(input)),
    resumeThread: (input) => guard(() => runtime.resumeThread(input)),
    startTurn: (input) => guard(() => runtime.startTurn(input)),
    steerTurn: (input) => guard(() => runtime.steerTurn(input)),
    interruptTurn: (input) => guard(() => runtime.interruptTurn(input)),
    respondToRuntimeRequest: (input) => guard(() => runtime.respondToRuntimeRequest(input)),
    readThreadSnapshot: (input) => guard(() => runtime.readThreadSnapshot(input)),
    rollbackThread: (input) => guard(() => runtime.rollbackThread(input)),
    forkThread: (input) => guard(() => runtime.forkThread(input)),
    ...(injectHistory ? { injectHistory: (input) => guard(() => injectHistory(input)) } : {}),
    ...(compactThread ? { compactThread: (input) => guard(() => compactThread(input)) } : {}),
    ...(unloadThread ? { unloadThread: (input) => guard(() => unloadThread(input)) } : {}),
    ...(uploadFeedback ? { uploadFeedback: (input) => guard(() => uploadFeedback(input)) } : {}),
    ...(hasPendingBackgroundWork
      ? {
          hasPendingBackgroundWork: Effect.suspend(() =>
            isRetired() ? Effect.succeed(false) : hasPendingBackgroundWork,
          ),
        }
      : {}),
    ...(hasPendingBackgroundWorkForThread
      ? {
          hasPendingBackgroundWorkForThread: (input) =>
            Effect.suspend(() =>
              isRetired() ? Effect.succeed(false) : hasPendingBackgroundWorkForThread(input),
            ),
        }
      : {}),
  };
};

/** Factory-local physical teardown; registry and manager retain logical ownership. */
export const makeNativeSessionShutdown = Effect.fn("makeNativeSessionShutdown")(function* (
  native: ProviderAdapterV2Shape,
) {
  const factoryScope = yield* Scope.Scope;
  const admission = yield* Semaphore.make(1);
  type Lifetime = {
    readonly close: Effect.Effect<void, ProviderAdapterCloseSessionError>;
    readonly callerLink: Scope.Closeable;
    retiring: boolean;
  };
  const lifetimes = new Set<Lifetime>();
  let closing = 0;
  // Scope finalizers run once. A cached failure keeps admission closed for
  // this factory lifetime; repeated closes must still report that failure.
  let failed = false;

  const closeOwnedSessions = Effect.gen(function* () {
    const owned = yield* admission.withPermits(1)(
      Effect.sync(() => {
        closing++;
        for (const lifetime of lifetimes) lifetime.retiring = true;
        return [...lifetimes];
      }),
    );
    yield* Effect.gen(function* () {
      // Collect every close result: one failed finalizer must not skip siblings.
      const results = yield* Effect.forEach(owned, (lifetime) =>
        lifetime.close.pipe(
          Effect.andThen(Scope.close(lifetime.callerLink, Exit.void)),
          Effect.exit,
        ),
      );
      for (const result of results) if (Exit.isFailure(result)) return yield* result;
    }).pipe(
      Effect.ensuring(
        admission.withPermits(1)(
          Effect.sync(() => {
            closing--;
          }),
        ),
      ),
    );
  }).pipe(Effect.uninterruptible);
  yield* Effect.addFinalizer(() => closeOwnedSessions.pipe(Effect.orDie));
  const closeSessions = Effect.gen(function* () {
    const isRetired = () => factoryScope.state._tag === "Closed";
    const retired = () =>
      new ProviderAdapterProtocolError({
        driver: native.driver,
        detail: "The configured native provider lifetime has ended.",
      });
    if (isRetired()) return yield* retired();
    yield* closeOwnedSessions;
    if (isRetired()) return yield* retired();
  });

  const adapter: ProviderAdapterV2Shape = {
    ...native,
    openSession: (input) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const callerScope = yield* Scope.Scope;
          const refused = () =>
            new ProviderAdapterOpenSessionError({
              driver: native.driver,
              providerSessionId: input.providerSessionId,
              cause: "Native session admission is closed or a previous teardown failed.",
            });
          // Registration and startup forking are short; native opening/join and all
          // finalizers run outside admission. The child fiber is interrupted by close.
          const reserved = yield* admission.withPermits(1)(
            Effect.gen(function* () {
              if (
                closing > 0 ||
                failed ||
                factoryScope.state._tag === "Closed" ||
                callerScope.state._tag === "Closed"
              )
                return yield* refused();
              const scope = yield* Scope.make();
              const callerLink = yield* Scope.fork(callerScope);
              const closed = yield* Deferred.make<void>();
              const lifetime: Lifetime = {
                callerLink,
                retiring: false,
                close: yield* Effect.cached(
                  Effect.gen(function* () {
                    lifetime.retiring = true;
                    const result = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);
                    if (Exit.isSuccess(result)) lifetimes.delete(lifetime);
                    else failed = true;
                    yield* Deferred.succeed(closed, undefined);
                    if (Exit.isFailure(result))
                      return yield* new ProviderAdapterCloseSessionError({
                        driver: native.driver,
                        providerSessionId: input.providerSessionId,
                        cause: result.cause,
                      });
                  }).pipe(Effect.uninterruptible),
                ),
              };
              lifetimes.add(lifetime);
              const opening = yield* native
                .openSession(input)
                .pipe(
                  Effect.provideService(Scope.Scope, scope),
                  Effect.interruptible,
                  Effect.forkIn(scope),
                );
              return { lifetime, closed, opening, scope };
            }),
          );
          const { lifetime, opening, scope, closed } = reserved;
          yield* Scope.addFinalizerExit(lifetime.callerLink, () =>
            lifetime.close.pipe(Effect.orDie),
          );
          const runtime = yield* restore(Fiber.join(opening)).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? lifetime.close.pipe(Effect.andThen(Scope.close(lifetime.callerLink, exit)))
                : Effect.void,
            ),
          );
          const isRetired = () =>
            lifetime.retiring ||
            scope.state._tag === "Closed" ||
            factoryScope.state._tag === "Closed" ||
            callerScope.state._tag === "Closed";
          if (isRetired()) return yield* refused();
          return guardRuntime(runtime, isRetired, closed);
        }),
      ),
  };
  return { adapter, closeSessions };
});
