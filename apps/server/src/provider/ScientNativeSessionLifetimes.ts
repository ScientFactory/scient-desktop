/**
 * Scient's native session lifetimes for the provider instance registry: every
 * opened native session is a child of both its configured instance and its
 * caller, and a retired instance never reaches its old native transport.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

import {
  ProviderAdapterOpenSessionError,
  ProviderAdapterProtocolError,
  type ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";

/** A retired instance must never reach its old native transport again. */
const guardSessionLifetime = (
  runtime: ProviderAdapterV2SessionRuntime,
  scope: Scope.Scope,
): ProviderAdapterV2SessionRuntime => {
  const guard = <A, E>(
    operation: () => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | ProviderAdapterProtocolError> =>
    Effect.suspend((): Effect.Effect<A, E | ProviderAdapterProtocolError> =>
      scope.state._tag === "Closed"
        ? Effect.fail(
            new ProviderAdapterProtocolError({
              driver: runtime.driver,
              detail: "The provider instance or session lifetime has ended.",
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
  } = runtime;
  return {
    ...runtime,
    get providerSession() {
      return runtime.providerSession;
    },
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
            scope.state._tag === "Closed" ? Effect.succeed(false) : hasPendingBackgroundWork,
          ),
        }
      : {}),
    ...(hasPendingBackgroundWorkForThread
      ? {
          hasPendingBackgroundWorkForThread: (input) =>
            Effect.suspend(() =>
              scope.state._tag === "Closed"
                ? Effect.succeed(false)
                : hasPendingBackgroundWorkForThread(input),
            ),
        }
      : {}),
  };
};

/** Native sessions are children of both their configured instance and caller. */
export const ownNativeSessionLifetimes = (
  instance: ProviderInstance,
  instanceScope: Scope.Scope,
): ProviderInstance => {
  const adapter = instance.orchestrationAdapter;
  return {
    ...instance,
    orchestrationAdapter: {
      ...adapter,
      openSession: (input) =>
        Effect.gen(function* () {
          const callerScope = yield* Scope.Scope;
          const retired = () =>
            new ProviderAdapterOpenSessionError({
              driver: instance.driverKind,
              providerSessionId: input.providerSessionId,
              cause: "The configured provider instance has been retired.",
            });
          if (instanceScope.state._tag === "Closed" || callerScope.state._tag === "Closed")
            return yield* retired();
          const sessionScope = yield* Scope.fork(instanceScope);
          yield* Scope.addFinalizerExit(callerScope, (exit) => Scope.close(sessionScope, exit));
          if (yield* Effect.sync(() => sessionScope.state._tag === "Closed"))
            return yield* retired();
          const opening = yield* adapter
            .openSession(input)
            .pipe(
              Effect.provideService(Scope.Scope, sessionScope),
              Effect.interruptible,
              Effect.forkIn(sessionScope),
            );
          const runtime = yield* Fiber.join(opening).pipe(
            // Instance retirement is an opening failure, so the manager's
            // failure path also revokes newly issued MCP credentials.
            Effect.catchCause((cause) =>
              instanceScope.state._tag === "Closed"
                ? Effect.fail(retired())
                : Effect.failCause(cause),
            ),
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Scope.close(sessionScope, exit) : Effect.void,
            ),
          );
          if (yield* Effect.sync(() => sessionScope.state._tag === "Closed"))
            return yield* retired();
          return guardSessionLifetime(runtime, sessionScope);
        }),
    },
  };
};
