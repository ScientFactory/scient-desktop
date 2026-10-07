/**
 * The authorized, instrumented RPC wrappers that ws.ts builds for each
 * connection. Scient handler modules receive them so every Scient RPC keeps
 * the same scope check and metrics as the shared handlers. Handlers that
 * join a shared group are typed as a subset of that group's handlers, so
 * the group's `of` still checks every payload and result.
 *
 * @module ScientRpcObservers
 */
import type { EnvironmentAuthorizationError } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { RpcGroup } from "effect/unstable/rpc";

export interface ScientRpcObservers {
  readonly observeRpcEffect: <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  readonly observeRpcStream: <A, E, R>(
    method: string,
    stream: Stream.Stream<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Stream.Stream<A, E | EnvironmentAuthorizationError, R>;
  readonly observeRpcStreamEffect: <A, StreamError, StreamContext, EffectError, EffectContext>(
    method: string,
    effect: Effect.Effect<Stream.Stream<A, StreamError, StreamContext>, EffectError, EffectContext>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Stream.Stream<
    A,
    StreamError | EffectError | EnvironmentAuthorizationError,
    StreamContext | EffectContext
  >;
}

/** The handlers for `Tags` within `Group`, as that group's `of` expects them. */
export type ScientRpcHandlerSubset<
  Group,
  Tags extends keyof RpcGroup.HandlersFrom<RpcGroup.Rpcs<Group>>,
> = Pick<RpcGroup.HandlersFrom<RpcGroup.Rpcs<Group>>, Tags>;
