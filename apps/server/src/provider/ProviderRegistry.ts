import {
  defaultInstanceIdForDriver,
  isProviderWorkspaceSnapshotCurrent,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { applyAutomaticModelDefaults } from "@t3tools/shared/model";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ModelManifest from "./ModelManifest.ts";
import { applyProviderCompatibility } from "./providerCompatibility.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import {
  hydrateCachedProvider,
  isCachedProviderCorrelated,
  orderProviderSnapshots,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "./providerStatusCache.ts";
import type {
  ProviderInstance,
  ProviderWorkspaceSnapshot,
} from "@t3tools/provider-core/server/driver";
import type { ScientProviderInstance } from "./ScientProviderInstance.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import type { ProviderSnapshotSource } from "./builtInProviderCatalog.ts";

// SCIENT-FORK:START — model merge, transient state, reload and instance actions.
import * as Random from "effect/Random";
import {
  mergeScientProviderModel,
  scientRetainMissingProviderModels,
} from "./ScientProviderModelMerge.ts";
import { makeScientProviderInstanceActions } from "./ScientProviderInstanceActions.ts";
import { makeScientProviderReload } from "./ScientProviderReload.ts";
import {
  makeScientProviderTransientState,
  overlayScientProviderTransientState,
} from "./ScientProviderTransientState.ts";
import {
  makeScientProviderNativeInventory,
  overlayProviderNativeInventory,
  withoutProviderNativeInventory,
} from "./ScientProviderNativeInventory.ts";
import { nextInventoryReadSequence } from "./ProviderNativeInventory.ts";
// SCIENT-FORK:END

import type { ProviderConnectionOperation, ProviderRuntimeSummary } from "@t3tools/contracts";

import * as Data from "effect/Data";

import type {
  ProviderConnectionActions,
  ProviderManagedRuntimeActions,
  // SCIENT-FORK:START — Scient Extensions: provider-native plugins and MCP servers.
  ProviderNativeInventory,
  ProviderPluginActions,
  // SCIENT-FORK:END
  ProviderSkillActions,
  ProviderVoiceTranscriptCorrection,
} from "./ScientProviderInstanceSeams.ts";

export type ProviderMaintenanceActionKind = "update";

export class ProviderRegistryRefreshError extends Data.TaggedError("ProviderRegistryRefreshError")<{
  readonly operation: "refresh" | "reload";
  readonly instanceId: ProviderInstanceId;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ProviderRegistryShape {
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;

  readonly refresh: (provider?: ProviderDriverKind) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /** Unknown instance ids return the cached list without error. */
  readonly refreshInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /** Only refreshed instances can verify an update; the published list still includes every row. */
  readonly refreshAfterUpdate: (
    provider: ProviderDriverKind,
    selectedInstanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  readonly refreshWorkspaceSnapshot: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly cwd: string;
    readonly fresh?: boolean;
    // SCIENT-FORK:START — explicit full-inventory reads await native listing publication.
    readonly awaitNativeInventory?: boolean;
    // SCIENT-FORK:END
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh one instance without substituting cached state when its live probe
   * fails. Lifecycle operations use this when fresh state decides whether an
   * operation may start or can truthfully be reported as complete.
   */
  readonly refreshInstanceStrict: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>, ProviderRegistryRefreshError>;

  /**
   * Refresh one instance after a provider-owned account action succeeds.
   * Unlike routine refreshes, this keeps any runtime-proven authentication
   * failure visible while the fresh account probe runs and clears only the
   * failure that preceded a successful verification. Newer failures win.
   */
  readonly refreshInstanceAfterAccountChange: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>, ProviderRegistryRefreshError>;

  /**
   * Recreate one provider instance from unchanged settings, attach its fresh
   * snapshot source, and run a probe before returning. Used when an external
   * dependency such as a managed provider executable changed atomically.
   */
  readonly reloadInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Rebuild and refresh one instance without recovering to cached state.
   * Managed-runtime reconciliation uses this after a durable runtime change.
   */
  readonly reloadInstanceStrict: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>, ProviderRegistryRefreshError>;

  /**
   * Resolve the maintenance capabilities owned by one live provider instance.
   * Falls back to manual-only capabilities when the instance is not live.
   * `fresh` re-derives ownership from the executable instead of the cache.
   */
  readonly getProviderMaintenanceCapabilitiesForInstance: (
    instanceId: ProviderInstanceId,
    provider: ProviderDriverKind,
    options?: { readonly fresh?: boolean },
  ) => Effect.Effect<ProviderMaintenanceCapabilities>;

  /** Resolve the optional provider-owned connection seam for one live instance. */
  readonly getProviderConnectionActionsForInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderConnectionActions | undefined>;

  /** Resolve the optional Scient-managed runtime seam for one live instance. */
  readonly getProviderManagedRuntimeActionsForInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderManagedRuntimeActions | undefined>;

  /** Resolve the optional provider-owned native skill management seam. */
  readonly getProviderSkillActionsForInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderSkillActions | undefined>;

  // SCIENT-FORK:START — Scient Extensions: provider-native plugins and MCP servers.
  /**
   * Resolve the provider-owned native plugin and MCP server seam of the
   * instance's current generation, as the instance registry knows it.
   */
  readonly getProviderPluginActionsForInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderPluginActions | undefined>;

  /**
   * Publish a provider-native listing an action just read fresh. Ignored
   * unless `reportedBy` is still the instance's current plugin seam, so a
   * retired generation never overwrites its successor's inventory. With
   * `inventory.cwd`, only that workspace snapshot's plugins change.
   */
  readonly recordProviderNativeInventory: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly reportedBy: ProviderPluginActions;
    readonly inventory: ProviderNativeInventory;
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;
  // SCIENT-FORK:END

  /** Resolve the optional transcript-correction capability for one live instance. */
  readonly getVoiceTranscriptCorrectionForInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderVoiceTranscriptCorrection | undefined>;

  /**
   * Apply volatile maintenance-action state to one configured instance.
   * This state is never persisted to disk. Today only update actions are
   * projected onto `ServerProvider.updateState`; install/auth actions can
   * extend this action map without adding driver-scoped APIs.
   */
  readonly setProviderMaintenanceActionState: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly action: ProviderMaintenanceActionKind;
    readonly state: ServerProviderUpdateState | null;
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Overlay one transient provider-owned connection operation onto the
   * canonical snapshot. Authentication truth continues to come from the
   * provider probe; this state is progress only and is never persisted.
   */
  readonly setProviderConnectionOperation: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly operation: ProviderConnectionOperation | null;
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Overlay an authentication failure proven by a live provider request.
   * The overlay is process-local and survives passive probes until a verified
   * account transition, instance removal, or server restart.
   */
  readonly setProviderAuthenticationFailure: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly message: string;
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /** Overlay the current derived app-private runtime summary without persisting operation state. */
  readonly setProviderManagedRuntimeSummary: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly runtime: ProviderRuntimeSummary | null;
    /** Catalog refreshes update durable availability without erasing a concurrent operation. */
    readonly preserveOperation?: boolean;
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
}

export class ProviderRegistry extends Context.Service<ProviderRegistry, ProviderRegistryShape>()(
  "t3/provider/ProviderRegistry",
) {}

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

function dropProviderWorkspaceSnapshot(provider: ServerProvider, cwd: string): ServerProvider {
  return provider.workspaceSnapshots?.some((snapshot) => snapshot.cwd === cwd)
    ? {
        ...provider,
        workspaceSnapshots: provider.workspaceSnapshots.filter((snapshot) => snapshot.cwd !== cwd),
      }
    : provider;
}

export function upsertProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string,
  scopedSnapshot: ProviderWorkspaceSnapshot,
): ServerProvider {
  const previousSnapshot = provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
  const optionDescriptors = scopedSnapshot.optionDescriptors ?? previousSnapshot?.optionDescriptors;
  // SCIENT-FORK:START — Scient Extensions: a failed plugin listing keeps the workspace's last inventory.
  const plugins = scopedSnapshot.plugins ?? previousSnapshot?.plugins;
  // SCIENT-FORK:END
  const workspaceSnapshot = {
    cwd,
    checkedAt: scopedSnapshot.checkedAt,
    slashCommands: scopedSnapshot.slashCommandsPending
      ? (previousSnapshot?.slashCommands ?? scopedSnapshot.slashCommands)
      : scopedSnapshot.slashCommands,
    ...(scopedSnapshot.slashCommandsPending ? { slashCommandsPending: true } : {}),
    skills: scopedSnapshot.skills,
    ...(optionDescriptors === undefined ? {} : { optionDescriptors }),
    // SCIENT-FORK:START — Scient Extensions: provider-native plugins listed for this workspace.
    ...(plugins !== undefined ? { plugins } : {}),
    // SCIENT-FORK:END
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
  if (provider.driver === ProviderDriverKind.make("pi")) {
    // Pi auth becomes known only after inventory discovery: empty means unauthenticated; failed/interactive discovery preserves unknown auth and cached models.
    return !(
      provider.installed &&
      (provider.status === "ready" || provider.status === "warning") &&
      provider.auth.status !== "unknown"
    );
  }
  // SCIENT-FORK:START — Claude, Droid, Pi and Scient Agent catalogs are authoritative.
  const scientRetain = scientRetainMissingProviderModels(provider);
  if (scientRetain !== undefined) return scientRetain;
  // SCIENT-FORK:END

  if (provider.driver === ProviderDriverKind.make("acpRegistry")) {
    // Only completed ACP discovery provides nativeSessions and inventory; placeholder probes cannot establish auth for agents without sign-in.
    return !(
      provider.installed &&
      provider.status === "ready" &&
      provider.nativeSessions !== undefined
    );
  }

  if (provider.driver === ProviderDriverKind.make("grok")) {
    // Grok reports ready only after it discovers a model list; the pending,
    // ACP-failed, empty-inventory, and logged-out probes are warning/error.
    return !(provider.installed && provider.status === "ready");
  }

  const isAntigravity = provider.driver === ProviderDriverKind.make("antigravity");
  const isCodex = provider.driver === ProviderDriverKind.make("codex");
  if (!isAntigravity && !isCodex && provider.driver !== ProviderDriverKind.make("opencode")) {
    return true;
  }

  if (
    (isAntigravity || isCodex) &&
    (!provider.enabled || provider.auth.status === "unauthenticated")
  ) {
    return false;
  }

  // Antigravity's local health check does not authenticate or discover models.
  const isPendingAntigravityAuthentication =
    isAntigravity && provider.status === "warning" && provider.auth.status === "unknown";
  const isPendingInitialProbe =
    provider.enabled && !provider.installed && provider.status === "warning";
  const isIncompleteInstalledProbe =
    provider.installed &&
    (provider.status === "error" || (isCodex && provider.status === "warning"));
  return isPendingAntigravityAuthentication || isPendingInitialProbe || isIncompleteInstalledProbe;
};

const shouldRetainMissingDynamicMetadata = (provider: ServerProvider): boolean =>
  (provider.driver === ProviderDriverKind.make("opencode") ||
    provider.driver === ProviderDriverKind.make("pi")) &&
  shouldRetainMissingProviderModels(provider);

const mergeProviderModels = (
  provider: ServerProvider,
  previousModels: ReadonlyArray<ServerProvider["models"][number]>,
  nextModels: ReadonlyArray<ServerProvider["models"][number]>,
): ReadonlyArray<ServerProvider["models"][number]> => {
  const shouldRetainMissingModels = shouldRetainMissingProviderModels(provider);
  const updateRequiredSlugs = new Set(provider.updateRequiredModels?.map((model) => model.slug));
  const retainablePreviousModels = previousModels.filter(
    (model) => !model.isCustom && !updateRequiredSlugs.has(model.slug),
  );

  if (shouldRetainMissingModels && nextModels.length === 0 && retainablePreviousModels.length > 0) {
    return retainablePreviousModels;
  }

  const previousBySlug = new Map(previousModels.map((model) => [model.slug, model] as const));
  const mergedModels = nextModels.map((model) => {
    // SCIENT-FORK:START — Pi, Scient Agent and Droid model authority.
    const scientModel = mergeScientProviderModel(provider, model, previousBySlug);
    if (scientModel !== undefined) return scientModel;
    // SCIENT-FORK:END
    const previousModel = previousBySlug.get(model.slug);
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

/** Antigravity health checks only initialize; preserve previously verified Google auth across restarts. */
const carrySavedAntigravityAccount = (
  previousProvider: ServerProvider,
  nextProvider: ServerProvider,
): Pick<ServerProvider, "auth" | "status"> | undefined => {
  const antigravity = ProviderDriverKind.make("antigravity");
  if (
    nextProvider.driver !== antigravity ||
    previousProvider.driver !== antigravity ||
    !nextProvider.enabled ||
    nextProvider.auth.status !== "unknown" ||
    previousProvider.auth.status !== "authenticated" ||
    (nextProvider.auth.type !== undefined &&
      nextProvider.auth.type !== previousProvider.auth.type) ||
    (!nextProvider.installed && nextProvider.status !== "warning")
  ) {
    return undefined;
  }
  const status =
    nextProvider.installed && nextProvider.status === "warning" ? "ready" : nextProvider.status;
  return { auth: previousProvider.auth, status };
};

export const mergeProviderSnapshot = (
  previousProvider: ServerProvider | undefined,
  nextProvider: ServerProvider,
): ServerProvider => {
  if (!previousProvider) {
    return nextProvider;
  }
  const savedAccount = carrySavedAntigravityAccount(previousProvider, nextProvider);
  const { message: _uncheckedMessage, ...nextWithoutMessage } = nextProvider;
  return {
    ...(savedAccount?.status === "ready" ? nextWithoutMessage : nextProvider),
    ...savedAccount,
    models: mergeProviderModels(nextProvider, previousProvider.models, nextProvider.models),
    // SCIENT-FORK:START — workspace inventory belongs to one live instance generation.
    ...(nextProvider.workspaceSnapshots !== undefined
      ? { workspaceSnapshots: nextProvider.workspaceSnapshots }
      : previousProvider.workspaceSnapshots !== undefined &&
          previousProvider.nativeInventoryGeneration === nextProvider.nativeInventoryGeneration
        ? { workspaceSnapshots: previousProvider.workspaceSnapshots }
        : {}),
    // SCIENT-FORK:END
    ...(shouldRetainMissingDynamicMetadata(nextProvider)
      ? {
          slashCommands:
            nextProvider.slashCommands.length === 0
              ? previousProvider.slashCommands
              : nextProvider.slashCommands,
          skills: nextProvider.skills.length === 0 ? previousProvider.skills : nextProvider.skills,
        }
      : {}),
  };
};

const haveProvidersChanged = (
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

const snapshotInstanceKey = (provider: ServerProvider): ProviderInstanceId => {
  return provider.instanceId;
};

// Rebuilt instances have new PubSubs; capture their fresh closures instead of a closed source.
const buildSnapshotSource = (instance: ProviderInstance): ProviderSnapshotSource => ({
  instanceId: instance.instanceId,
  driverKind: instance.driverKind,
  getSnapshot: instance.snapshot.getSnapshot,
  refresh: instance.snapshot.refresh,
  streamChanges: instance.snapshot.streamChanges,
});

export const layer = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const manifestService = yield* ModelManifest.ModelManifest;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const serviceScope = yield* Effect.scope;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layerScope = yield* Scope.Scope;

    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );

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
    const initialManifest = yield* manifestService.current;
    const classifyCompatibility = (
      provider: ServerProvider,
      manifest: ModelManifest.ModelManifestData,
    ) =>
      applyProviderCompatibility(
        { ...provider, models: applyAutomaticModelDefaults(provider.driver, provider.models) },
        manifest.compatibility,
        ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
      );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      cachedProviders.map((provider) => classifyCompatibility(provider, initialManifest)),
    );
    const workspaceRefreshesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstance, ReadonlyMap<string, Deferred.Deferred<void>>>
    >(new Map());
    const maintenanceActionStatesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, { readonly update?: ServerProviderUpdateState | undefined }>
    >(new Map());
    // SCIENT-FORK:START — connection operations, account failures, managed runtimes
    // and provider-native inventory reported by live sessions.
    const scientTransientState = yield* makeScientProviderTransientState();
    const { authenticationFailuresRef } = scientTransientState;
    const nativeInventory = yield* makeScientProviderNativeInventory;
    const inventoryEpoch = yield* Random.nextInt;
    let nextInventoryGeneration = 0;
    const inventoryGenerations = new WeakMap<ProviderInstance, string>();
    const inventoryGeneration = (instance: ProviderInstance) => {
      let generation = inventoryGenerations.get(instance);
      if (generation === undefined) {
        generation = `${inventoryEpoch}:${++nextInventoryGeneration}`;
        inventoryGenerations.set(instance, generation);
      }
      return generation;
    };
    // SCIENT-FORK:END

    const liveSubsRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ScientProviderInstance>>(
      new Map(),
    );
    const syncSemaphore = yield* Semaphore.make(1);

    const getLiveSources: Effect.Effect<ReadonlyArray<ProviderSnapshotSource>> = Ref.get(
      liveSubsRef,
    ).pipe(Effect.map((map) => Array.from(map.values(), buildSnapshotSource)));

    const persistProvider = Effect.fn("ProviderRegistry.persistProvider")(function* (
      provider: ServerProvider,
    ) {
      const key = snapshotInstanceKey(provider);
      const filePath = yield* resolveProviderStatusCachePath({
        cacheDir: config.providerStatusCacheDir,
        instanceId: key,
      }).pipe(Effect.provideService(Path.Path, path));
      // SCIENT-FORK:START — Scient Extensions: provider-native inventory is live state, never cached.
      const {
        workspaceSnapshots: _workspaceSnapshots,
        nativeInventoryGeneration: _nativeInventoryGeneration,
        ...machineProvider
      } = provider;
      const cachedProvider = withoutProviderNativeInventory(machineProvider);
      yield* writeProviderStatusCache({ filePath, provider: cachedProvider }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.tapError(Effect.logError),
        Effect.ignore,
      );
      // SCIENT-FORK:END
    });

    const applyProviderTransientState = Effect.fn("applyProviderTransientState")(function* (
      provider: ServerProvider,
    ) {
      const maintenanceActionStates = yield* Ref.get(maintenanceActionStatesRef);
      const updateState = maintenanceActionStates.get(provider.instanceId)?.update;
      // SCIENT-FORK:START — overlay the connection, account-failure, runtime and
      // live-session inventory states.
      const scientStates = yield* scientTransientState.read(provider.instanceId);
      const instance = yield* instanceRegistry.getInstance(provider.instanceId);
      const generation = instance ? inventoryGeneration(instance) : undefined;
      const { nativeInventoryGeneration: priorGeneration, ...withoutGeneration } = provider;
      const { workspaceSnapshots: _snapshots, ...machineSnapshot } = withoutGeneration;
      const currentInventory =
        priorGeneration !== undefined && priorGeneration !== generation
          ? withoutProviderNativeInventory(machineSnapshot)
          : withoutGeneration;
      const currentProvider =
        generation === undefined
          ? currentInventory
          : { ...currentInventory, nativeInventoryGeneration: generation };
      const providerWithUpdateState = updateState
        ? { ...currentProvider, updateState }
        : (({ updateState: _updateState, ...rest }) => rest)(currentProvider);
      return overlayProviderNativeInventory(
        overlayScientProviderTransientState(providerWithUpdateState, scientStates),
        // Only the current generation's reports describe this configuration.
        yield* nativeInventory.read(provider.instanceId, instance),
      );
      // SCIENT-FORK:END
    });

    const upsertProviders = Effect.fn("upsertProviders")(function* (
      nextProviders: ReadonlyArray<ServerProvider>,
      options?: {
        readonly publish?: boolean;
        readonly persist?: boolean;
        readonly replace?: boolean;
      },
    ) {
      const manifest = yield* manifestService.current;
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

          const providers = orderProviderSnapshots(
            [...mergedProviders.values()].map((provider) =>
              classifyCompatibility(provider, manifest),
            ),
          );
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

    const compatibilityRefreshRunning = yield* Ref.make(false);
    const syncProvider = Effect.fn("syncProvider")(function* (
      provider: ServerProvider,
      options?: {
        readonly publish?: boolean;
      },
    ) {
      const hasAuthenticationFailure = (yield* Ref.get(authenticationFailuresRef)).has(
        provider.instanceId,
      );
      const providers = yield* upsertProviders([provider], {
        ...options,
        // The failure overlay changes auth/status/message fields that cannot be
        // stripped generically from a serialized snapshot. Keep the last
        // canonical cache entry until a verified account transition clears it.
        persist: !hasAuthenticationFailure,
      });
      // Reclassify the current model after fetch; republishing the old probe could overwrite newer health results.
      if (!(yield* Ref.getAndSet(compatibilityRefreshRunning, true))) {
        yield* manifestService.refresh.pipe(
          Effect.andThen(upsertProviders([], { persist: false })),
          Effect.ensuring(Ref.set(compatibilityRefreshRunning, false)),
          Effect.forkIn(serviceScope),
        );
      }
      return providers;
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

    // SCIENT-FORK:START — setters for the Scient transient states.
    const {
      setProviderConnectionOperation,
      setProviderAuthenticationFailure,
      setProviderManagedRuntimeSummary,
    } = scientTransientState.makeSetters({
      providersRef,
      instanceRegistry,
      applyProviderTransientState,
      upsertProviders,
    });

    /**
     * Applies a report from `instance`, unless a newer generation replaced it.
     * Machine reports are overlaid on every snapshot; a workspace report sets
     * the plugins of that workspace's published snapshot.
     */
    const applyNativeInventory = Effect.fn("applyNativeInventory")(function* (
      instance: ScientProviderInstance,
      inventory: ProviderNativeInventory,
    ) {
      if ((yield* instanceRegistry.getInstance(instance.instanceId)) !== instance) {
        return yield* Ref.get(providersRef);
      }
      const sequence = inventory.sequence ?? (yield* nextInventoryReadSequence);
      const accepted = yield* nativeInventory.accept(
        instance.instanceId,
        instance,
        inventory,
        sequence,
      );
      const { workspace } = accepted;
      if (workspace) {
        const [previousProviders, providers] = yield* Ref.modify(providersRef, (current) => {
          const next = current.map((candidate) =>
            candidate.instanceId === instance.instanceId &&
            candidate.workspaceSnapshots?.some((snapshot) => snapshot.cwd === workspace.cwd)
              ? {
                  ...candidate,
                  workspaceSnapshots: candidate.workspaceSnapshots.map((snapshot) =>
                    snapshot.cwd === workspace.cwd
                      ? { ...snapshot, plugins: workspace.plugins }
                      : snapshot,
                  ),
                }
              : candidate,
          );
          return [[current, next] as const, next];
        });
        if (haveProvidersChanged(previousProviders, providers)) {
          yield* PubSub.publish(changesPubSub, providers);
        }
        return providers;
      }
      const matchingProvider = (yield* Ref.get(providersRef)).find(
        (candidate) => candidate.instanceId === instance.instanceId,
      );
      if (!accepted.machine || !matchingProvider) return yield* Ref.get(providersRef);
      return yield* upsertProviders([yield* applyProviderTransientState(matchingProvider)], {
        persist: false,
      });
    });

    const recordProviderNativeInventory: ProviderRegistryShape["recordProviderNativeInventory"] =
      Effect.fn("recordProviderNativeInventory")(function* (input) {
        const instance = yield* instanceRegistry.getInstance(input.instanceId);
        if (!instance || instance.pluginActions !== input.reportedBy) {
          return yield* Ref.get(providersRef);
        }
        return yield* applyNativeInventory(instance, input.inventory);
      });
    // SCIENT-FORK:END

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

    type RefreshAllCompletion = Deferred.Deferred<ReadonlyArray<ServerProvider>>;
    const refreshAllInFlightRef = yield* Ref.make<Option.Option<RefreshAllCompletion>>(
      Option.none(),
    );

    const refreshAll = Effect.fn("refreshAll")(function* () {
      const claimed = yield* Ref.modify(
        refreshAllInFlightRef,
        (
          inFlight,
        ): readonly [
          { readonly owner: boolean; readonly completion: RefreshAllCompletion },
          Option.Option<RefreshAllCompletion>,
        ] => {
          if (Option.isSome(inFlight)) {
            return [{ owner: false, completion: inFlight.value }, inFlight];
          }
          const completion = Deferred.makeUnsafe<ReadonlyArray<ServerProvider>>();
          return [{ owner: true, completion }, Option.some(completion)];
        },
      );
      if (claimed.owner) {
        // Detach shared passes so the first caller's interruption cannot cancel other callers' work.
        yield* getLiveSources.pipe(
          Effect.flatMap((sources) =>
            Effect.forEach(sources, (source) => refreshOneSource(source), {
              concurrency: "unbounded",
              discard: true,
            }),
          ),
          Effect.andThen(Ref.get(providersRef)),
          Effect.onExit((exit) =>
            Ref.set(refreshAllInFlightRef, Option.none()).pipe(
              Effect.andThen(Deferred.done(claimed.completion, exit)),
            ),
          ),
          Effect.forkDetach,
        );
      }
      return yield* Deferred.await(claimed.completion);
    });

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderDriverKind) {
      if (provider === undefined) {
        return yield* refreshAll();
      }
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

    const refreshAfterUpdate = Effect.fn("refreshAfterUpdate")(function* (
      provider: ProviderDriverKind,
      selectedInstanceId: ProviderInstanceId,
    ) {
      yield* manifestService.forceRefresh;
      const instances = (yield* instanceRegistry.listInstances).filter(
        (instance) =>
          instance.driverKind === provider &&
          (instance.enabled || instance.instanceId === selectedInstanceId),
      );
      const failedInstances = new Set<ProviderInstanceId>();
      const recoverInstanceFailure = Effect.fn("recoverPostUpdateRefreshFailure")(function* (
        instanceId: ProviderInstanceId,
        cause: Cause.Cause<unknown>,
      ) {
        if (Cause.hasInterruptsOnly(cause)) {
          return yield* Effect.interrupt;
        }
        yield* Effect.logError("provider post-update refresh failed", {
          instanceId,
          cause: Cause.pretty(cause),
        });
        failedInstances.add(instanceId);
        // A cached ready snapshot cannot verify a successful update.
        return yield* updateProviders((providers) =>
          providers.map((candidate) =>
            candidate.instanceId === instanceId
              ? { ...candidate, status: "error", message: "Provider refresh failed after update." }
              : candidate,
          ),
        );
      });
      // Accounts can share an installation, but discovery must use each
      // instance's own executable, environment, and credentials.
      yield* Effect.forEach(
        instances,
        (instance) =>
          Effect.gen(function* () {
            yield* instance.invalidateCaches ?? Effect.void;
            const maintenance = yield* instance.snapshot.resolveMaintenance({ fresh: true });
            if (maintenance.packageName) {
              yield* latestVersions.invalidate(maintenance.packageName);
            }
          }).pipe(Effect.catchCause((cause) => recoverInstanceFailure(instance.instanceId, cause))),
        { concurrency: "unbounded", discard: true },
      );
      yield* Effect.forEach(
        instances.filter((instance) => !failedInstances.has(instance.instanceId)),
        (instance) =>
          refreshOneSource(buildSnapshotSource(instance)).pipe(
            Effect.catchCause((cause) => recoverInstanceFailure(instance.instanceId, cause)),
          ),
        { concurrency: "unbounded", discard: true },
      );
      const refreshedInstanceIds = new Set(
        instances
          .filter((instance) => !failedInstances.has(instance.instanceId))
          .map((instance) => instance.instanceId),
      );
      return (yield* Ref.get(providersRef)).filter((candidate) =>
        refreshedInstanceIds.has(candidate.instanceId),
      );
    });

    const getProviderMaintenanceCapabilitiesForInstance = Effect.fn(
      "getProviderMaintenanceCapabilitiesForInstance",
    )(function* (
      instanceId: ProviderInstanceId,
      provider: ProviderDriverKind,
      options?: { readonly fresh?: boolean },
    ) {
      // liveSubsRef trails reconciliation and could run a retired instance's command; read the registry.
      const instance = yield* instanceRegistry.getInstance(instanceId);
      if (!instance || instance.driverKind !== provider) {
        return makeManualProviderMaintenanceCapabilities(provider);
      }
      return yield* instance.snapshot.resolveMaintenance(options);
    });

    // SCIENT-FORK:START — per-instance action lookups.
    const {
      getProviderConnectionActionsForInstance,
      getProviderManagedRuntimeActionsForInstance,
      getProviderSkillActionsForInstance,
      getProviderPluginActionsForInstance,
      getVoiceTranscriptCorrectionForInstance,
    } = makeScientProviderInstanceActions(liveSubsRef, instanceRegistry);
    // SCIENT-FORK:END

    const syncLiveSources = syncSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const instances = yield* instanceRegistry.listInstances;
        const unavailableProviders = yield* instanceRegistry.listUnavailable;
        const nextByInstance = new Map<ProviderInstanceId, ScientProviderInstance>(
          instances.map((instance) => [instance.instanceId, instance] as const),
        );
        const knownInstanceIds = new Set<ProviderInstanceId>(nextByInstance.keys());
        for (const provider of unavailableProviders) {
          knownInstanceIds.add(snapshotInstanceKey(provider));
        }
        const previousSubs = yield* Ref.get(liveSubsRef);

        const carriedOver = new Map<ProviderInstanceId, ScientProviderInstance>();
        for (const [instanceId, previousInstance] of previousSubs) {
          const nextInstance = nextByInstance.get(instanceId);
          if (nextInstance !== undefined && nextInstance === previousInstance) {
            carriedOver.set(instanceId, previousInstance);
          }
        }
        // SCIENT-FORK:START — Scient Extensions: a generation that is not carried over is retired,
        // whether it was rebuilt, removed, or became unavailable: its reports go.
        yield* nativeInventory.forget(
          (instanceId) => !previousSubs.has(instanceId) || carriedOver.has(instanceId),
        );
        // SCIENT-FORK:END

        const newlyAdded: Array<readonly [ProviderInstanceId, ScientProviderInstance]> = [];
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
                // SCIENT-FORK:START — Scient Extensions: a rebuilt configuration reports its own inventory.
                const generation = inventoryGeneration(nextByInstance.get(provider.instanceId)!);
                if (provider.nativeInventoryGeneration === generation) return provider;
                const { workspaceSnapshots: _workspaceSnapshots, ...machineSnapshot } = provider;
                return {
                  ...withoutProviderNativeInventory(machineSnapshot),
                  nativeInventoryGeneration: generation,
                };
                // SCIENT-FORK:END
              });
              return [[previousProviders, providers] as const, providers];
            },
          );
          if (haveProvidersChanged(previousProviders, providers)) {
            yield* PubSub.publish(changesPubSub, providers);
          }
        }

        // Subscribe before reading so a probe completing mid-sync is observed by at least one path.
        for (const [, instance] of newlyAdded) {
          const source = buildSnapshotSource(instance);
          yield* Stream.runForEach(source.streamChanges, (provider) =>
            correlateSnapshotWithSource(source, provider).pipe(Effect.flatMap(syncProvider)),
          ).pipe(Effect.forkScoped);
          // SCIENT-FORK:START — Scient Extensions: publish inventory reported by the instance's live sessions.
          const nativeInventoryChanges = instance.nativeInventoryChanges;
          if (nativeInventoryChanges) {
            yield* Stream.runForEach(nativeInventoryChanges, (inventory) =>
              applyNativeInventory(instance, inventory),
            ).pipe(Effect.forkScoped);
          }
          // SCIENT-FORK:END
        }
        yield* Effect.yieldNow;

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
        // SCIENT-FORK:START — forget the transient states of removed instances.
        yield* scientTransientState.prune(knownInstanceIds);
        yield* nativeInventory.forget((instanceId) => knownInstanceIds.has(instanceId));
        // SCIENT-FORK:END
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

    yield* upsertProviders(fallbackProviders, { publish: false });
    const instanceChanges = yield* instanceRegistry.subscribeChanges;
    yield* syncLiveSources;
    yield* Stream.runForEach(
      Stream.fromSubscription(instanceChanges),
      () => syncLiveSourcesAndContinue,
    ).pipe(Effect.forkScoped);

    // SCIENT-FORK:START — reload and strict refreshes.
    const {
      reloadInstance,
      refreshInstanceStrict,
      refreshInstanceAfterAccountChange,
      reloadInstanceStrict,
    } = makeScientProviderReload({
      instanceRegistry,
      layerScope,
      syncLiveSources,
      getLiveSources,
      refreshInstance,
      refreshOneSource,
      readRefreshedSource,
      syncProvider,
      authenticationFailuresRef,
    });
    // SCIENT-FORK:END

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

    const updateProviders = (
      update: (providers: ReadonlyArray<ServerProvider>) => ReadonlyArray<ServerProvider>,
    ) =>
      Ref.modify(providersRef, (currentProviders) => {
        const nextProviders = update(currentProviders);
        return [[currentProviders, nextProviders] as const, nextProviders];
      }).pipe(
        Effect.tap(([previousProviders, nextProviders]) =>
          haveProvidersChanged(previousProviders, nextProviders)
            ? PubSub.publish(changesPubSub, nextProviders)
            : Effect.void,
        ),
        Effect.map(([, nextProviders]) => nextProviders),
      );
    // SCIENT-FORK:START — Scient Extensions: a workspace plugin listing stops once its snapshot is
    // evicted or dropped. Each instance compares its listings with the
    // snapshots published at that moment, so concurrent scans cannot miss one.
    const publishedWorkspaces = (instanceId: ProviderInstanceId) =>
      Ref.get(providersRef).pipe(
        Effect.map(
          (providers): ReadonlySet<string> =>
            new Set(
              providers
                .find((candidate) => candidate.instanceId === instanceId)
                ?.workspaceSnapshots?.map((snapshot) => snapshot.cwd),
            ),
        ),
      );
    const retainWorkspaceListings = Effect.fn("retainWorkspaceListings")(function* (
      instanceIds: Iterable<ProviderInstanceId>,
    ) {
      for (const instanceId of instanceIds) {
        const workspaceInventory = (yield* instanceRegistry.getInstance(instanceId))
          ?.workspaceInventory;
        if (workspaceInventory) yield* workspaceInventory.retain(publishedWorkspaces(instanceId));
      }
    });
    const awaitWorkspaceInventoryPublication = Effect.fn("awaitWorkspaceInventoryPublication")(
      function* (instance: ScientProviderInstance | undefined, cwd: string) {
        if (instance?.workspaceInventory) {
          const scan = (yield* Ref.get(workspaceRefreshesRef)).get(instance)?.get(cwd);
          if (scan) yield* Deferred.await(scan);
          yield* instance.workspaceInventory.awaitCurrent(cwd);
        }
        return yield* Ref.get(providersRef);
      },
    );
    // SCIENT-FORK:END

    const refreshWorkspaceSnapshot = Effect.fn("refreshWorkspaceSnapshot")(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly cwd: string;
      readonly fresh?: boolean;
      // SCIENT-FORK:START — explicit full-inventory reads await native listing publication.
      readonly awaitNativeInventory?: boolean;
      // SCIENT-FORK:END
    }) {
      if (input.fresh) {
        // SCIENT-FORK:START — Scient Extensions: the snapshots this drops stop their plugin listings.
        const afterDrop = yield* updateProviders((providers) =>
          providers.map((candidate) =>
            candidate.instanceId === input.instanceId
              ? candidate
              : dropProviderWorkspaceSnapshot(candidate, input.cwd),
          ),
        );
        yield* retainWorkspaceListings(
          afterDrop
            .map((candidate) => candidate.instanceId)
            .filter((instanceId) => instanceId !== input.instanceId),
        );
        // SCIENT-FORK:END
      }
      const providers = yield* Ref.get(providersRef);
      const provider = providers.find((candidate) => candidate.instanceId === input.instanceId);
      const workspaceSnapshotOf = (candidate: ServerProvider | undefined) =>
        candidate?.workspaceSnapshots?.find((s) => s.cwd === input.cwd);
      const scannedFrom = workspaceSnapshotOf(provider);
      const now = yield* DateTime.now;
      if (!provider || !provider.enabled) return providers;
      if (
        !input.fresh &&
        scannedFrom &&
        !scannedFrom.slashCommandsPending &&
        isProviderWorkspaceSnapshotCurrent(scannedFrom, DateTime.toEpochMillis(now))
      ) {
        // SCIENT-FORK:START — a cached scan can still have an unfinished native listing.
        if (input.awaitNativeInventory) {
          return yield* awaitWorkspaceInventoryPublication(
            yield* instanceRegistry.getInstance(input.instanceId),
            input.cwd,
          );
        }
        // SCIENT-FORK:END
        return providers;
      }
      // Use scan start for TTL, not checkedAt inherited from the machine health check.
      const scannedAt = DateTime.formatIso(now);
      const instance = yield* instanceRegistry.getInstance(input.instanceId);
      if (!instance?.snapshotForCwd) return providers;
      // SCIENT-FORK:START — Scient Extensions: kept narrowed for the claim-guarded scan below.
      const snapshotForCwd = instance.snapshotForCwd;
      // SCIENT-FORK:END
      const token = yield* Deferred.make<void>();
      const releaseClaim = Ref.update(workspaceRefreshesRef, (refreshes) => {
        const current = refreshes.get(instance);
        if (current?.get(input.cwd) !== token) return refreshes;
        const next = new Map(refreshes);
        const nextCwds = new Map(current);
        nextCwds.delete(input.cwd);
        if (nextCwds.size) next.set(instance, nextCwds);
        else next.delete(instance);
        return next;
      }).pipe(Effect.andThen(Deferred.succeed(token, undefined)));
      const runScan = Effect.gen(function* () {
        // SCIENT-FORK:START — workspace plugin listings share the admitted scan's lifetime.
        if (instance.workspaceInventory) {
          yield* instance.workspaceInventory.cancel(input.cwd);
        }
        const scanSequence = yield* nextInventoryReadSequence;
        // SCIENT-FORK:END
        const refreshMachineSnapshot = input.fresh
          ? (instance.invalidateCaches ?? Effect.void).pipe(
              Effect.andThen(refreshInstance(input.instanceId)),
            )
          : Effect.void;
        return yield* refreshMachineSnapshot.pipe(
          Effect.andThen(snapshotForCwd(input.cwd)),
          // Scans fail on error; returned inventory remains valid even when provider health reports an error.
          Effect.flatMap((scopedSnapshot) =>
            instanceRegistry.getInstance(input.instanceId).pipe(
              Effect.flatMap((currentInstance) => {
                if (currentInstance !== instance) return Ref.get(providersRef);
                return updateProviders((currentProviders) => {
                  // Read ownership inside the update so a newer claim cannot race publication.
                  if (
                    Ref.getUnsafe(workspaceRefreshesRef).get(instance)?.get(input.cwd) !== token
                  ) {
                    return currentProviders;
                  }
                  return currentProviders.map((candidate) =>
                    candidate.instanceId === input.instanceId &&
                    Equal.equals(workspaceSnapshotOf(candidate), scannedFrom)
                      ? upsertProviderWorkspaceSnapshot(candidate, input.cwd, {
                          ...scopedSnapshot,
                          checkedAt: scannedAt,
                          // Without driver command discovery, retain previous commands after failed health checks and retry.
                          slashCommandsPending:
                            scopedSnapshot.slashCommandsPending ??
                            scopedSnapshot.status === "error",
                        })
                      : candidate,
                  );
                }).pipe(
                  // SCIENT-FORK:START — list plugins after publication and stop evicted listings.
                  Effect.tap((afterScan) =>
                    Effect.gen(function* () {
                      if (
                        Ref.getUnsafe(workspaceRefreshesRef).get(instance)?.get(input.cwd) !== token
                      )
                        return;
                      yield* nativeInventory.markWorkspaceScan(
                        input.instanceId,
                        instance,
                        input.cwd,
                        scanSequence,
                      );
                      const published = afterScan
                        .find((candidate) => candidate.instanceId === input.instanceId)
                        ?.workspaceSnapshots?.some((snapshot) => snapshot.cwd === input.cwd);
                      if (published && instance.workspaceInventory) {
                        yield* instance.workspaceInventory.refresh(input.cwd, (inventory) =>
                          applyNativeInventory(instance, inventory).pipe(Effect.asVoid),
                        );
                      }
                      yield* retainWorkspaceListings([input.instanceId]);
                    }),
                  ),
                  // SCIENT-FORK:END
                );
              }),
            ),
          ),
        );
      }).pipe(Effect.ensuring(releaseClaim));
      // The claim and the fork happen together, so the token is always completed. The scan is
      // detached so a disconnecting owner cannot cancel the result its waiters depend on.
      const claim = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const inFlight = yield* Ref.modify(workspaceRefreshesRef, (refreshes) => {
            const current = refreshes.get(instance);
            const running = current?.get(input.cwd);
            if (!input.fresh && running) return [running, refreshes] as const;
            const next = new Map(refreshes);
            next.set(instance, new Map(current).set(input.cwd, token));
            return [undefined, next] as const;
          });
          if (inFlight) return { inFlight } as const;
          return {
            // Starting now attaches the scan's `ensuring` before anything can close the scope.
            scan: yield* Effect.forkIn(runScan, serviceScope, { startImmediately: true }),
          } as const;
        }),
      );
      // Wait for the running scan: on-demand clients get its result only in this reply.
      if ("inFlight" in claim) {
        return yield* Deferred.await(claim.inFlight).pipe(
          // SCIENT-FORK:START — shared scans retain their instance-owned listing lifetime.
          Effect.andThen(
            input.awaitNativeInventory
              ? awaitWorkspaceInventoryPublication(instance, input.cwd)
              : Ref.get(providersRef),
          ),
          // SCIENT-FORK:END
        );
      }
      const scanned = yield* Fiber.join(claim.scan);
      // SCIENT-FORK:START — the reply follows accepted native publication, not just scan completion.
      return input.awaitNativeInventory
        ? yield* awaitWorkspaceInventoryPublication(instance, input.cwd)
        : scanned;
      // SCIENT-FORK:END
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
      refreshAfterUpdate,
      getProviderMaintenanceCapabilitiesForInstance,
      getProviderConnectionActionsForInstance,
      getProviderManagedRuntimeActionsForInstance,
      getProviderSkillActionsForInstance,
      // SCIENT-FORK:START — Scient Extensions: provider-native plugins and MCP servers.
      getProviderPluginActionsForInstance,
      recordProviderNativeInventory,
      // SCIENT-FORK:END
      getVoiceTranscriptCorrectionForInstance,
      setProviderMaintenanceActionState,
      setProviderConnectionOperation,
      setProviderAuthenticationFailure,
      setProviderManagedRuntimeSummary,
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistry["Service"];
  }),
);
