/**
 * Scient's transient provider state: the connection operation in progress, a
 * runtime-proven authentication failure and the managed runtime summary of
 * each instance. None of it is persisted; ProviderRegistry overlays it on
 * every snapshot it publishes.
 */
import {
  isProviderAvailable,
  type ProviderConnectionOperation,
  type ProviderInstanceId,
  type ProviderRuntimeSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

/** One instance's transient states, as read for an overlay. */
export interface ScientProviderTransientStates {
  readonly connectionOperation: ProviderConnectionOperation | undefined;
  readonly authenticationFailure: { readonly message: string } | undefined;
  readonly managedRuntime: ProviderRuntimeSummary | undefined;
}

export const makeScientProviderTransientState = Effect.fnUntraced(function* () {
  const connectionOperationStatesRef = yield* Ref.make<
    ReadonlyMap<ProviderInstanceId, ProviderConnectionOperation>
  >(new Map());
  const authenticationFailuresRef = yield* Ref.make<
    ReadonlyMap<ProviderInstanceId, { readonly message: string }>
  >(new Map());
  const managedRuntimeStatesRef = yield* Ref.make<
    ReadonlyMap<ProviderInstanceId, ProviderRuntimeSummary>
  >(new Map());

  /** Reads one instance's transient states. */
  const read = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const connectionOperation = (yield* Ref.get(connectionOperationStatesRef)).get(instanceId);
      const authenticationFailure = (yield* Ref.get(authenticationFailuresRef)).get(instanceId);
      const managedRuntime = (yield* Ref.get(managedRuntimeStatesRef)).get(instanceId);
      return { connectionOperation, authenticationFailure, managedRuntime };
    });

  /** Forgets the transient states of instances that no longer exist. */
  const prune = (knownInstanceIds: ReadonlySet<ProviderInstanceId>) =>
    Effect.gen(function* () {
      yield* Ref.update(connectionOperationStatesRef, (previous) => {
        const next = new Map(previous);
        for (const instanceId of previous.keys()) {
          if (!knownInstanceIds.has(instanceId)) next.delete(instanceId);
        }
        return next;
      });
      yield* Ref.update(authenticationFailuresRef, (previous) => {
        const next = new Map(previous);
        for (const instanceId of previous.keys()) {
          if (!knownInstanceIds.has(instanceId)) next.delete(instanceId);
        }
        return next;
      });
      yield* Ref.update(managedRuntimeStatesRef, (previous) => {
        const next = new Map(previous);
        for (const instanceId of previous.keys()) {
          if (!knownInstanceIds.has(instanceId)) next.delete(instanceId);
        }
        return next;
      });
    });

  /** The setters ProviderRegistry serves; each re-applies the overlay to its instance. */
  const makeSetters = (deps: {
    readonly providersRef: Ref.Ref<ReadonlyArray<ServerProvider>>;
    readonly instanceRegistry: ProviderInstanceRegistry.ProviderInstanceRegistryShape;
    readonly applyProviderTransientState: (
      provider: ServerProvider,
    ) => Effect.Effect<ServerProvider>;
    readonly upsertProviders: (
      providers: ReadonlyArray<ServerProvider>,
      options: { readonly persist: boolean },
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
  }) => {
    const { providersRef, instanceRegistry, applyProviderTransientState, upsertProviders } = deps;
    const setProviderConnectionOperation = Effect.fn("setProviderConnectionOperation")(
      function* (input: {
        readonly instanceId: ProviderInstanceId;
        readonly operation: ProviderConnectionOperation | null;
      }) {
        yield* Ref.update(connectionOperationStatesRef, (previous) => {
          const next = new Map(previous);
          if (input.operation === null) {
            next.delete(input.instanceId);
          } else {
            next.set(input.instanceId, input.operation);
          }
          return next;
        });

        const existingProviders = yield* Ref.get(providersRef);
        const matchingProvider = existingProviders.find(
          (candidate) => candidate.instanceId === input.instanceId,
        );
        if (!matchingProvider) {
          return existingProviders;
        }

        const nextProvider = yield* applyProviderTransientState(matchingProvider);
        return yield* upsertProviders([nextProvider], {
          persist: false,
        });
      },
    );

    const setProviderAuthenticationFailure = Effect.fn("setProviderAuthenticationFailure")(
      function* (input: { readonly instanceId: ProviderInstanceId; readonly message: string }) {
        const existingProviders = yield* Ref.get(providersRef);
        const matchingProvider = existingProviders.find(
          (candidate) => candidate.instanceId === input.instanceId,
        );
        if (!matchingProvider || (matchingProvider.connection?.methods.length ?? 0) === 0) {
          return existingProviders;
        }

        yield* Ref.update(authenticationFailuresRef, (previous) => {
          const next = new Map(previous);
          next.set(input.instanceId, { message: input.message });
          return next;
        });

        // A passive snapshot must not reuse initialization metadata captured
        // before this runtime-proven account failure. Invalidate this instance
        // without deleting credentials or changing another account's runtime.
        const instance = yield* instanceRegistry.getInstance(input.instanceId);
        yield* (instance?.invalidateCaches ?? Effect.void).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.authentication-cache-invalidation-failed", {
              instanceId: input.instanceId,
              cause,
            }),
          ),
        );

        const nextProvider = yield* applyProviderTransientState(matchingProvider);
        return yield* upsertProviders([nextProvider], { persist: false });
      },
    );

    const setProviderManagedRuntimeSummary = Effect.fn("setProviderManagedRuntimeSummary")(
      function* (input: {
        readonly instanceId: ProviderInstanceId;
        readonly runtime: ProviderRuntimeSummary | null;
        readonly preserveOperation?: boolean;
      }) {
        yield* Ref.update(managedRuntimeStatesRef, (previous) => {
          const next = new Map(previous);
          if (input.runtime === null) next.delete(input.instanceId);
          else {
            const current = previous.get(input.instanceId);
            next.set(
              input.instanceId,
              input.preserveOperation && current?.operation
                ? { ...input.runtime, operation: current.operation }
                : input.runtime,
            );
          }
          return next;
        });
        const existingProviders = yield* Ref.get(providersRef);
        const matchingProvider = existingProviders.find(
          (candidate) => candidate.instanceId === input.instanceId,
        );
        if (!matchingProvider) return existingProviders;
        const nextProvider = yield* applyProviderTransientState(matchingProvider);
        return yield* upsertProviders([nextProvider], { persist: false });
      },
    );

    return {
      setProviderConnectionOperation,
      setProviderAuthenticationFailure,
      setProviderManagedRuntimeSummary,
    };
  };

  return { authenticationFailuresRef, read, prune, makeSetters };
});

