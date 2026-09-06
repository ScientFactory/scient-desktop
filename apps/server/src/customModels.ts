import * as NodeCrypto from "node:crypto";
import {
  CustomModelError,
  validateCustomModelConnection,
  supportsModelConnections,
  type CustomModelConnection,
  type CustomModelSaveInput,
  type CustomModelsSettings,
  type ModelReasoningMetadata,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { ServerSecretStore } from "./auth/ServerSecretStore.ts";

export const customModelSecretName = (id: string) => `custom-model-${id}`;
const failure = (message: string) => new CustomModelError({ message });
export const customModelProviderId = (id: string) => `scient_${id}`;
const keySuffix = (key: string) => (key.length > 4 ? key.slice(-4) : null);

/** Older catalogs have no hint. Read their secrets only on the server, without rewriting them. */
export const withCustomModelKeyHints = Effect.fn("CustomModels.keyHints")(function* (
  settings: CustomModelsSettings,
  secrets: ServerSecretStore["Service"],
) {
  const connections: CustomModelConnection[] = [];
  for (const connection of settings.connections) {
    if (!connection.credentialId || connection.apiKeySuffix !== undefined) {
      connections.push(connection);
      continue;
    }
    const stored = yield* secrets
      .get(customModelSecretName(connection.credentialId))
      .pipe(Effect.catch(() => Effect.succeed(Option.none<Uint8Array>())));
    connections.push({
      ...connection,
      apiKeySuffix: Option.isSome(stored)
        ? keySuffix(new TextDecoder().decode(stored.value))
        : null,
    });
  }
  return { ...settings, connections };
});
export type ResolvedModelConnection = CustomModelConnection &
  (
    | { readonly apiKey: Redacted.Redacted<string> | null; readonly credentialError?: never }
    | { readonly credentialError: string; readonly apiKey?: never }
  );

/** Run before setup IO and again under the commit lock. */
export const validateCustomModelSave = Effect.fn("CustomModels.validateSave")(function* (
  current: ServerSettings,
  input: CustomModelSaveInput,
) {
  if (current.customModels.revision !== input.revision)
    return yield* failure("Custom models changed. Reload and try again.");
  const invalid = validateCustomModelConnection(input.connection);
  if (invalid) return yield* failure(invalid);
  if (
    input.refreshModelId &&
    !input.connection.models.some((model) => model.id === input.refreshModelId)
  )
    return yield* failure("This model is no longer in the connection.");
  for (const model of input.connection.models) {
    if (new Set(model.instanceIds).size !== model.instanceIds.length)
      return yield* failure("This model already includes that agent.");
    for (const id of model.instanceIds) {
      const instance = current.providerInstances[id];
      if (
        !supportsModelConnections(
          instance?.driver ?? (id === "pi" && !instance ? "pi" : undefined),
          input.connection.protocol,
        )
      )
        return yield* failure("This agent does not support custom models.");
    }
  }
  const existing = current.customModels.connections.find((c) => c.id === input.connection.id);
  if (!existing && current.customModels.connections.length >= 100)
    return yield* failure("Connection limit reached.");
  const key = input.apiKey === undefined ? undefined : Redacted.value(input.apiKey);
  if (key !== undefined && (!key.trim() || key.length > 16_384 || /[\r\n\0]/u.test(key)))
    return yield* failure("Enter a valid API key.");
  if (key !== undefined && input.removeKey)
    return yield* failure("Choose either replacing or removing the API key.");
  // A retained credential must never silently move to another origin.
  if (
    existing?.credentialId &&
    key === undefined &&
    !input.removeKey &&
    new URL(existing.baseUrl).origin !== new URL(input.connection.baseUrl).origin
  )
    return yield* failure("Re-enter the API key when changing the endpoint host.");
  return { existing, key };
});

/** Snapshot the selected secret under the write lock; discovery itself happens outside it. */
export const prepareCustomModelSave = Effect.fn("CustomModels.prepareSave")(function* (
  current: ServerSettings,
  input: CustomModelSaveInput,
  secrets: ServerSecretStore["Service"],
) {
  const { existing, key } = yield* validateCustomModelSave(current, input);
  const credentialId = input.removeKey ? null : (existing?.credentialId ?? null);
  let apiKey = input.apiKey ?? null;
  let credentialError: string | undefined;
  if (key === undefined && credentialId) {
    const stored = yield* secrets
      .get(customModelSecretName(credentialId))
      .pipe(Effect.catch(() => Effect.succeed(Option.none<Uint8Array>())));
    if (Option.isNone(stored))
      credentialError = "Saved API key is unavailable. Re-enter or remove it.";
    else apiKey = Redacted.make(new TextDecoder().decode(stored.value));
  }
  // A broken key must not prevent editing or detaching models. Do not use an
  // unauthenticated network lookup as a substitute for that credential.
  const connection: ResolvedModelConnection = {
    ...input.connection,
    credentialId,
    ...(credentialError ? { credentialError } : { apiKey }),
  };
  return {
    connection,
    previous:
      key === undefined &&
      !input.removeKey &&
      existing?.baseUrl === input.connection.baseUrl &&
      existing.protocol === input.connection.protocol
        ? existing
        : undefined,
  };
});

/** Settings and secrets are committed once, under the settings service's existing write lock. */
export const saveCustomModel = Effect.fn("CustomModels.save")(function* (
  current: ServerSettings,
  input: CustomModelSaveInput,
  secrets: ServerSecretStore["Service"],
  commit: (settings: CustomModelsSettings) => Effect.Effect<void, CustomModelError>,
  metadata: ReadonlyMap<string, ModelReasoningMetadata> = new Map(),
) {
  const { existing, key } = yield* validateCustomModelSave(current, input);
  const credentialId =
    key !== undefined
      ? NodeCrypto.randomUUID()
      : input.removeKey
        ? null
        : (existing?.credentialId ?? null);
  const connection: CustomModelConnection = {
    ...input.connection,
    models: input.connection.models.map(({ reasoningMetadata: _derived, ...model }) => ({
      ...model,
      ...(metadata.has(model.id) ? { reasoningMetadata: metadata.get(model.id)! } : {}),
    })),
    credentialId,
    apiKeySuffix:
      key !== undefined
        ? keySuffix(key)
        : input.removeKey
          ? null
          : (existing?.apiKeySuffix ?? null),
  };
  const next: CustomModelsSettings = {
    revision: current.customModels.revision + 1,
    connections: existing
      ? current.customModels.connections.map((c) => (c.id === connection.id ? connection : c))
      : [...current.customModels.connections, connection],
  };
  if (key !== undefined && credentialId)
    yield* secrets
      .create(customModelSecretName(credentialId), new TextEncoder().encode(key))
      .pipe(Effect.mapError(() => failure("Could not store the API key.")));
  yield* commit(next).pipe(
    Effect.onError(() =>
      key !== undefined && credentialId
        ? secrets.remove(customModelSecretName(credentialId)).pipe(Effect.ignore)
        : Effect.void,
    ),
  );
  // An inaccessible orphan is preferable to rolling back a successful metadata commit.
  if (existing?.credentialId && existing.credentialId !== credentialId)
    yield* secrets.remove(customModelSecretName(existing.credentialId)).pipe(Effect.ignore);
  return next;
});

export const resolveCustomModels = Effect.fn("CustomModels.resolve")(function* (
  settings: CustomModelsSettings,
  instanceId: ProviderInstanceId,
  secrets: ServerSecretStore["Service"],
): Effect.fn.Return<ReadonlyArray<ResolvedModelConnection>, CustomModelError> {
  const connections: ResolvedModelConnection[] = [];
  for (const connection of settings.connections) {
    const models = connection.models.filter((model) => model.instanceIds.includes(instanceId));
    if (!models.length) continue;
    const stored = yield* (
      connection.credentialId
        ? secrets.get(customModelSecretName(connection.credentialId))
        : Effect.succeed(Option.none<Uint8Array>())
    ).pipe(Effect.result);
    if (stored._tag === "Failure" || (connection.credentialId && Option.isNone(stored.success))) {
      // Keep the failure attached to its connection, never turn it into keyless access.
      connections.push({
        ...connection,
        models,
        credentialError: `Re-enter the API key for ${connection.name} in Custom models.`,
      });
      continue;
    }
    connections.push({
      ...connection,
      models,
      apiKey: Option.isSome(stored.success)
        ? Redacted.make(new TextDecoder().decode(stored.success.value))
        : null,
    });
  }
  return connections;
});
