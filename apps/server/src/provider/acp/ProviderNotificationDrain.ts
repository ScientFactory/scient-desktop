import { Effect, Fiber, Scope } from "effect";

/** Fork a provider notification consumer into the lifetime of its owning session. */
export const forkProviderNotificationDrain =
  (sessionScope: Scope.Scope) =>
  <A, E, R>(drain: Effect.Effect<A, E, R>): Effect.Effect<Fiber.Fiber<A, E>, never, R> =>
    Effect.forkIn(drain, sessionScope);
