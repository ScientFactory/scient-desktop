/**
 * Scient extensions to the server settings service: the custom-model
 * catalog's service methods and the text-generation fallback that keeps the
 * default-on Scient Agent as the last resort.
 *
 * @module scientServerSettings
 */
import {
  CustomModelError,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type CustomModelSaveInput,
  type CustomModelsSettings,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  defaultInstanceIdForDriver,
  isProviderDriverKind,
  resolveProviderInstanceEnabled,
  type ServerSettings,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Semaphore from "effect/Semaphore";

import type * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import type { makeCustomModelReasoning } from "./customModelReasoning.ts";
import {
  customModelSecretName,
  prepareCustomModelSave,
  resolveCustomModels,
  saveCustomModel,
  type ResolvedModelConnection,
} from "./customModels.ts";

/** Custom-model members of the server settings service. */
export interface CustomModelSettingsMethods {
  readonly saveCustomModel: (
    input: CustomModelSaveInput,
  ) => Effect.Effect<CustomModelsSettings, CustomModelError>;
  readonly removeCustomModel: (input: {
    readonly revision: number;
    readonly connectionId: string;
  }) => Effect.Effect<CustomModelsSettings, CustomModelError>;
  readonly resolveCustomModels: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ResolvedModelConnection>, CustomModelError>;
  /**
   * The custom-model catalog as last committed or reloaded, read
   * synchronously: no keys, no settings load, no lock. A save replaces it
   * before its old key is removed, so a check that reads it and starts a
   * request in the same step is ordered with every committed change.
   */
  readonly committedCustomModels: () => CustomModelsSettings;
}

export const customModelsTestMethods = {
  saveCustomModel: () =>
    Effect.fail(
      new CustomModelError({
        message: "Custom model persistence is unavailable in this test layer.",
      }),
    ),
  removeCustomModel: () =>
    Effect.fail(
      new CustomModelError({
        message: "Custom model persistence is unavailable in this test layer.",
      }),
    ),
  resolveCustomModels: () => Effect.succeed([]),
  committedCustomModels: () => DEFAULT_SERVER_SETTINGS.customModels,
} satisfies CustomModelSettingsMethods;

/** Settings-service state the custom-model methods read and commit through. */
export interface CustomModelSettingsInput {
  readonly secretStore: ServerSecretStore.ServerSecretStore["Service"];
  readonly modelReasoning: ReturnType<typeof makeCustomModelReasoning>;
  readonly writeSemaphore: Semaphore.Semaphore;
  readonly getSettingsFromCache: Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly normalizeServerSettings: (
    settings: ServerSettings,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly writeSettingsAtomically: (
    settings: ServerSettings,
  ) => Effect.Effect<void, ServerSettingsError>;
  readonly cacheSettings: (settings: ServerSettings) => Effect.Effect<void>;
  readonly emitChange: (settings: ServerSettings) => Effect.Effect<void>;
  readonly committedCustomModels: Ref.Ref<CustomModelsSettings>;
}

export function makeCustomModelSettingsMethods(
  service: CustomModelSettingsInput,
): CustomModelSettingsMethods {
  const {
    secretStore,
    modelReasoning,
    writeSemaphore,
    getSettingsFromCache,
    normalizeServerSettings,
    writeSettingsAtomically,
    cacheSettings,
    emitChange,
    committedCustomModels,
  } = service;

  const customModelFailure = () =>
    new CustomModelError({ message: "Could not save custom models." });
  const commitCustomModels = (current: ServerSettings, customModels: CustomModelsSettings) =>
    Effect.gen(function* () {
      const next = yield* normalizeServerSettings({ ...current, customModels });
      yield* writeSettingsAtomically(next);
      yield* cacheSettings(next);
      yield* emitChange(next);
    }).pipe(Effect.mapError(customModelFailure));

  return {
    saveCustomModel: (input) =>
      Effect.gen(function* () {
        const prepared = yield* writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* getSettingsFromCache.pipe(Effect.mapError(customModelFailure));
            return yield* prepareCustomModelSave(current, input, secretStore);
          }),
        );
        // Explicit setup only: slow endpoints must not block settings reads or other writes.
        const enriched = yield* modelReasoning.prepare(
          prepared.connection,
          prepared.previous,
          input.refreshModelId,
        );
        const metadata = new Map(
          enriched.models.flatMap((model) =>
            model.reasoningMetadata ? [[model.id, model.reasoningMetadata] as const] : [],
          ),
        );
        return yield* writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* getSettingsFromCache.pipe(Effect.mapError(customModelFailure));
            return yield* saveCustomModel(
              current,
              input,
              secretStore,
              (next) => commitCustomModels(current, next),
              metadata,
            );
          }).pipe(Effect.uninterruptible),
        );
      }),
    removeCustomModel: (input) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getSettingsFromCache.pipe(Effect.mapError(customModelFailure));
          if (current.customModels.revision !== input.revision)
            return yield* new CustomModelError({
              message: "Custom models changed. Reload and try again.",
            });
          const existing = current.customModels.connections.find(
            (c) => c.id === input.connectionId,
          );
          if (!existing) return current.customModels;
          const next = {
            revision: input.revision + 1,
            connections: current.customModels.connections.filter(
              (c) => c.id !== input.connectionId,
            ),
          };
          yield* commitCustomModels(current, next);
          if (existing.credentialId)
            yield* secretStore
              .remove(customModelSecretName(existing.credentialId))
              .pipe(Effect.ignore);
          return next;
        }).pipe(Effect.uninterruptible),
      ),
    resolveCustomModels: (instanceId) =>
      writeSemaphore.withPermits(1)(
        getSettingsFromCache.pipe(
          Effect.mapError(() => new CustomModelError({ message: "Could not read custom models." })),
          Effect.flatMap((settings) =>
            resolveCustomModels(settings.customModels, instanceId, secretStore),
          ),
        ),
      ),
    committedCustomModels: () => Ref.getUnsafe(committedCustomModels),
  };
}