/** Overlays one instance's transient states on its snapshot. */
export function overlayScientProviderTransientState(
  providerWithUpdateState: ServerProvider,
  states: ScientProviderTransientStates,
): ServerProvider {
  const { connectionOperation, authenticationFailure, managedRuntime } = states;
  if (!providerWithUpdateState.connection) {
    return providerWithUpdateState;
  }
  // A sign-in to one of a provider's accounts has its own field, which an
  // older client ignores. See `ProviderConnectionSummary.accountOperation`.
  const { accountOperation: _accountOperation, ...connectionWithoutAccountOperation } =
    providerWithUpdateState.connection;
  const providerWithConnection = {
    ...providerWithUpdateState,
    connection:
      connectionOperation?.account === undefined
        ? { ...connectionWithoutAccountOperation, operation: connectionOperation ?? null }
        : {
            ...connectionWithoutAccountOperation,
            operation: null,
            accountOperation: connectionOperation,
          },
  };
  const providerWithRuntime: ServerProvider & {
    readonly connection: NonNullable<ServerProvider["connection"]>;
  } = !managedRuntime
    ? providerWithConnection
    : {
        ...providerWithConnection,
        connection: {
          ...providerWithConnection.connection,
          runtime: managedRuntime,
        },
      };
  const canPresentAuthenticationFailure =
    providerWithRuntime.connection.methods.length > 0 &&
    isProviderAvailable(providerWithRuntime) &&
    providerWithRuntime.enabled &&
    providerWithRuntime.installed &&
    providerWithRuntime.status !== "error";
  if (!authenticationFailure || !canPresentAuthenticationFailure) {
    return providerWithRuntime;
  }

  const providerWithAuthenticationFailure: ServerProvider = {
    ...providerWithRuntime,
    status: "warning",
    auth: {
      ...providerWithRuntime.auth,
      status: "unauthenticated",
    },
    connection: {
      ...providerWithRuntime.connection,
      canDisconnect: false,
    },
    message: authenticationFailure.message,
  };
  return providerWithAuthenticationFailure;
}
