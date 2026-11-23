/**
 * Scient's settings service, built by the settings layers so it shares their state,
 * and the text-generation fallback that keeps the default-on Scient Agent last.
 * @module scientServerSettings
 */
import {
  CustomModelError,
  DEDICATED_CUSTOM_MODEL_KEY_MESSAGE,
  requiresDedicatedCustomModelKey,
  type AccountId,
  type CustomModelConnection,
  DEFAULT_SERVER_SETTINGS,
  type CustomModelSaveInput,
  type CustomModelsSettings,
  type ProjectId,
  type ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerSettings,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { fallbackScientTextGenerationModelSelection } from "@t3tools/shared/scientTextGenerationSelection";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import type * as Semaphore from "effect/Semaphore";

import type * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import type { ServerSettingsService } from "./serverSettings.ts";
import type { makeCustomModelReasoning } from "./customModelReasoning.ts";
import {
  customModelSecretName,
  droidCanUseKey,
  prepareCustomModelSave,
  resolveCustomModels,
  resolveCustomModelKey,
  saveCustomModel,
  type ResolvedModelConnection,
  type CustomModelAccountResolver,
} from "./customModels.ts";

/** Custom-model members of the Scient settings service. */
export interface CustomModelSettingsMethods {
  readonly customModelAccounts?: {
    readonly install: (
      resolve: CustomModelAccountResolver,
      migrate: Effect.Effect<void>,
    ) => Effect.Effect<void>;
    readonly read: Effect.Effect<CustomModelsSettings, ServerSettingsError>;
    readonly requiresDedicated: (
      connection: CustomModelConnection,
    ) => Effect.Effect<boolean, ServerSettingsError>;
    readonly invalidate: (ids: ReadonlySet<AccountId>, version: string) => Effect.Effect<void>;
    readonly setBinding: (
      expected: CustomModelConnection,
      binding: Pick<CustomModelConnection, "accountId" | "credentialId">,
    ) => Effect.Effect<boolean, CustomModelError>;
  };
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

/** Scient's settings capabilities; the settings layers build it with the settings service. */
interface ScientServerSettingsShape extends CustomModelSettingsMethods {
  /** Authoritative project deletion. Server-only: no RPC exposes it. */
  readonly removeProjectSettingsOverrides: (
    projectIds: ReadonlyArray<ProjectId>,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;
}

export class ScientServerSettings extends Context.Service<
  ScientServerSettings,
  ScientServerSettingsShape
>()("t3/scientServerSettings") {}

/** What a custom-model runtime reads: settings members `T` and catalog members `C`. */
export type CustomModelSettingsSource<
  T extends keyof ServerSettingsService["Service"],
  C extends keyof CustomModelSettingsMethods,
> = Pick<ServerSettingsService["Service"], T> & Pick<CustomModelSettingsMethods, C>;

/** The catalog from Scient's service with the settings reads and changes it follows. */
export const customModelSettingsSource = (
  settings: Pick<ServerSettingsService["Service"], "getSettings" | "subscribeChanges">,
  scient: CustomModelSettingsMethods,
): CustomModelSettingsSource<
  "getSettings" | "subscribeChanges",
  keyof CustomModelSettingsMethods
> => ({
  ...scient,
  getSettings: settings.getSettings,
  subscribeChanges: settings.subscribeChanges,
});

/** Settings-service state the custom-model methods read and commit through. */
export interface CustomModelSettingsInput {
  readonly secretStore: ServerSecretStore.ServerSecretStore["Service"];
  readonly modelReasoning: ReturnType<typeof makeCustomModelReasoning>;
  readonly writeSemaphore: Semaphore.Semaphore;
  readonly getSettingsFromCache: Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly readCustomModels: Effect.Effect<CustomModelsSettings, ServerSettingsError>;
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
    readCustomModels,
    normalizeServerSettings,
    writeSettingsAtomically,
    cacheSettings,
    emitChange,
    committedCustomModels,
  } = service;

  const customModelFailure = () =>
    new CustomModelError({ message: "Could not save custom models." });
  const commitCustomModels = Effect.fn("scientServerSettings.commitCustomModels")(
    function* (current: ServerSettings, customModels: CustomModelsSettings) {
      const next = yield* normalizeServerSettings({ ...current, customModels });
      yield* writeSettingsAtomically(next);
      yield* cacheSettings(next);
      yield* emitChange(next);
    },
    (effect) => effect.pipe(Effect.mapError(customModelFailure)),
  );

  let resolveAccount: CustomModelAccountResolver | undefined;
  let migrateKeys = Effect.void;
  return {
    customModelAccounts: {
      install: Effect.fn("CustomModelAccounts.install")(function* (resolve, migrate) {
        resolveAccount = resolve;
        migrateKeys = migrate;
        if (!Ref.getUnsafe(committedCustomModels).connections.some(({ accountId }) => accountId))
          return;
        yield* writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const settings = yield* getSettingsFromCache;
            const version = String(yield* Random.nextInt);
            const ready = {
              ...settings,
              customModels: {
                ...settings.customModels,
                connections: settings.customModels.connections.map((connection) =>
                  connection.accountId ? { ...connection, accountKeyVersion: version } : connection,
                ),
              },
            };
            yield* cacheSettings(ready);
            yield* emitChange(ready);
          }).pipe(Effect.ignore),
        );
      }),
      read: readCustomModels,
      requiresDedicated: (connection) =>
        getSettingsFromCache.pipe(
          Effect.map(({ providerInstances }) =>
            requiresDedicatedCustomModelKey(connection, providerInstances),
          ),
        ),
      invalidate: (ids, version) =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* getSettingsFromCache;
            if (
              !current.customModels.connections.some(
                (row) => row.accountId && ids.has(row.accountId),
              )
            )
              return;
            const next = {
              revision: current.customModels.revision + 1,
              connections: current.customModels.connections.map((row) =>
                row.accountId && ids.has(row.accountId)
                  ? { ...row, accountKeyVersion: version, apiKeySuffix: null }
                  : row,
              ),
            };
            // The key commit already succeeded. Revoke the in-memory authority even if
            // persisting the opaque generation fails. A restart reads the new key directly.
            yield* commitCustomModels(current, next).pipe(
              Effect.catch(() => {
                const updated = { ...current, customModels: next };
                return cacheSettings(updated).pipe(Effect.andThen(emitChange(updated)));
              }),
            );
          }).pipe(Effect.ignore),
        ),
      setBinding: (expected, binding) =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* getSettingsFromCache.pipe(Effect.mapError(customModelFailure));
            const connection = current.customModels.connections.find(
              (row) => row.id === expected.id,
            );
            if (
              !connection ||
              connection.credentialId !== expected.credentialId ||
              connection.accountId !== expected.accountId ||
              connection.baseUrl !== expected.baseUrl ||
              connection.protocol !== expected.protocol
            )
              return false;
            yield* commitCustomModels(current, {
              revision: current.customModels.revision + 1,
              connections: current.customModels.connections.map((row) =>
                row.id === connection.id ? { ...row, ...binding } : row,
              ),
            });
            return true;
          }).pipe(Effect.uninterruptible),
        ),
    },
    saveCustomModel: Effect.fn("scientServerSettings.saveCustomModel")(function* (input) {
      const prepared = yield* writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const before = yield* getSettingsFromCache.pipe(Effect.mapError(customModelFailure));
          return yield* prepareCustomModelSave(before, input, secretStore);
        }),
      );
      const { credentialError: _error, apiKey: _key, ...connection } = prepared.connection;
      const selected = connection.accountId
        ? yield* resolveCustomModelKey(prepared.connection, secretStore, resolveAccount)
        : prepared.connection;
      if (input.accountId && (!selected.apiKey || selected.credentialError))
        return yield* new CustomModelError({
          message: "Choose a saved API key for this exact endpoint.",
        });
      if (
        input.accountId &&
        selected.apiKey &&
        prepared.attachedToDroid &&
        !droidCanUseKey(Redacted.value(selected.apiKey))
      )
        return yield* new CustomModelError({
          message: "Choose a key without spaces or control characters for Droid.",
        });
      // Explicit setup only: slow endpoints must not block settings reads or other writes.
      const enriched = yield* modelReasoning.prepare(
        { ...connection, ...selected },
        prepared.previous,
        input.refreshModelId,
      );
      const metadata = new Map(
        enriched.models.flatMap((model) =>
          model.reasoningMetadata ? [[model.id, model.reasoningMetadata] as const] : [],
        ),
      );
      const saved = yield* writeSemaphore.withPermits(1)(
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
      if (!input.apiKey) return saved;
      yield* migrateKeys;
      return (yield* getSettingsFromCache.pipe(Effect.mapError(customModelFailure))).customModels;
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
      writeSemaphore
        .withPermits(1)(
          getSettingsFromCache.pipe(
            Effect.mapError(customModelFailure),
            Effect.flatMap((settings) =>
              resolveCustomModels(settings.customModels, instanceId, secretStore).pipe(
                Effect.map((rows) =>
                  rows.map((row): ResolvedModelConnection => {
                    if (
                      !row.accountId ||
                      !requiresDedicatedCustomModelKey(row, settings.providerInstances)
                    )
                      return row;
                    const { apiKey: _value, ...connection } = row;
                    return { ...connection, credentialError: DEDICATED_CUSTOM_MODEL_KEY_MESSAGE };
                  }),
                ),
              ),
            ),
          ),
        )
        .pipe(
          Effect.flatMap((connections) =>
            Effect.forEach(connections, (resolved) => {
              if (
                !resolved.accountId ||
                resolved.credentialError === DEDICATED_CUSTOM_MODEL_KEY_MESSAGE
              )
                return Effect.succeed(resolved);
              const { credentialError: _error, apiKey: _key, ...connection } = resolved;
              return resolveCustomModelKey(connection, secretStore, resolveAccount).pipe(
                Effect.map((credential) => ({ ...connection, ...credential })),
              );
            }),
          ),
        ),
    committedCustomModels: () => Ref.getUnsafe(committedCustomModels),
  };
}

/** Preserve the environment selection when no enabled provider can replace it. */
export function fallbackTextGenerationProvider(
  settings: ServerSettings,
  isDriverAllowed: (driver: ProviderDriverKind) => boolean = () => true,
): ServerSettings {
  const selection = fallbackScientTextGenerationModelSelection(
    settings.providerInstances,
    (instanceId, driver) =>
      // A default instance id can be configured with another driver.
      isDriverAllowed(settings.providerInstances[instanceId]?.driver ?? driver) &&
      resolveProviderInstanceEnabled(
        settings.providerInstances[instanceId] ?? { driver, config: {} },
      ),
    { defaultModelSelection: settings.defaultModelSelection },
  );
  return selection === null ? settings : { ...settings, textGenerationModelSelection: selection };
}