const TEXT_GENERATION_FALLBACK_DRIVERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "droid",
  "grok",
  "muse",
  "pi",
  "opencode",
  "omp",
  "antigravity",
  // Scient Agent is enabled by default, so it is a last resort rather than a
  // signal that the user opted into a provider.
  "scient",
].map((driver) => ProviderDriverKind.make(driver));

export function fallbackTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const enabledBuiltIns = TEXT_GENERATION_FALLBACK_DRIVERS.filter((driver) => {
    const instanceId = defaultInstanceIdForDriver(driver);
    const instance = settings.providerInstances[instanceId] ?? { driver, config: {} };
    return resolveProviderInstanceEnabled(instance);
  });
  const selectedBuiltIn = enabledBuiltIns.find((driver) => driver !== "scient");
  const lastResort = enabledBuiltIns.find((driver) => driver === "scient");
  const fallback = selectedBuiltIn
    ? { instanceId: defaultInstanceIdForDriver(selectedBuiltIn), driver: selectedBuiltIn }
    : (enabledNamedInstance(settings) ??
      (lastResort
        ? { instanceId: defaultInstanceIdForDriver(lastResort), driver: lastResort }
        : undefined));
  if (!fallback) {
    return settings;
  }

  const driver = fallback.driver;
  return {
    ...settings,
    textGenerationModelSelection: {
      instanceId: fallback.instanceId,
      model:
        DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver] ??
        DEFAULT_MODEL_BY_PROVIDER[driver] ??
        DEFAULT_TEXT_GENERATION_MODEL,
    } satisfies ModelSelection,
  };
}

/**
 * With no built-in instance enabled, an enabled instance under another id (a
 * second account, a named setup) generates text. Instances of a driver this
 * build does not have are skipped. The choice is stable: drivers in the
 * built-in order, then instance ids in code-point order.
 */
function enabledNamedInstance(
  settings: ServerSettings,
): { readonly instanceId: ProviderInstanceId; readonly driver: ProviderDriverKind } | undefined {
  const driverOrder = new Map(
    TEXT_GENERATION_FALLBACK_DRIVERS.map((driver, index) => [driver, index]),
  );
  const [first] = Object.entries(settings.providerInstances)
    .filter(
      ([instanceId, instance]) =>
        instanceId !== defaultInstanceIdForDriver(instance.driver) &&
        isProviderDriverKind(instance.driver) &&
        driverOrder.has(instance.driver) &&
        resolveProviderInstanceEnabled(instance),
    )
    .toSorted(
      ([leftId, left], [rightId, right]) =>
        driverOrder.get(left.driver)! - driverOrder.get(right.driver)! ||
        (leftId < rightId ? -1 : leftId > rightId ? 1 : 0),
    );
  return first
    ? { instanceId: ProviderInstanceId.make(first[0]), driver: first[1].driver }
    : undefined;
}
