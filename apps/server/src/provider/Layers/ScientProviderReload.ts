/**
 * Scient's provider reload and strict refreshes. A reload rebuilds one
 * instance from its unchanged config and probes the replacement source. The
 * strict variants fail with ProviderRegistryRefreshError instead of keeping
 * cached providers, and a refresh after an account change clears a proven
 * authentication failure only once fresh verification succeeds.
 */
import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import type { ProviderSnapshotSource } from "../builtInProviderCatalog.ts";
import type * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";

export function makeScientProviderReload(deps: {
  readonly instanceRegistry: ProviderInstanceRegistry.ProviderInstanceRegistryShape;
  readonly layerScope: Scope.Scope;
  readonly syncLiveSources: Effect.Effect<unknown, never, Scope.Scope>;
  readonly getLiveSources: Effect.Effect<ReadonlyArray<ProviderSnapshotSource>>;
  readonly refreshInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly refreshOneSource: (
    providerSource: ProviderSnapshotSource,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly readRefreshedSource: (
    providerSource: ProviderSnapshotSource,
  ) => Effect.Effect<ServerProvider>;
  readonly syncProvider: (provider: ServerProvider) => Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly authenticationFailuresRef: Ref.Ref<
    ReadonlyMap<ProviderInstanceId, { readonly message: string }>
  >;
}) {
  const {
    instanceRegistry,
    layerScope,
    syncLiveSources,
    getLiveSources,
    refreshInstance,
    refreshOneSource,
    readRefreshedSource,
    syncProvider,
    authenticationFailuresRef,
  } = deps;

  const reloadInstance = Effect.fn("ProviderRegistry.reloadInstance")(function* (
    instanceId: ProviderInstanceId,
  ) {
    yield* instanceRegistry.rebuildInstance(instanceId);
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
    const sources = yield* getLiveSources;
    const providerSource = sources.find((candidate) => candidate.instanceId === instanceId);
    if (!providerSource) {
      return yield* new ProviderRegistry.ProviderRegistryRefreshError({
        operation: "refresh",
        instanceId,
        message: `Provider refresh failed for ${instanceId}: no live source is available.`,
      });
    }
    return yield* refreshOneSource(providerSource).pipe(failStrictRefresh("refresh", instanceId));
  });

  const refreshInstanceAfterAccountChange = Effect.fn(
    "ProviderRegistry.refreshInstanceAfterAccountChange",
  )(function* (instanceId: ProviderInstanceId) {
    const previousFailure = (yield* Ref.get(authenticationFailuresRef)).get(instanceId);
    const sources = yield* getLiveSources;
    const providerSource = sources.find((candidate) => candidate.instanceId === instanceId);
    if (!providerSource) {
      return yield* new ProviderRegistry.ProviderRegistryRefreshError({
        operation: "refresh",
        instanceId,
        message: `Provider refresh failed for ${instanceId}: no live source is available.`,
      });
    }

    // Keep the proven failure visible while the provider performs fresh
    // account verification. Clearing it first creates a false-ready window
    // and requires incomplete rollback on failure or interruption.
    const canonicalProvider = yield* readRefreshedSource(providerSource).pipe(
      failStrictRefresh("refresh", instanceId),
    );
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

  const reloadInstanceStrict = Effect.fn("ProviderRegistry.reloadInstanceStrict")(function* (
    instanceId: ProviderInstanceId,
  ) {
    return yield* Effect.gen(function* () {
      yield* instanceRegistry.rebuildInstance(instanceId);
      yield* syncLiveSources.pipe(Effect.provideService(Scope.Scope, layerScope));
      const sources = yield* getLiveSources;
      const providerSource = sources.find((candidate) => candidate.instanceId === instanceId);
      if (!providerSource) {
        return yield* new ProviderRegistry.ProviderRegistryRefreshError({
          operation: "reload",
          instanceId,
          message: `Provider reload failed for ${instanceId}: no live source is available.`,
        });
      }
      return yield* refreshOneSource(providerSource);
    }).pipe(failStrictRefresh("reload", instanceId));
  });

  return {
    reloadInstance,
    refreshInstanceStrict,
    refreshInstanceAfterAccountChange,
    reloadInstanceStrict,
  };
}
