/**
 * ProviderRegistryLive — aggregates per-instance snapshot streams into a
 * single materialized list.
 *
 * Historically this Layer composed four per-kind Live Layers
 * (`CodexProviderLive`, `ClaudeProviderLive`, …) that each exposed a
 * `ServerProviderShape`. Those Lives were deleted during the driver /
 * instance refactor — every driver now carries its `snapshot: ServerProviderShape`
 * bundled onto the `ProviderInstance` the registry produces.
 *
 * Each configured instance (including multi-instance setups like
 * `codex_personal` + `codex_work`) contributes one `ProviderSnapshotSource`,
 * keyed by `instanceId`. Instances whose driver is unavailable or whose
 * config failed to decode are merged from `instanceRegistry.listUnavailable`
 * as shadow snapshots so the UI can render their exact unavailable reason.
 *
 * Cache paths on disk are now keyed by `instanceId`. Because
 * `defaultInstanceIdForDriver(kind) === kind` for built-in kinds, existing
 * `<kind>.json` files remain the on-disk location for that driver's default
 * instance. Identity-less legacy cache contents are ignored and replaced by
 * the first live refresh.
 *
 * @module ProviderRegistryLive
 */
import {
  defaultInstanceIdForDriver,
  isProviderAvailable,
  type ProviderConnectionOperation,
  type ProviderRuntimeSummary,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  ProviderRegistry,
  ProviderRegistryRefreshError,
  type ProviderRegistryShape,
} from "../Services/ProviderRegistry.ts";
import {
  hydrateCachedProvider,
  isCachedProviderCorrelated,
  orderProviderSnapshots,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ProviderSnapshotSource } from "../builtInProviderCatalog.ts";

const loadProviders = (
  providerSources: ReadonlyArray<ProviderSnapshotSource>,
): Effect.Effect<ReadonlyArray<ServerProvider>> =>
  Effect.forEach(
    providerSources,
    (providerSource) =>
      providerSource.getSnapshot.pipe(
        Effect.flatMap((snapshot) => correlateSnapshotWithSource(providerSource, snapshot)),
      ),
    {
      concurrency: "unbounded",
    },
  );

const makeManualProviderMaintenanceCapabilities = (provider: ProviderDriverKind) =>
  makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });

const hasModelCapabilities = (model: ServerProvider["models"][number]): boolean =>
  (model.capabilities?.optionDescriptors?.length ?? 0) > 0;

const MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER = 16;

export function upsertProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string,
  scopedSnapshot: ServerProvider,
): ServerProvider {
  const workspaceSnapshot = {
    cwd,
    checkedAt: scopedSnapshot.checkedAt,
    slashCommands: scopedSnapshot.slashCommands,
    skills: scopedSnapshot.skills,
  } satisfies NonNullable<ServerProvider["workspaceSnapshots"]>[number];
  return {
    ...provider,
    workspaceSnapshots: [
      ...(provider.workspaceSnapshots ?? []).filter((snapshot) => snapshot.cwd !== cwd),
      workspaceSnapshot,
    ].slice(-MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER),
  };
}

const shouldRetainMissingProviderModels = (provider: ServerProvider): boolean => {
  // Claude's probe returns T3's curated versioned catalog together with the
  // current settings-defined custom models. Treat it as authoritative so SDK
  // aliases or models from an older catalog cannot survive a refresh.
  if (provider.driver === ProviderDriverKind.make("claudeAgent")) {
    return false;
  }

  // Droid's ACP catalog is likewise authoritative: models are discovered live
  // from the CLI, and a model Factory removes or revokes must not linger in
  // the picker. Same state-aware policy as OpenCode below — retain during
  // pending initial probes and failed installed-probe refreshes, replace on
  // successful discovery.
  if (provider.driver === ProviderDriverKind.make("droid")) {
    const isPendingInitialProbe =
      provider.enabled && !provider.installed && provider.status === "warning";
    const didInstalledProviderProbeFail = provider.installed && provider.status === "error";
    return isPendingInitialProbe || didInstalledProviderProbeFail;
  }

  if (provider.driver !== ProviderDriverKind.make("opencode")) {
    return true;
  }

  // OpenCode's initial snapshot is deliberately non-authoritative while its
  // first probe is still running. A probe error from an installed CLI/server
  // is likewise partial: it could not establish the current inventory.
  // Conversely, disabled and missing-CLI snapshots are authoritative removals,
  // as are successful ready/warning inventories (including an empty one after
  // logout or plugin removal).
  const isPendingInitialProbe =
    provider.enabled && !provider.installed && provider.status === "warning";
  const didInstalledProviderProbeFail = provider.installed && provider.status === "error";
  return isPendingInitialProbe || didInstalledProviderProbeFail;
};

