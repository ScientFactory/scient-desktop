// @effect-diagnostics nodeBuiltinImport:off -- The settings transaction assigns an opaque credential ID synchronously before committing.
import * as NodeCrypto from "node:crypto";
import {
  CustomModelError,
  requiresDedicatedCustomModelKey,
  DEDICATED_CUSTOM_MODEL_KEY_MESSAGE,
  type AccountsError,
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
    if (connection.accountId || !connection.credentialId || connection.apiKeySuffix !== undefined) {
      connections.push(connection);
      continue;
    }
    const stored = yield* secrets
      .get(customModelSecretName(connection.credentialId))
      .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    connections.push({
      ...connection,
      apiKeySuffix: Option.isSome(stored)
        ? keySuffix(new TextDecoder().decode(stored.value))
        : null,
    });
  }
  return { ...settings, connections };
});
export type CustomModelAccountResolver = (
  accountId: NonNullable<CustomModelConnection["accountId"]>,
  origin: string,
  protocol: CustomModelConnection["protocol"],
) => Effect.Effect<{ token: Redacted.Redacted<string> }, AccountsError>;

export type ResolvedModelConnection = CustomModelConnection &
  (
    | { readonly apiKey: Redacted.Redacted<string> | null; readonly credentialError?: never }
    | { readonly credentialError: string; readonly apiKey?: never }
  );

/** A stored key as it is used: without the whitespace around it. Undefined when nothing is left. */
const usableStoredKey = (stored: Uint8Array): string | undefined =>
  new TextDecoder().decode(stored).trim() || undefined;

/**
 * Droid's key broker must recognize a key an endpoint echoes back, and a
 * JSON-escaped control character (a tab becomes `\t`) or a space would hide
 * it. So Droid, and only Droid, cannot use a key with whitespace or a control
 * character inside.
 */
export const droidCanUseKey = (key: string) => !/[\s\p{Cc}]/u.test(key);

/** Run before setup IO and again under the commit lock. */
const validateCustomModelSave = Effect.fn("CustomModels.validateSave")(function* (
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
  const existing = current.customModels.connections.find((c) => c.id === input.connection.id);
  let attachedToDroid = false;
  for (const model of input.connection.models) {
    if (new Set(model.instanceIds).size !== model.instanceIds.length)
      return yield* failure("This model already includes that agent.");
    const saved = existing?.models.find((entry) => entry.id === model.id)?.instanceIds ?? [];
    for (const id of model.instanceIds) {
      // Supported built-in drivers run their default instance even when its
      // settings entry is absent (for example after "Reset default instance").
      const driver =
        current.providerInstances[id]?.driver ?? (supportsModelConnections(id) ? id : undefined);
      // A removed agent's id stays until the user detaches it; nothing loads it.
      if (driver === undefined && saved.includes(id)) continue;
      if (!supportsModelConnections(driver, input.connection.protocol))
        return yield* failure("This agent does not support custom models.");
      attachedToDroid ||= driver === "droid";
    }
  }
  if (!existing && current.customModels.connections.length >= 100)
    return yield* failure("Connection limit reached.");
  const key = input.apiKey === undefined ? undefined : Redacted.value(input.apiKey).trim();
  if (key !== undefined && (!key || key.length > 16_384 || /[\r\n\0]/u.test(key)))
    return yield* failure("Enter a valid API key.");
  if (key !== undefined && attachedToDroid && !droidCanUseKey(key))
    return yield* failure(
      "Droid can't use an API key that contains spaces, tabs or other control characters. Paste the key again without them, or remove Droid under Use with.",
    );
  const dedicated = requiresDedicatedCustomModelKey(input.connection, current.providerInstances);
  if (input.useDedicatedKey && (!dedicated || key === undefined))
    return yield* failure("Enter a key to keep just for this connection.");
  if (dedicated && input.accountId) return yield* failure(DEDICATED_CUSTOM_MODEL_KEY_MESSAGE);
  if (dedicated && existing?.accountId && !input.removeKey && !input.useDedicatedKey)
    return yield* failure(DEDICATED_CUSTOM_MODEL_KEY_MESSAGE);
  if (existing?.accountId && key !== undefined && !input.useDedicatedKey)
    return yield* failure("Replace this key in Accounts.");
  if (input.accountId && (key !== undefined || input.removeKey))
    return yield* failure("Choose one way to update the API key.");
  if (key !== undefined && input.removeKey)
    return yield* failure("Choose either replacing or removing the API key.");
  // A retained credential must never silently move to another origin.
  if (
    (existing?.credentialId || existing?.accountId) &&
    key === undefined &&
    !input.removeKey &&
    !input.accountId &&
    (new URL(existing.baseUrl).origin !== new URL(input.connection.baseUrl).origin ||
      (existing.accountId &&
        (existing.protocol === "anthropic-messages") !==
          (input.connection.protocol === "anthropic-messages")))
  )
    return yield* failure(
      existing.accountId
        ? "Choose a saved key for the new endpoint."
        : "Re-enter the API key when changing the endpoint host.",
    );
  return { existing, key, attachedToDroid };
});

