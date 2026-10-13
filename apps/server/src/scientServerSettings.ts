/**
 * Scient extensions to the server settings service: the custom-model
 * catalog's service methods and the text-generation fallback that keeps the
 * default-on Scient Agent as the last resort.
 *
 * @module scientServerSettings
 */
import {
  CustomModelError,
  DEFAULT_SERVER_SETTINGS,
  type CustomModelSaveInput,
  type CustomModelsSettings,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerSettings,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { fallbackScientTextGenerationModelSelection } from "@t3tools/shared/scientTextGenerationSelection";
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

/** Preserve the environment selection when no enabled provider can replace it. */
export function fallbackTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const selection = fallbackScientTextGenerationModelSelection(
    settings.providerInstances,
    (instanceId, driver) =>
      resolveProviderInstanceEnabled(
        settings.providerInstances[instanceId] ?? { driver, config: {} },
      ),
  );
  return selection === null ? settings : { ...settings, textGenerationModelSelection: selection };
}