const shouldRetainMissingOpenCodeMetadata = (provider: ServerProvider): boolean =>
  provider.driver === ProviderDriverKind.make("opencode") &&
  shouldRetainMissingProviderModels(provider);

const mergeProviderModels = (
  provider: ServerProvider,
  previousModels: ReadonlyArray<ServerProvider["models"][number]>,
  nextModels: ReadonlyArray<ServerProvider["models"][number]>,
): ReadonlyArray<ServerProvider["models"][number]> => {
  const shouldRetainMissingModels = shouldRetainMissingProviderModels(provider);
  // Custom rows are derived from settings and every snapshot carries the full
  // current list, so a custom model missing from `nextModels` was removed by
  // the user and must not be resurrected from the previous snapshot.
  const retainablePreviousModels = previousModels.filter((model) => !model.isCustom);

  if (shouldRetainMissingModels && nextModels.length === 0 && retainablePreviousModels.length > 0) {
    return retainablePreviousModels;
  }

  const previousBySlug = new Map(previousModels.map((model) => [model.slug, model] as const));
  const mergedModels = nextModels.map((model) => {
    const previousModel = previousBySlug.get(model.slug);
    if (provider.driver === ProviderDriverKind.make("droid")) {
      // Droid uses the contract's nullable capability shape as an authority
      // marker: null means the per-model ladder was not observed, while an
      // empty descriptor list means the model was observed and has no effort
      // selector. Only the unknown state may inherit a last-known value.
      if (previousModel && model.capabilities === null && previousModel.capabilities !== null) {
        return { ...model, capabilities: previousModel.capabilities };
      }
      return model;
    }
    if (!previousModel || hasModelCapabilities(model) || !hasModelCapabilities(previousModel)) {
      return model;
    }
    return {
      ...model,
      capabilities: previousModel.capabilities,
    };
  });
  const nextSlugs = new Set(nextModels.map((model) => model.slug));
  return shouldRetainMissingModels
    ? [...mergedModels, ...retainablePreviousModels.filter((model) => !nextSlugs.has(model.slug))]
    : mergedModels;
};

export const mergeProviderSnapshot = (
  previousProvider: ServerProvider | undefined,
  nextProvider: ServerProvider,
): ServerProvider =>
  !previousProvider
    ? nextProvider
    : {
        ...nextProvider,
        models: mergeProviderModels(nextProvider, previousProvider.models, nextProvider.models),
        ...(nextProvider.workspaceSnapshots !== undefined
          ? { workspaceSnapshots: nextProvider.workspaceSnapshots }
          : previousProvider.workspaceSnapshots !== undefined
            ? { workspaceSnapshots: previousProvider.workspaceSnapshots }
            : {}),
        ...(shouldRetainMissingOpenCodeMetadata(nextProvider)
          ? {
              slashCommands:
                nextProvider.slashCommands.length === 0
                  ? previousProvider.slashCommands
                  : nextProvider.slashCommands,
              skills:
                nextProvider.skills.length === 0 ? previousProvider.skills : nextProvider.skills,
            }
          : {}),
      };

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

const correlateSnapshotWithSource = (
  source: ProviderSnapshotSource,
  snapshot: ServerProvider,
): Effect.Effect<ServerProvider> => {
  if (snapshot.instanceId !== source.instanceId) {
    return Effect.die(
      new Error(
        `Provider snapshot instance mismatch: source '${source.instanceId}' emitted '${snapshot.instanceId}'.`,
      ),
    );
  }
  if (snapshot.driver !== source.driverKind) {
    return Effect.die(
      new Error(
        `Provider snapshot driver mismatch for instance '${source.instanceId}': source '${source.driverKind}' emitted '${snapshot.driver}'.`,
      ),
    );
  }
  return Effect.succeed(snapshot);
};

/**
 * Key a snapshot for aggregation and persistence. Snapshot sources
 * must be correlated by instance id before reaching this map; missing
 * identities are defects, not runtime routing fallbacks.
 */
const snapshotInstanceKey = (provider: ServerProvider): ProviderInstanceId => {
  return provider.instanceId;
};

