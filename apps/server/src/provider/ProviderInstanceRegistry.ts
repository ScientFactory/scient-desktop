import {
  providerInstanceConfigEnabledFlag,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { buildUnavailableProviderSnapshot } from "./unavailableProviderSnapshot.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import type { AnyProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ScientProviderInstance } from "./ScientProviderInstance.ts";

// SCIENT-FORK:START — native sessions are owned by both instance and caller scopes.
import { ownNativeSessionLifetimes } from "./ScientNativeSessionLifetimes.ts";
import { hasUnresolvedProviderCredentials } from "./ScientProviderCredentialAvailability.ts";
// SCIENT-FORK:END

export interface ProviderInstanceRegistryShape {
  /**
   * Look up one instance by id. Returns `undefined` (not Option) when the
   * id is unknown — callers branch on falsy and emit
   * `ProviderInstanceNotFoundError`.
   */
  readonly getInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ScientProviderInstance | undefined>;
  /** Rebuild for dependencies outside settings, such as app-private runtime updates.
   * Unknown ids are a no-op; close the old scope before creating the replacement. */
  readonly rebuildInstance: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
  /**
   * Every available (driver-registered, successfully created) instance,
   * in stable settings-author order.
   */
  readonly listInstances: Effect.Effect<ReadonlyArray<ScientProviderInstance>>;
  /**
   * Wire-shape shadow snapshots for instances whose driver is unknown to
   * this build (or whose config failed to decode). Suitable for merging
   * directly into `ProviderRegistry` output.
   */
  readonly listUnavailable: Effect.Effect<ReadonlyArray<ServerProvider>>;
  /** streamChanges subscribes on consumption; use subscribeChanges before forking to avoid missing the next publish. */
  readonly streamChanges: Stream.Stream<void>;
  /** Subscribe in the caller's fiber before forking the consumer.
   * Stream.fromPubSub subscribes only on consumption, leaving a publish race. */
  readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
}

export class ProviderInstanceRegistry extends Context.Service<
  ProviderInstanceRegistry,
  ProviderInstanceRegistryShape
>()("t3/provider/ProviderInstanceRegistry") {}

interface LiveEntry {
  readonly instance: ProviderInstance;
  readonly scope: Scope.Closeable;
  readonly entry: ProviderInstanceConfig;
}

interface RegistryState {
  readonly entries: Ref.Ref<ReadonlyMap<ProviderInstanceId, LiveEntry>>;
  readonly unavailable: Ref.Ref<ReadonlyMap<ProviderInstanceId, ServerProvider>>;
  readonly configMap: Ref.Ref<ProviderInstanceConfigMap>;
  readonly changes: PubSub.PubSub<void>;
}

const entryEqual = (a: ProviderInstanceConfig, b: ProviderInstanceConfig): boolean =>
  Equal.equals(a, b);

/** Conflicting saved flags must preserve any explicit disable. */
const resolveEntryEnabled = (entry: ProviderInstanceConfig, typedConfig: unknown): boolean => {
  const rawConfigEnabled = providerInstanceConfigEnabledFlag(entry.config);
  if (entry.enabled === false || rawConfigEnabled === false) {
    return false;
  }
  return entry.enabled ?? providerInstanceConfigEnabledFlag(typedConfig) ?? true;
};

const buildEntry = Effect.fn("ProviderInstanceRegistry.buildEntry")(function* <R>(input: {
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly parentScope: Scope.Scope;
  readonly instanceId: ProviderInstanceId;
  readonly rawInstanceId: string;
  readonly entry: ProviderInstanceConfig;
}): Effect.fn.Return<
  | { readonly kind: "live"; readonly live: LiveEntry }
  | { readonly kind: "unavailable"; readonly snapshot: ServerProvider },
  never,
  R
> {
  const { driversById, parentScope, instanceId, rawInstanceId, entry } = input;
  const driver = driversById.get(entry.driver);
  if (!driver) {
    return {
      kind: "unavailable" as const,
      snapshot: yield* buildUnavailableProviderSnapshot({
        driverKind: entry.driver,
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        reason: `Driver '${entry.driver}' is not registered in this build.`,
      }),
    };
  }

  const decoder = Schema.decodeUnknownEffect(driver.configSchema);
  const decodeResult = yield* decoder(entry.config ?? driver.defaultConfig()).pipe(Effect.result);
  if (decodeResult._tag === "Failure") {
    const issue = decodeResult.failure;
    const detail = issue.message ?? String(issue);
    yield* Effect.logError("Failed to decode provider instance config", {
      instanceId: rawInstanceId,
      driver: entry.driver,
      detail,
    });
    return {
      kind: "unavailable" as const,
      snapshot: yield* buildUnavailableProviderSnapshot({
        driverKind: entry.driver,
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        reason: `Invalid config for instance '${rawInstanceId}': ${detail}`,
      }),
    };
  }

  const typedConfig = decodeResult.success;
  // SCIENT-FORK:START — stored credential markers cannot reach a native provider factory.
  if (hasUnresolvedProviderCredentials(entry.driver, typedConfig, entry.environment ?? [])) {
    return {
      kind: "unavailable" as const,
      snapshot: yield* buildUnavailableProviderSnapshot({
        driverKind: entry.driver,
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        reason:
          "Provider credentials could not be read. Reload settings after restoring the secret store.",
      }),
    };
  }
  // SCIENT-FORK:END
  const childScope = yield* Scope.make();
  yield* Scope.addFinalizer(parentScope, Scope.close(childScope, Exit.void).pipe(Effect.ignore));

  const createResult = yield* driver
    .create({
      instanceId,
      displayName: entry.displayName,
      accentColor: entry.accentColor,
      environment: entry.environment ?? [],
      enabled: resolveEntryEnabled(entry, typedConfig),
      config: typedConfig,
    })
    .pipe(Effect.provideService(Scope.Scope, childScope), Effect.result);
  if (createResult._tag === "Failure") {
    yield* Effect.logError("Failed to create provider instance", {
      instanceId: rawInstanceId,
      driver: entry.driver,
      detail: createResult.failure.detail,
    });
    yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
    return {
      kind: "unavailable" as const,
      snapshot: yield* buildUnavailableProviderSnapshot({
        driverKind: entry.driver,
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        reason: `Driver '${entry.driver}' failed to create instance: ${createResult.failure.detail}`,
      }),
    };
  }

  return {
    kind: "live" as const,
    live: {
      instance: ownNativeSessionLifetimes(createResult.success, childScope),
      scope: childScope,
      entry,
    },
  };
});

const makeReconcile = <R>(input: {
  readonly state: RegistryState;
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly parentScope: Scope.Scope;
}): ((
  configMap: ProviderInstanceConfigMap,
  forceRebuild?: ReadonlySet<ProviderInstanceId>,
) => Effect.Effect<void, never, R>) => {
  const { state, driversById, parentScope } = input;
  return (
    configMap: ProviderInstanceConfigMap,
    forceRebuild: ReadonlySet<ProviderInstanceId> = new Set(),
  ) =>
    Effect.gen(function* () {
      const previousEntries = yield* Ref.get(state.entries);
      const previousUnavailable = yield* Ref.get(state.unavailable);
      const nextRaw = Object.entries(configMap);
      const nextKeys = new Set<ProviderInstanceId>(
        nextRaw.map(([raw]) => ProviderInstanceId.make(raw)),
      );

      // Close changed/removed scopes before replacements to preserve one live scope per id.
      const removedIds: Array<ProviderInstanceId> = [];
      const replacedIds = new Set<ProviderInstanceId>();
      for (const [instanceId, live] of previousEntries) {
        if (!nextKeys.has(instanceId)) {
          removedIds.push(instanceId);
          continue;
        }
        const nextEntry = configMap[instanceId];
        if (
          nextEntry !== undefined &&
          (forceRebuild.has(instanceId) || !entryEqual(live.entry, nextEntry))
        ) {
          replacedIds.add(instanceId);
        }
      }
      for (const id of [...removedIds, ...replacedIds]) {
        const live = previousEntries.get(id);
        if (live) {
          yield* Scope.close(live.scope, Exit.void).pipe(Effect.ignore);
        }
      }

      const builtEntries = new Map<ProviderInstanceId, LiveEntry>();
      const builtUnavailable = new Map<ProviderInstanceId, ServerProvider>();
      let orderChanged = false;
      const previousOrder = [...previousEntries.keys()];
      const nextOrder: Array<ProviderInstanceId> = [];

      for (const [rawInstanceId, entry] of nextRaw) {
        const instanceId = ProviderInstanceId.make(rawInstanceId);
        nextOrder.push(instanceId);

        const existing = previousEntries.get(instanceId);
        if (existing !== undefined && !replacedIds.has(instanceId)) {
          builtEntries.set(instanceId, existing);
          continue;
        }

        const result = yield* buildEntry({
          driversById,
          parentScope,
          instanceId,
          rawInstanceId,
          entry,
        });
        if (result.kind === "live") {
          builtEntries.set(instanceId, result.live);
        } else {
          builtUnavailable.set(instanceId, result.snapshot);
        }
      }

      if (previousOrder.length === nextOrder.length) {
        for (let i = 0; i < previousOrder.length; i++) {
          if (previousOrder[i] !== nextOrder[i]) {
            orderChanged = true;
            break;
          }
        }
      } else {
        orderChanged = true;
      }

      const entriesChanged =
        orderChanged ||
        removedIds.length > 0 ||
        replacedIds.size > 0 ||
        builtEntries.size !== previousEntries.size;
      const unavailableChanged =
        builtUnavailable.size !== previousUnavailable.size ||
        [...builtUnavailable].some(([id, snapshot]) => {
          const prev = previousUnavailable.get(id);
          return prev === undefined || !Equal.equals(prev, snapshot);
        }) ||
        [...previousUnavailable].some(([id]) => !builtUnavailable.has(id));

      yield* Ref.set(state.entries, builtEntries);
      yield* Ref.set(state.unavailable, builtUnavailable);
      yield* Ref.set(state.configMap, configMap);

      if (entriesChanged || unavailableChanged) {
        yield* PubSub.publish(state.changes, undefined);
      }
    });
};

export const makeProviderInstanceRegistry = Effect.fn(
  "ProviderInstanceRegistry.makeProviderInstanceRegistry",
)(function* <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Effect.fn.Return<
  {
    readonly registry: ProviderInstanceRegistry["Service"];
    readonly mutator: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape;
  },
  never,
  R | Scope.Scope
> {
  const driversById = new Map<ProviderDriverKind, AnyProviderDriver<R>>(
    input.drivers.map((driver) => [driver.driverKind, driver]),
  );

  // Capture the enclosing scope so per-instance child scopes can be
  // attached to it at `reconcile` time. Without this, `reconcile`
  // called later (e.g. from the hydration layer) would attach child
  // scopes to the *caller's* scope instead of the registry's.
  const parentScope = yield* Scope.Scope;

  const driverContext = yield* Effect.context<R>();

  const entries = yield* Ref.make<ReadonlyMap<ProviderInstanceId, LiveEntry>>(new Map());
  const unavailable = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ServerProvider>>(new Map());
  const configMap = yield* Ref.make(input.configMap);
  const changes = yield* PubSub.unbounded<void>();
  const reconcileSemaphore = yield* Semaphore.make(1);
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

  const state: RegistryState = { entries, unavailable, configMap, changes };
  const reconcileWithR = makeReconcile({ state, driversById, parentScope });
  const reconcile: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape["reconcile"] =
    (nextConfigMap) =>
      reconcileSemaphore.withPermit(
        reconcileWithR(nextConfigMap).pipe(Effect.provideContext(driverContext)),
      );
  const rebuildInstanceUnserialized = Effect.fn(
    "ProviderInstanceRegistry.rebuildInstanceUnserialized",
  )(function* (instanceId: ProviderInstanceId) {
    const currentConfigMap = yield* Ref.get(configMap);
    if (!(instanceId in currentConfigMap)) return;
    yield* reconcileWithR(currentConfigMap, new Set([instanceId])).pipe(
      Effect.provideContext(driverContext),
    );
  });
  const rebuildInstance: ProviderInstanceRegistryShape["rebuildInstance"] = (instanceId) =>
    reconcileSemaphore.withPermit(rebuildInstanceUnserialized(instanceId));

  yield* reconcile(input.configMap);

  const registry: ProviderInstanceRegistry["Service"] = {
    getInstance: (id) => Ref.get(entries).pipe(Effect.map((map) => map.get(id)?.instance)),
    rebuildInstance,
    listInstances: Ref.get(entries).pipe(
      Effect.map(
        (map) =>
          Array.from(map.values(), (live) => live.instance) as ReadonlyArray<ProviderInstance>,
      ),
    ),
    listUnavailable: Ref.get(unavailable).pipe(
      Effect.map((map) => Array.from(map.values()) as ReadonlyArray<ServerProvider>),
    ),
    get streamChanges() {
      return Stream.fromPubSub(changes);
    },
    get subscribeChanges() {
      return PubSub.subscribe(changes);
    },
  };

  const mutator: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape = {
    reconcile,
  };

  return { registry, mutator };
});

export const layer = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Layer.Layer<
  ProviderInstanceRegistry | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
  never,
  R
> =>
  Layer.effectContext(
    makeProviderInstanceRegistry(input).pipe(
      Effect.map(({ registry, mutator }) =>
        Context.make(ProviderInstanceRegistry, registry).pipe(
          Context.add(ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator, mutator),
        ),
      ),
    ),
  ) as Layer.Layer<
    ProviderInstanceRegistry | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
    never,
    R
  >;
