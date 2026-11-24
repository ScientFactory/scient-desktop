/**
 * Strict refresh must fail instead of retaining cached providers. Clear proven authentication
 * failure only after fresh verification of the unchanged instance's replacement succeeds.
 */
import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import type * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

export function makeScientProviderReload(deps: {
  readonly instanceRegistry: ProviderInstanceRegistry.ProviderInstanceRegistryShape;
  readonly rebuild: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape["rebuild"];
  readonly layerScope: Scope.Scope;
  readonly syncLiveSources: Effect.Effect<unknown, never, Scope.Scope>;
  readonly getLiveInstances: Effect.Effect<ReadonlyMap<ProviderInstanceId, ProviderInstance>>;
  readonly refreshInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly refreshOneSource: (
    instance: ProviderInstance,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly readRefreshedSource: (instance: ProviderInstance) => Effect.Effect<ServerProvider>;
  readonly syncProvider: (provider: ServerProvider) => Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly authenticationFailuresRef: Ref.Ref<
    ReadonlyMap<ProviderInstanceId, { readonly message: string }>
  >;
}) {
  const {
    instanceRegistry,
    rebuild,
    layerScope,
    syncLiveSources,
    getLiveInstances,
    refreshInstance,
    refreshOneSource,
    readRefreshedSource,
    syncProvider,
    authenticationFailuresRef,
  } = deps;

  // T3's mutator reads the configured instances under the registry's own lock, so an instance
  // mid-replacement is still rebuilt; an id no longer configured gets an ordinary reconcile.
  const rebuildOne = (instanceId: ProviderInstanceId) => rebuild([instanceId]);

  const reloadInstance = Effect.fn("ProviderRegistry.reloadInstance")(function* (
    instanceId: ProviderInstanceId,
  ) {
    yield* rebuildOne(instanceId);
    // Do not race the registry-change subscriber: attach the replacement
    // source synchronously before asking it to probe the newly active path.
    yield* syncLiveSources.pipe(Effect.provideService(Scope.Scope, layerScope));
    return yield* refreshInstance(instanceId);
  });

  const failStrictRefresh = (
    operation: ProviderRegistry.ProviderRegistryRefreshError["operation"],
    instanceId: ProviderInstanceId,
  ) =>
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.fail(
            new ProviderRegistry.ProviderRegistryRefreshError({
              operation,
              instanceId,
              message: `Provider ${operation} failed for ${instanceId}.`,
              cause,
            }),
          ),
    );

  const refreshInstanceStrict = Effect.fn("ProviderRegistry.refreshInstanceStrict")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = (yield* getLiveInstances).get(instanceId);
    if (!instance) {
      return yield* new ProviderRegistry.ProviderRegistryRefreshError({
        operation: "refresh",
        instanceId,
        message: `Provider refresh failed for ${instanceId}: no live source is available.`,
      });
    }
    return yield* refreshOneSource(instance).pipe(failStrictRefresh("refresh", instanceId));
  });

  const refreshInstanceAfterAccountChange = Effect.fn(
    "ProviderRegistry.refreshInstanceAfterAccountChange",
  )(function* (instanceId: ProviderInstanceId) {
    const previousFailure = (yield* Ref.get(authenticationFailuresRef)).get(instanceId);
    const instance = (yield* getLiveInstances).get(instanceId);
    if (!instance) {
      return yield* new ProviderRegistry.ProviderRegistryRefreshError({
        operation: "refresh",
        instanceId,
        message: `Provider refresh failed for ${instanceId}: no live source is available.`,
      });
    }

    // Keep the proven failure visible while the provider performs fresh
    // account verification. Clearing it first creates a false-ready window
    // and requires incomplete rollback on failure or interruption.
    const canonicalProvider = yield* readRefreshedSource(instance).pipe(
      failStrictRefresh("refresh", instanceId),
    );
    // Settings can replace the instance mid-probe; its result does not verify the replacement.
    if ((yield* instanceRegistry.getInstance(instanceId)) !== instance) {
      return yield* refreshInstanceStrict(instanceId);
    }
    if (previousFailure) {
      yield* Ref.update(authenticationFailuresRef, (previous) => {
        if (previous.get(instanceId) !== previousFailure) {
          return previous;
        }
        const next = new Map(previous);
        next.delete(instanceId);
        return next;
      });
    }
    return yield* syncProvider(canonicalProvider);
  });

  const readFreshInstance = Effect.fn("ProviderRegistry.readFreshInstance")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = (yield* getLiveInstances).get(instanceId);
    if (!instance) {
      return yield* new ProviderRegistry.ProviderRegistryRefreshError({
        operation: "refresh",
        instanceId,
        message: `Provider refresh failed for ${instanceId}: no live source is available.`,
      });
    }
    // Canonical and unpublished: a proven authentication failure stays shown until verification.
    return yield* readRefreshedSource(instance).pipe(failStrictRefresh("refresh", instanceId));
  });

  const reloadInstanceStrict = Effect.fn("ProviderRegistry.reloadInstanceStrict")(function* (
    instanceId: ProviderInstanceId,
  ) {
    return yield* Effect.gen(function* () {
      yield* rebuildOne(instanceId);
      yield* syncLiveSources.pipe(Effect.provideService(Scope.Scope, layerScope));
      const instance = (yield* getLiveInstances).get(instanceId);
      if (!instance) {
        return yield* new ProviderRegistry.ProviderRegistryRefreshError({
          operation: "reload",
          instanceId,
          message: `Provider reload failed for ${instanceId}: no live source is available.`,
        });
      }
      return yield* refreshOneSource(instance);
    }).pipe(failStrictRefresh("reload", instanceId));
  });

  return {
    reloadInstance,
    refreshInstanceStrict,
    refreshInstanceAfterAccountChange,
    readFreshInstance,
    reloadInstanceStrict,
  };
}