// Project a live `ProviderInstance` into the aggregator's consumption
// shape. Each call re-captures the instance's `snapshot` closures, so
// after `ProviderInstanceRegistry` rebuilds an instance (e.g. because
// its settings changed), a fresh source rides the new PubSub instead
// of a closed one.
const buildSnapshotSource = (instance: ProviderInstance): ProviderSnapshotSource => ({
  instanceId: instance.instanceId,
  driverKind: instance.driverKind,
  getSnapshot: instance.snapshot.getSnapshot,
  refresh: instance.snapshot.refresh,
  streamChanges: instance.snapshot.streamChanges,
});

export const ProviderRegistryLive = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const instanceRegistry = yield* ProviderInstanceRegistry;
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layerScope = yield* Scope.Scope;

    // Aggregator PubSub — consumers (WS gateway, etc.) subscribe here for
    // coalesced updates across every instance.
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );

    // Boot-only: hydrate `providersRef` from the on-disk per-instance
    // cache so the UI has something to render during the first refresh.
    // Instances added post-boot skip this path; their first entry in
    // `providersRef` comes from the reactive `syncLiveSources` pass
    // below.
    const bootInstances = yield* instanceRegistry.listInstances;
    const bootSources = bootInstances.map(buildSnapshotSource);
    const fallbackProviders = yield* loadProviders(bootSources);
    const fallbackByInstance = new Map<ProviderInstanceId, ServerProvider>();
    for (let index = 0; index < fallbackProviders.length; index++) {
      const provider = fallbackProviders[index];
      const source = bootSources[index];
      if (provider === undefined || source === undefined) {
        continue;
      }
      fallbackByInstance.set(source.instanceId, provider);
    }

    const cachedProviders = yield* Effect.forEach(
      bootSources,
      (source) =>
        Effect.gen(function* () {
          // One cache file per configured instance. For the default
          // instance of a built-in kind the path equals `<kind>.json` —
          // identical to the legacy filename. We still require the cache
          // payload to carry matching instance id + driver kind; old
          // identity-less payloads are discarded and the awaited refresh
          // below repopulates the cache.
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: source.instanceId,
          }).pipe(Effect.provideService(Path.Path, path));
          const fallbackProvider = fallbackByInstance.get(source.instanceId);
          if (fallbackProvider === undefined) {
            return undefined;
          }
          return yield* readProviderStatusCache(filePath).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.flatMap((cachedProvider) => {
              if (cachedProvider === undefined) {
                return Effect.void.pipe(Effect.as(undefined as ServerProvider | undefined));
              }
              const correlation = {
                cachedProvider,
                fallbackProvider,
              } as const;
              if (!isCachedProviderCorrelated(correlation)) {
                return Effect.logWarning("provider status cache identity mismatch, ignoring", {
                  path: filePath,
                  instanceId: source.instanceId,
                  cachedInstanceId: cachedProvider.instanceId ?? null,
                  driver: source.driverKind,
                  cachedDriver: cachedProvider.driver ?? null,
                }).pipe(Effect.as(undefined as ServerProvider | undefined));
              }
              return Effect.succeed(hydrateCachedProvider(correlation));
            }),
          );
        }),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((providers) =>
        orderProviderSnapshots(
          providers.filter((provider): provider is ServerProvider => provider !== undefined),
        ),
      ),
    );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(cachedProviders);
    const workspaceRefreshesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstance, ReadonlySet<string>>
    >(new Map());
    const maintenanceActionStatesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, { readonly update?: ServerProviderUpdateState | undefined }>
    >(new Map());
    const connectionOperationStatesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, ProviderConnectionOperation>
    >(new Map());
    const authenticationFailuresRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, { readonly message: string }>
    >(new Map());
    const managedRuntimeStatesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, ProviderRuntimeSummary>
    >(new Map());

    // Live-source registry — the dynamic counterpart to the boot-time
    // `bootSources`. Keyed by `instanceId`; the stored `ProviderInstance`
    // reference is used for identity equality so "no-op" reconciles
    // (settings unchanged) skip re-subscribing + re-probing.
    const liveSubsRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ProviderInstance>>(
      new Map(),
    );
    // Serialize `syncLiveSources` so a rapid burst of reconciles doesn't
    // interleave two passes clobbering each other's fiber bookkeeping.
    const syncSemaphore = yield* Semaphore.make(1);

    const getLiveSources: Effect.Effect<ReadonlyArray<ProviderSnapshotSource>> = Ref.get(
      liveSubsRef,
    ).pipe(Effect.map((map) => Array.from(map.values(), buildSnapshotSource)));

    const persistProvider = (provider: ServerProvider) =>
      Effect.gen(function* () {
        // Persist every instance — the file name is the instance id, so
        // multi-instance setups (e.g. `codex_personal`, `codex_work`) each
        // get their own cache. We resolve the path fresh so snapshots
        // produced by newly-added instances post-boot still land on disk
        // without the aggregator holding a stale `cachePathByInstance`
        // entry.
        const key = snapshotInstanceKey(provider);
        const filePath = yield* resolveProviderStatusCachePath({
          cacheDir: config.providerStatusCacheDir,
          instanceId: key,
        }).pipe(Effect.provideService(Path.Path, path));
        const { workspaceSnapshots: _workspaceSnapshots, ...machineProvider } = provider;
        yield* writeProviderStatusCache({ filePath, provider: machineProvider }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.tapError(Effect.logError),
          Effect.ignore,
        );
      });

    const applyProviderTransientState = Effect.fn("applyProviderTransientState")(function* (
      provider: ServerProvider,
    ) {
      const maintenanceActionStates = yield* Ref.get(maintenanceActionStatesRef);
      const updateState = maintenanceActionStates.get(provider.instanceId)?.update;
      const connectionOperation = (yield* Ref.get(connectionOperationStatesRef)).get(
        provider.instanceId,
      );
      const authenticationFailure = (yield* Ref.get(authenticationFailuresRef)).get(
        provider.instanceId,
      );
      const managedRuntime = (yield* Ref.get(managedRuntimeStatesRef)).get(provider.instanceId);
      const providerWithUpdateState = updateState
        ? { ...provider, updateState }
        : (({ updateState: _updateState, ...rest }) => rest)(provider);
      if (!providerWithUpdateState.connection) {
        return providerWithUpdateState;
      }
      const providerWithConnection = {
        ...providerWithUpdateState,
        connection: {
          ...providerWithUpdateState.connection,
          operation: connectionOperation ?? null,
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
    });

    const upsertProviders = Effect.fn("upsertProviders")(function* (
      nextProviders: ReadonlyArray<ServerProvider>,
      options?: {
        readonly publish?: boolean;
        readonly persist?: boolean;
        readonly replace?: boolean;
      },
    ) {
      const nextProvidersWithTransientState = yield* Effect.forEach(
        nextProviders,
        applyProviderTransientState,
        {
          concurrency: "unbounded",
        },
      );
      const [previousProviders, providers, providersToPersist] = yield* Ref.modify(
        providersRef,
        (previousProviders) => {
          const mergedProviders = new Map(
            previousProviders.map((provider) => [snapshotInstanceKey(provider), provider] as const),
          );
          const updatedKeys = new Set<ProviderInstanceId>();

          for (const provider of nextProvidersWithTransientState) {
            const key = snapshotInstanceKey(provider);
            updatedKeys.add(key);
            mergedProviders.set(
              key,
              options?.replace === true
                ? provider
                : mergeProviderSnapshot(mergedProviders.get(key), provider),
            );
          }

          const providers = orderProviderSnapshots([...mergedProviders.values()]);
          const providersToPersist = providers.filter((provider) =>
            updatedKeys.has(snapshotInstanceKey(provider)),
          );
          return [[previousProviders, providers, providersToPersist] as const, providers];
        },
      );

      if (haveProvidersChanged(previousProviders, providers)) {
        // Publish the committed in-memory state before awaiting cache I/O.
        // Otherwise an older upsert can finish persisting after a newer one
        // and publish its captured snapshot last, leaving live clients on
        // stale transient state until they reconnect.
        if (options?.publish !== false) {
          yield* PubSub.publish(changesPubSub, providers);
        }
        if (options?.persist !== false) {
          yield* Effect.forEach(providersToPersist, persistProvider, {
            concurrency: "unbounded",
            discard: true,
          });
        }
      }

      return providers;
    });

    const syncProvider = Effect.fn("syncProvider")(function* (
      provider: ServerProvider,
      options?: {
        readonly publish?: boolean;
      },
    ) {
      const hasAuthenticationFailure = (yield* Ref.get(authenticationFailuresRef)).has(
        provider.instanceId,
      );
      return yield* upsertProviders([provider], {
        ...options,
        // The failure overlay changes auth/status/message fields that cannot be
        // stripped generically from a serialized snapshot. Keep the last
        // canonical cache entry until a verified account transition clears it.
        persist: !hasAuthenticationFailure,
      });
    });

    const setProviderMaintenanceActionState = Effect.fn("setProviderMaintenanceActionState")(
      function* (input: {
        readonly instanceId: ProviderInstanceId;
        readonly action: "update";
        readonly state: ServerProviderUpdateState | null;
      }) {
        yield* Ref.update(maintenanceActionStatesRef, (previous) => {
          const previousActions = previous.get(input.instanceId);
          const nextActions = { ...previousActions };
          if (input.state === null || input.state.status === "idle") {
            delete nextActions[input.action];
          } else {
            nextActions[input.action] = input.state;
          }

          const next = new Map(previous);
          if (Object.keys(nextActions).length === 0) {
            next.delete(input.instanceId);
          } else {
            next.set(input.instanceId, nextActions);
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

    const readRefreshedSource = Effect.fn("readRefreshedSource")(function* (
      providerSource: ProviderSnapshotSource,
    ) {
      const nextProvider = yield* providerSource.refresh;
      return yield* correlateSnapshotWithSource(providerSource, nextProvider);
    });

    const refreshOneSource = Effect.fn("refreshOneSource")(function* (
      providerSource: ProviderSnapshotSource,
    ) {
      return yield* readRefreshedSource(providerSource).pipe(Effect.flatMap(syncProvider));
    });

    const refreshAll = Effect.fn("refreshAll")(function* () {
      const sources = yield* getLiveSources;
      return yield* Effect.forEach(sources, (source) => refreshOneSource(source), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.andThen(Ref.get(providersRef)));
    });

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderDriverKind) {
      if (provider === undefined) {
        return yield* refreshAll();
      }
      // Kind-scoped refreshes target the default instance for that driver.
      const defaultInstanceId = defaultInstanceIdForDriver(provider);
      const sources = yield* getLiveSources;
      const providerSource = sources.find(
        (candidate) => candidate.instanceId === defaultInstanceId,
      );
      if (!providerSource) {
        return yield* Ref.get(providersRef);
      }
      return yield* refreshOneSource(providerSource);
    });

    const refreshInstance = Effect.fn("refreshInstance")(function* (
      instanceId: ProviderInstanceId,
    ) {
      const sources = yield* getLiveSources;
      const providerSource = sources.find((candidate) => candidate.instanceId === instanceId);
      if (!providerSource) {
        return yield* Ref.get(providersRef);
      }
      return yield* refreshOneSource(providerSource);
    });

    const getProviderMaintenanceCapabilitiesForInstance = Effect.fn(
      "getProviderMaintenanceCapabilitiesForInstance",
    )(function* (instanceId: ProviderInstanceId, provider: ProviderDriverKind) {
      const instance = Array.from((yield* Ref.get(liveSubsRef)).values()).find(
        (candidate) => candidate.instanceId === instanceId,
      );
      return (
        instance?.snapshot.maintenanceCapabilities ??
        makeManualProviderMaintenanceCapabilities(provider)
      );
    });

    const getProviderConnectionActionsForInstance = Effect.fn(
      "getProviderConnectionActionsForInstance",
    )(function* (instanceId: ProviderInstanceId) {
      const instance = (yield* Ref.get(liveSubsRef)).get(instanceId);
      return instance?.connectionActions;
    });

    const getProviderManagedRuntimeActionsForInstance = Effect.fn(
      "getProviderManagedRuntimeActionsForInstance",
    )(function* (instanceId: ProviderInstanceId) {
      const instance = (yield* Ref.get(liveSubsRef)).get(instanceId);
      return instance?.managedRuntimeActions;
    });

    const getProviderSkillActionsForInstance = Effect.fn("getProviderSkillActionsForInstance")(
      function* (instanceId: ProviderInstanceId) {
        const instance = (yield* Ref.get(liveSubsRef)).get(instanceId);
        return instance?.skillActions;
      },
    );

    const getVoiceTranscriptCorrectionForInstance = Effect.fn(
      "getVoiceTranscriptCorrectionForInstance",
    )(function* (instanceId: ProviderInstanceId) {
      const instance = (yield* Ref.get(liveSubsRef)).get(instanceId);
      return instance?.voiceTranscriptCorrection;
    });

    const stopProviderSessions = Effect.fn("stopProviderSessions")(function* (
      provider: ProviderDriverKind,
    ) {
      const instances = yield* instanceRegistry.listInstances;
      yield* Effect.forEach(
        instances.filter((instance) => instance.driverKind === provider),
        (instance) => instance.adapter.stopAll(),
        { concurrency: "unbounded", discard: true },
      );
    });

    /**
     * Diff the aggregator's live-source set against the current
     * `ProviderInstanceRegistry` and:
     *   - subscribe to each newly-added or rebuilt instance's
     *     `streamChanges` (so periodic + enrichment refreshes land in
     *     `providersRef`);
     *   - read each newly-added/rebuilt instance's current snapshot after
     *     subscribing, closing the race with its independently-running
     *     background startup probe;
     *   - prune `providersRef` of instances that no longer exist.
     *
     * Provider refreshes are owned by each managed provider and never run
     * on this layer's construction path. Consumers see cached or pending
     * snapshots immediately, then receive live probe results through the
     * already-attached change stream.
     *
     * Per-instance subscription fibers are not tracked explicitly. When
     * a rebuilt instance's old child scope closes, its PubSub shuts
     * down and our `Stream.runForEach` fiber exits naturally.
     */
    const syncLiveSources = syncSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const instances = yield* instanceRegistry.listInstances;
        const unavailableProviders = yield* instanceRegistry.listUnavailable;
        const nextByInstance = new Map<ProviderInstanceId, ProviderInstance>(
          instances.map((instance) => [instance.instanceId, instance] as const),
        );
        const knownInstanceIds = new Set<ProviderInstanceId>(nextByInstance.keys());
        for (const provider of unavailableProviders) {
          knownInstanceIds.add(snapshotInstanceKey(provider));
        }
        const previousSubs = yield* Ref.get(liveSubsRef);

        // Carry over subscriptions for instances whose identity is
        // unchanged (reconcile treated them as no-op). Instances that
        // disappeared, or were rebuilt with a different reference,
        // fall through to the "newly-added" branch below.
        const carriedOver = new Map<ProviderInstanceId, ProviderInstance>();
        for (const [instanceId, previousInstance] of previousSubs) {
          const nextInstance = nextByInstance.get(instanceId);
          if (nextInstance !== undefined && nextInstance === previousInstance) {
            carriedOver.set(instanceId, previousInstance);
          }
        }

        // Collect new/rebuilt instances in `nextByInstance` insertion
        // order (which preserves settings-author order).
        const newlyAdded: Array<readonly [ProviderInstanceId, ProviderInstance]> = [];
        for (const [instanceId, instance] of nextByInstance) {
          if (carriedOver.has(instanceId)) {
            continue;
          }
          newlyAdded.push([instanceId, instance] as const);
        }

        const rebuiltInstanceIds = new Set(
          newlyAdded
            .map(([instanceId]) => instanceId)
            .filter((instanceId) => previousSubs.has(instanceId)),
        );
        if (rebuiltInstanceIds.size > 0) {
          const [previousProviders, providers] = yield* Ref.modify(
            providersRef,
            (previousProviders) => {
              const providers = previousProviders.map((provider) => {
                if (!rebuiltInstanceIds.has(provider.instanceId)) return provider;
                const { workspaceSnapshots: _workspaceSnapshots, ...machineSnapshot } = provider;
                return machineSnapshot;
              });
              return [[previousProviders, providers] as const, providers];
            },
          );
          if (haveProvidersChanged(previousProviders, providers)) {
            yield* PubSub.publish(changesPubSub, providers);
          }
        }

        // Fork long-lived subscriptions to each new/rebuilt instance's
        // change stream before reading its current snapshot. If the
        // driver's own initial probe finishes during this sync, either
        // the current read or the active subscriber observes the result.
        for (const [, instance] of newlyAdded) {
          const source = buildSnapshotSource(instance);
          yield* Stream.runForEach(source.streamChanges, (provider) =>
            correlateSnapshotWithSource(source, provider).pipe(Effect.flatMap(syncProvider)),
          ).pipe(Effect.forkScoped);
        }
        yield* Effect.yieldNow;

        // Snapshot current state without starting a probe. Managed providers
        // launch their startup refresh independently, so this closes the
        // subscription race without putting external work on the registry
        // or HTTP server construction path.
        yield* Effect.forEach(
          newlyAdded,
          ([, instance]) =>
            Effect.gen(function* () {
              const source = buildSnapshotSource(instance);
              const provider = yield* source.getSnapshot;
              yield* correlateSnapshotWithSource(source, provider).pipe(
                Effect.flatMap(syncProvider),
              );
            }).pipe(Effect.ignoreCause({ log: true })),
          { concurrency: "unbounded", discard: true },
        );
        yield* upsertProviders(unavailableProviders, {
          persist: false,
          replace: true,
        });

        const nextSubs = new Map(carriedOver);
        for (const [instanceId, instance] of newlyAdded) {
          nextSubs.set(instanceId, instance);
        }
        yield* Ref.set(liveSubsRef, nextSubs);

        // Drop aggregator state for instances that have disappeared —
        // otherwise the UI would keep rendering ghosts.
        const [previousProviders, providers] = yield* Ref.modify(
          providersRef,
          (previousProviders) => {
            const providers = orderProviderSnapshots(
              previousProviders.filter((provider) =>
                knownInstanceIds.has(snapshotInstanceKey(provider)),
              ),
            );
            return [[previousProviders, providers] as const, providers];
          },
        );
        if (haveProvidersChanged(previousProviders, providers)) {
          yield* PubSub.publish(changesPubSub, providers);
        }
        yield* Ref.update(maintenanceActionStatesRef, (previous) => {
          const next = new Map(previous);
          for (const instanceId of previous.keys()) {
            if (!knownInstanceIds.has(instanceId)) {
              next.delete(instanceId);
            }
          }
          return next;
        });
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
      }),
    );
    const syncLiveSourcesAndContinue = syncLiveSources.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logError(
          "provider registry instance sync failed; keeping subscription alive",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );

    // Seed `providersRef` with the boot-time fallback snapshots so
    // consumers calling `getProviders` immediately after layer build see
    // a populated list — even before the first `syncLiveSources` refresh
    // resolves. Cached snapshots (already in `providersRef`) merge with
    // these via `upsertProviders` so on-disk state wins where present
    // and pending fallbacks fill the gaps.
    yield* upsertProviders(fallbackProviders, { publish: false });
    // Subscribe to registry mutations BEFORE running the initial sync.
    // `subscribeChanges` acquires the dequeue synchronously in this
    // fibre; the subscription is active the instant this `yield*`
    // returns. Forking the consumer loop later cannot lose a publish
    // because no publish can reach a not-yet-subscribed dequeue.
    //
    // (Contrast with the pre-fix code that did
    // `Stream.runForEach(instanceRegistry.streamChanges, …).pipe(Effect.forkScoped)`.
    // `Stream.fromPubSub` defers `PubSub.subscribe` to stream start,
    // and `forkScoped` only schedules the fibre — so a reconcile that
    // published between "fibre scheduled" and "fibre starts running"
    // was dropped, which made any settings change that replaced an
    // instance never propagate to the aggregator's `providersRef`.)
    // Subscribe to registry mutations BEFORE running the initial sync.
    // `subscribeChanges` acquires the `PubSub.Subscription` synchronously
    // in this fibre; the subscription is registered with the PubSub the
    // instant this `yield*` returns, so any subsequent publish is
    // buffered in the subscription regardless of when the consumer
    // fibre below actually starts running.
    //
    // (Contrast with the pre-fix code that did
    // `Stream.runForEach(instanceRegistry.streamChanges, …).pipe(Effect.forkScoped)`.
    // `instanceRegistry.streamChanges` is `Stream.fromPubSub(changes)`,
    // which defers `PubSub.subscribe` to stream start. `forkScoped` only
    // schedules the consumer fibre — so a reconcile that published
    // between "fibre scheduled" and "fibre starts running + subscribes"
    // was dropped, which made any settings change that replaced an
    // instance never propagate to the aggregator's `providersRef`.)
    const instanceChanges = yield* instanceRegistry.subscribeChanges;
    // Initial sync attaches subscriptions and snapshots current state for
    // every instance present at boot. Provider probes are already running in
    // their managed background fibers and never block this layer.
    yield* syncLiveSources;
    // React to registry mutations — instance added / removed / rebuilt.
    // `Stream.fromSubscription` builds a stream over the pre-acquired
    // subscription rather than subscribing on stream start, which is
    // what closes the race.
    yield* Stream.runForEach(
      Stream.fromSubscription(instanceChanges),
      () => syncLiveSourcesAndContinue,
    ).pipe(Effect.forkScoped);

    const reloadInstance = Effect.fn("ProviderRegistry.reloadInstance")(function* (
      instanceId: ProviderInstanceId,
    ) {
      yield* instanceRegistry.rebuildInstance(instanceId);
      // Do not race the registry-change subscriber: attach the replacement
      // source synchronously before asking it to probe the newly active path.
      yield* syncLiveSources.pipe(Effect.provideService(Scope.Scope, layerScope));
      return yield* refreshInstance(instanceId);
    });

    const recoverRefreshFailure = Effect.fn("recoverRefreshFailure")(function* (
      cause: Cause.Cause<unknown>,
    ) {
      if (Cause.hasInterruptsOnly(cause)) {
        return yield* Effect.interrupt;
      }
      yield* Effect.logError("provider registry refresh failed; preserving cached providers", {
        cause: Cause.pretty(cause),
      });
      return yield* Ref.get(providersRef);
    });

    const failStrictRefresh = (
      operation: ProviderRegistryRefreshError["operation"],
      instanceId: ProviderInstanceId,
    ) =>
      Effect.catchCause((cause: Cause.Cause<unknown>) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.fail(
              new ProviderRegistryRefreshError({
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
        return yield* new ProviderRegistryRefreshError({
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
        return yield* new ProviderRegistryRefreshError({
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
          return yield* new ProviderRegistryRefreshError({
            operation: "reload",
            instanceId,
            message: `Provider reload failed for ${instanceId}: no live source is available.`,
          });
        }
        return yield* refreshOneSource(providerSource);
      }).pipe(failStrictRefresh("reload", instanceId));
    });

    const refreshWorkspaceSnapshot = Effect.fn("refreshWorkspaceSnapshot")(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly cwd: string;
    }) {
      const providers = yield* Ref.get(providersRef);
      const provider = providers.find((candidate) => candidate.instanceId === input.instanceId);
      if (
        !provider ||
        !provider.enabled ||
        provider.workspaceSnapshots?.some((s) => s.cwd === input.cwd)
      ) {
        return providers;
      }
      const instance = yield* instanceRegistry.getInstance(input.instanceId);
      if (!instance?.snapshotForCwd) return providers;
      const claimed = yield* Ref.modify(workspaceRefreshesRef, (refreshes) => {
        const current = refreshes.get(instance);
        if (current?.has(input.cwd)) return [false, refreshes] as const;
        const next = new Map(refreshes);
        next.set(instance, new Set(current).add(input.cwd));
        return [true, next] as const;
      });
      if (!claimed) return yield* Ref.get(providersRef);
      return yield* instance.snapshotForCwd(input.cwd).pipe(
        Effect.flatMap((scopedSnapshot) =>
          scopedSnapshot.status === "error"
            ? Ref.get(providersRef)
            : instanceRegistry.getInstance(input.instanceId).pipe(
                Effect.flatMap((currentInstance) => {
                  if (currentInstance !== instance) return Ref.get(providersRef);
                  return Ref.modify(providersRef, (currentProviders) => {
                    const nextProviders = currentProviders.map((candidate) =>
                      candidate.instanceId === input.instanceId &&
                      !candidate.workspaceSnapshots?.some((s) => s.cwd === input.cwd)
                        ? upsertProviderWorkspaceSnapshot(candidate, input.cwd, scopedSnapshot)
                        : candidate,
                    );
                    return [[currentProviders, nextProviders] as const, nextProviders];
                  }).pipe(
                    Effect.tap(([previousProviders, nextProviders]) =>
                      haveProvidersChanged(previousProviders, nextProviders)
                        ? PubSub.publish(changesPubSub, nextProviders)
                        : Effect.void,
                    ),
                    Effect.map(([, nextProviders]) => nextProviders),
                  );
                }),
              ),
        ),
        Effect.ensuring(
          Ref.update(workspaceRefreshesRef, (refreshes) => {
            const next = new Map(refreshes);
            const current = new Set(next.get(instance));
            current.delete(input.cwd);
            if (current.size) next.set(instance, current);
            else next.delete(instance);
            return next;
          }),
        ),
      );
    });

    return {
      getProviders: Ref.get(providersRef),
      refresh: (provider?: ProviderDriverKind) =>
        refresh(provider).pipe(Effect.catchCause(recoverRefreshFailure)),
      refreshInstance: (instanceId: ProviderInstanceId) =>
        refreshInstance(instanceId).pipe(Effect.catchCause(recoverRefreshFailure)),
      refreshInstanceStrict,
      refreshInstanceAfterAccountChange,
      reloadInstance: (instanceId: ProviderInstanceId) =>
        reloadInstance(instanceId).pipe(Effect.catchCause(recoverRefreshFailure)),
      reloadInstanceStrict,
      refreshWorkspaceSnapshot: (input) =>
        refreshWorkspaceSnapshot(input).pipe(Effect.catchCause(recoverRefreshFailure)),
      getProviderMaintenanceCapabilitiesForInstance,
      getProviderConnectionActionsForInstance,
      getProviderManagedRuntimeActionsForInstance,
      getProviderSkillActionsForInstance,
      getVoiceTranscriptCorrectionForInstance,
      stopProviderSessions,
      setProviderMaintenanceActionState,
      setProviderConnectionOperation,
      setProviderAuthenticationFailure,
      setProviderManagedRuntimeSummary,
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  }),
);