/** Snapshot the selected secret under the write lock; discovery itself happens outside it. */
export const prepareCustomModelSave = Effect.fn("CustomModels.prepareSave")(function* (
  current: ServerSettings,
  input: CustomModelSaveInput,
  secrets: ServerSecretStore["Service"],
  resolveAccount?: CustomModelAccountResolver,
) {
  const { existing, key, attachedToDroid } = yield* validateCustomModelSave(current, input);
  const credentialId = input.removeKey || input.accountId ? null : (existing?.credentialId ?? null);
  const retained = !input.removeKey && !input.accountId && key === undefined ? existing : undefined;
  const accountId = input.accountId ?? retained?.accountId;
  const resolved = retained
    ? yield* resolveCustomModelKey(retained, secrets, resolveAccount)
    : { apiKey: key === undefined ? null : Redacted.make(key) };
  // A broken key must not prevent editing or detaching models. Do not use an
  // unauthenticated network lookup as a substitute for that credential.
  const connection: ResolvedModelConnection = {
    ...input.connection,
    credentialId,
    ...(accountId ? { accountId } : {}),
    ...(resolved.credentialError
      ? { credentialError: "Saved API key is unavailable. Re-enter or remove it." }
      : resolved),
  };
  return {
    connection,
    attachedToDroid,
    previous:
      key === undefined &&
      !input.removeKey &&
      !input.accountId &&
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
      : input.removeKey || input.accountId
        ? null
        : (existing?.credentialId ?? null);
  const connection: CustomModelConnection = {
    ...input.connection,
    models: input.connection.models.map(({ reasoningMetadata: _derived, ...model }) => ({
      ...model,
      ...(metadata.has(model.id) ? { reasoningMetadata: metadata.get(model.id)! } : {}),
    })),
    credentialId,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(!input.accountId && key === undefined && !input.removeKey && existing?.accountId
      ? {
          accountId: existing.accountId,
          ...(existing.accountKeyVersion ? { accountKeyVersion: existing.accountKeyVersion } : {}),
        }
      : {}),
    apiKeySuffix:
      key !== undefined
        ? keySuffix(key)
        : input.removeKey || input.accountId
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
  resolveAccount?: CustomModelAccountResolver,
): Effect.fn.Return<ReadonlyArray<ResolvedModelConnection>, CustomModelError> {
  const connections: ResolvedModelConnection[] = [];
  for (const connection of settings.connections) {
    const models = connection.models.filter((model) => model.instanceIds.includes(instanceId));
    if (!models.length) continue;
    // SCIENT-FORK:START — Scient Accounts: share the owning key resolver with linked accounts.
    const resolved = yield* resolveCustomModelKey(connection, secrets, resolveAccount);
    connections.push({ ...connection, models, ...resolved });
    // SCIENT-FORK:END
  }
  return connections;
});

// SCIENT-FORK:START — Scient Accounts: linked keys use Custom models' validation and storage owner.
export const resolveCustomModelKey = Effect.fn("CustomModels.resolveKey")(function* (
  connection: CustomModelConnection,
  secrets: ServerSecretStore["Service"],
  resolveAccount?: CustomModelAccountResolver,
) {
  if (connection.accountId) {
    const result =
      resolveAccount && URL.canParse(connection.baseUrl)
        ? yield* resolveAccount(
            connection.accountId,
            new URL(connection.baseUrl).origin,
            connection.protocol,
          ).pipe(Effect.option)
        : Option.none();
    return Option.isSome(result)
      ? { apiKey: result.value.token }
      : { credentialError: `Choose a saved API key for ${connection.name} in Custom models.` };
  }
  const stored = yield* (
    connection.credentialId
      ? secrets.get(customModelSecretName(connection.credentialId))
      : Effect.succeed(Option.none<Uint8Array>())
  ).pipe(Effect.result);
  const usable =
    stored._tag === "Success" && Option.isSome(stored.success)
      ? usableStoredKey(stored.success.value)
      : undefined;
  if (
    stored._tag === "Failure" ||
    (connection.credentialId && Option.isNone(stored.success)) ||
    (Option.isSome(stored.success) && usable === undefined)
  ) {
    return { credentialError: `Re-enter the API key for ${connection.name} in Custom models.` };
  }
  return { apiKey: usable === undefined ? null : Redacted.make(usable) };
});
// SCIENT-FORK:END
