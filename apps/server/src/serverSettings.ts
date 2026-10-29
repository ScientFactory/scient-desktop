/** External settings edits require scoped directory watches and serialized persistence.
 * @module ServerSettings
 */
import {
  DEFAULT_SERVER_SETTINGS,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProjectSettingsOverrides,
  type ProviderInstanceConfig,
  type ProviderInstanceMutation,
  defaultInstanceIdForDriver,
  isProviderDriverKind,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ResponseStreamingMode,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
  globalIdleCompaction,
  withIdleCompaction,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
// SCIENT-FORK:START — scoped native hints and authoritative settings metadata fallback.
import {
  SettingsDirectoryWatch,
  SettingsFileMetadata,
  acquireSettingsMetadataChanges,
} from "./settingsDirectoryWatch.ts";
// SCIENT-FORK:END
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import * as ServerConfig from "./config.ts";
import { type DeepPartial, deepMerge } from "@t3tools/shared/Struct";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  applyServerSettingsPatch,
  deriveLegacyProjectOverrides,
  isModelSelectionProviderEnabled,
} from "@t3tools/shared/serverSettings";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
// SCIENT-FORK:START
import { applyThreadSectionsPrecondition } from "./scient/threadSections/settingsPrecondition.ts";
// SCIENT-FORK:END
import {
  CODEX_SUBSCRIPTION_SHARING_UNAVAILABLE,
  newlyRequestedCodexSubscriptionSharing,
} from "./scient/providerLifecycle/codexSubscriptionSharingPolicy.ts";
import { makeCustomModelReasoning } from "./customModelReasoning.ts";
// SCIENT-FORK:START — Scient Accounts: encrypt only Custom models credentials through the shared vault.
import {
  AccountsSecretStore,
  layer as accountsSecretStoreLayer,
} from "./scient/accounts/AccountsSecretStore.ts";
// SCIENT-FORK:END
import { withCustomModelKeyHints } from "./customModels.ts";
// SCIENT-FORK:START — custom-model methods and text-generation fallback
import {
  customModelsTestMethods,
  fallbackTextGenerationProvider,
  makeCustomModelSettingsMethods,
  type CustomModelSettingsMethods,
} from "./scientServerSettings.ts";
// SCIENT-FORK:END
import {
  readSecretFieldValues,
  sourceControlHostSecretName,
} from "./sourceControl/sourceControlHostSecrets.ts";

import { mapSettingsSecrets, SECRET_REDACTED, type SettingsSecret } from "./settingsSecrets.ts";

export {
  resolveReviewGuideModelSelection,
  resolveSourceControlWriterModelSelection,
} from "@t3tools/shared/serverSettings";

const encodeServerSettings = Schema.encodeEffect(ServerSettings);
const encodeServerSettingsJson = Schema.encodeUnknownEffect(fromJsonStringPretty(ServerSettings));
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Conflicting flags resolve to false to preserve user disables.
const foldProviderInstanceEnabledFlags = (settings: ServerSettings): ServerSettings => {
  let changed = false;
  const providerInstances: Record<string, ProviderInstanceConfig> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    const config = instance.config;
    // Leave malformed flags for driver schema validation rather than silently repairing them.
    if (
      config === null ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      typeof (config as { readonly enabled?: unknown }).enabled !== "boolean"
    ) {
      providerInstances[instanceId] = instance;
      continue;
    }
    const { enabled: configEnabled, ...restConfig } = config as Record<string, unknown> & {
      readonly enabled: boolean;
    };
    const resolved =
      instance.enabled === false || configEnabled === false
        ? false
        : (instance.enabled ?? configEnabled);
    changed = true;
    providerInstances[instanceId] = {
      ...instance,
      enabled: resolved,
      config: restConfig,
    } satisfies ProviderInstanceConfig;
  }
  if (!changed) {
    return settings;
  }
  return {
    ...settings,
    providerInstances: providerInstances as ServerSettings["providerInstances"],
  };
};

const normalizeServerSettings = (
  settings: ServerSettings,
): Effect.Effect<ServerSettings, ServerSettingsError> =>
  encodeServerSettings(settings).pipe(
    Effect.flatMap(decodeServerSettings),
    Effect.map(foldProviderInstanceEnabledFlags),
    Effect.map((next) => withIdleCompaction(next, globalIdleCompaction(next))),
    Effect.map((next) => ({ ...next, ...deriveLegacyProjectOverrides(next) })),
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath: "<memory>",
          operation: "normalize",
          cause,
        }),
    ),
  );

export function redactServerSettingsForClient(settings: ServerSettings): ServerSettings {
  return mapSettingsSecrets(settings, (secret) =>
    secret.sensitive
      ? { value: "", redacted: secret.redacted || secret.value.length > 0 }
      : { value: secret.value, redacted: false },
  );
}

export function applyProviderInstanceMutation(
  settings: ServerSettings,
  mutation: ProviderInstanceMutation,
): ServerSettings {
  const providerInstances = { ...settings.providerInstances };
  if (mutation.operation === "upsert" || mutation.operation === "create") {
    providerInstances[mutation.instanceId] = mutation.instance;
  } else {
    delete providerInstances[mutation.instanceId];
  }
  return { ...settings, providerInstances };
}

function ensureProviderInstanceMutationAllowed(
  settings: ServerSettings,
  mutation: ProviderInstanceMutation,
  settingsPath: string,
): Effect.Effect<void, ServerSettingsError> {
  if (
    mutation.operation === "create" &&
    settings.providerInstances[mutation.instanceId] !== undefined
  ) {
    return Effect.fail(
      new ServerSettingsError({
        settingsPath,
        operation: "create-provider-instance",
        providerInstanceId: mutation.instanceId,
      }),
    );
  }
  return Effect.void;
}

// SCIENT-FORK:START — a `null` patch entry keeps keys released clients cannot see; deletion
// removes the whole entry.
function withoutProjectSettingsOverrides(
  settings: ServerSettings,
  projectIds: ReadonlyArray<ProjectId>,
): ServerSettings {
  const projectSettingsOverrides = { ...settings.projectSettingsOverrides };
  for (const projectId of projectIds) delete projectSettingsOverrides[projectId];
  return { ...settings, projectSettingsOverrides };
}
// SCIENT-FORK:END

export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  {
    readonly start: Effect.Effect<void, ServerSettingsError>;

    readonly ready: Effect.Effect<void, ServerSettingsError>;

    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    readonly updateProviderInstance: (
      mutation: ProviderInstanceMutation,
      patch?: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    // SCIENT-FORK:START — provider revocation can read current unresolved settings without trusting an older emission.
    readonly withSettingsSnapshot: <A, E, R>(
      use: (settings: ServerSettings) => Effect.Effect<A, E, R>,
      options?: { readonly allowUnresolvedSecrets?: boolean },
    ) => Effect.Effect<A, E | ServerSettingsError, R>;
    // SCIENT-FORK:END

    // SCIENT-FORK:START — authoritative project deletion. Server-only: no RPC exposes it.
    readonly removeProjectSettingsOverrides: (
      projectIds: ReadonlyArray<ProjectId>,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
    // SCIENT-FORK:END

    readonly streamChanges: Stream.Stream<ServerSettings>;

    /** Subscribe before reading a snapshot to retain changes before lazy stream startup. */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
    // SCIENT-FORK:START — custom-model catalog methods
  } & CustomModelSettingsMethods
  // SCIENT-FORK:END
>()("t3/serverSettings/ServerSettingsService") {
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) => layerTest(overrides);
}

const makeTest = Effect.fn("serverSettings.makeTest")(function* (
  overrides: DeepPartial<ServerSettings> = {},
) {
  const { automaticGitFetchInterval, providerHealthRefreshInterval, ...overridesForMerge } =
    overrides;
  const merged = deepMerge(DEFAULT_SERVER_SETTINGS, overridesForMerge);
  const initialSettings = yield* normalizeServerSettings({
    ...merged,
    ...(automaticGitFetchInterval !== undefined
      ? { automaticGitFetchInterval: automaticGitFetchInterval as Duration.Duration }
      : {}),
    ...(providerHealthRefreshInterval !== undefined
      ? { providerHealthRefreshInterval: providerHealthRefreshInterval as Duration.Duration }
      : {}),
  });
  const currentSettingsRef = yield* Ref.make<ServerSettings>(initialSettings);
  const writeSemaphore = yield* Semaphore.make(1);
  const getSettings = Ref.get(currentSettingsRef).pipe(Effect.map(resolveTextGenerationProvider));

  const updateTestSettings = (
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, ServerSettingsError>,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    writeSemaphore.withPermits(1)(
      Ref.get(currentSettingsRef).pipe(
        Effect.flatMap(update),
        Effect.flatMap(normalizeServerSettings),
        Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
        Effect.map(resolveTextGenerationProvider),
      ),
    );

  return {
    // SCIENT-FORK:START — custom models share the committed settings snapshot.
    ...customModelsTestMethods,
    committedCustomModels: () => Ref.getUnsafe(currentSettingsRef).customModels,
    // SCIENT-FORK:END
    start: Effect.void,
    ready: Effect.void,
    getSettings,
    updateSettings: (patch) =>
      updateTestSettings((currentSettings) =>
        translateLegacyProviderSettingsPatch(currentSettings, patch, "test settings").pipe(
          Effect.map((translatedPatch) =>
            applyServerSettingsPatch(currentSettings, translatedPatch),
          ),
        ),
      ),
    updateProviderInstance: (mutation, patch = {}) =>
      updateTestSettings((currentSettings) =>
        Effect.gen(function* () {
          yield* ensureProviderInstanceMutationAllowed(currentSettings, mutation, "test settings");
          const translatedPatch = yield* translateLegacyProviderSettingsPatch(
            currentSettings,
            patch,
            "test settings",
          );
          const patched = applyServerSettingsPatch(currentSettings, translatedPatch);
          return applyProviderInstanceMutation(patched, mutation);
        }),
      ),
    // SCIENT-FORK:START — authoritative project deletion
    removeProjectSettingsOverrides: (projectIds) =>
      updateTestSettings((currentSettings) =>
        Effect.succeed(withoutProjectSettingsOverrides(currentSettings, projectIds)),
      ),
    // SCIENT-FORK:END
    withSettingsSnapshot: (use) =>
      writeSemaphore.withPermits(1)(getSettings.pipe(Effect.flatMap(use))),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
  } satisfies ServerSettingsService["Service"];
});

export const layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Layer.effect(ServerSettingsService, makeTest(overrides));

// SCIENT-FORK:START — custom-model test members
export { customModelsTestMethods } from "./scientServerSettings.ts";
// SCIENT-FORK:END

// Accept retired token delivery only on load so one old value cannot reset all settings.
const PersistedResponseStreamingMode = Schema.Union([
  ResponseStreamingMode,
  Schema.Literal("token"),
]).pipe(
  Schema.decodeTo(
    ResponseStreamingMode,
    SchemaTransformation.transform({
      decode: (mode) => (mode === "token" ? "paragraph" : mode),
      encode: (mode) => mode,
    }),
  ),
);
const ServerSettingsJson = fromLenientJson(
  Schema.Struct({
    ...ServerSettings.fields,
    responseStreamingMode: PersistedResponseStreamingMode.pipe(
      Schema.withDecodingDefault(Effect.succeed("paragraph" as const)),
    ),
    projectSettingsOverrides: Schema.Record(
      ProjectId,
      Schema.Struct({
        ...ProjectSettingsOverrides.fields,
        responseStreamingMode: Schema.optionalKey(PersistedResponseStreamingMode),
      }),
    ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }),
);
const decodeServerSettingsJsonExit = Schema.decodeUnknownExit(ServerSettingsJson);
const LegacyProviderSettingsJson = fromLenientJson(
  Schema.Struct({
    providers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    bitbucket: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    github: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeLegacyProviderSettingsJsonExit = Schema.decodeUnknownExit(LegacyProviderSettingsJson);
const isLegacyProviderConfig = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const LEGACY_BITBUCKET_SECRET_NAMES: Readonly<Record<string, string>> = {
  accessToken: "bitbucket-access-token",
  apiToken: "bitbucket-api-token",
};
const legacyGitHubTokenSecretName = (host: string) =>
  `github-token-${Buffer.from(host.trim().toLowerCase(), "utf8").toString("base64url")}`;

/**
 * Folds the retired `bitbucket` and `github` keys into `sourceControlHosts`. Current Bitbucket
 * settings and normalized GitHub host/token entries win. Returns adopted secrets to copy.
 */
function migrateLegacySourceControlSettings(
  settings: ServerSettings,
  legacy: {
    readonly bitbucket?: Readonly<Record<string, unknown>> | undefined;
    readonly github?: Readonly<Record<string, unknown>> | undefined;
  },
): {
  readonly settings: ServerSettings;
  readonly secretMoves: ReadonlyArray<{ readonly from: string; readonly to: string }>;
} {
  const sourceControlHosts = { ...settings.sourceControlHosts };
  const secretMoves: Array<{ readonly from: string; readonly to: string }> = [];
  if (legacy.bitbucket !== undefined && sourceControlHosts.bitbucket === undefined) {
    sourceControlHosts.bitbucket = legacy.bitbucket;
    for (const [field, from] of Object.entries(LEGACY_BITBUCKET_SECRET_NAMES)) {
      if (legacy.bitbucket[field] !== SECRET_REDACTED) continue;
      secretMoves.push({
        from,
        to: sourceControlHostSecretName({ kind: "bitbucket", field, serverHost: null }),
      });
    }
  }
  if (legacy.github !== undefined) {
    const currentGitHub = sourceControlHosts.github;
    const github = { ...legacy.github, ...currentGitHub };
    for (const field of ["hosts", "tokens"] as const) {
      const legacyEntries = legacy.github[field];
      const currentEntries = currentGitHub?.[field];
      if (
        !isLegacyProviderConfig(legacyEntries) ||
        (currentEntries !== undefined && !isLegacyProviderConfig(currentEntries))
      ) {
        continue;
      }
      const legacyHosts = Object.fromEntries(
        Object.entries(legacyEntries).map(([host, value]) => [host.trim().toLowerCase(), value]),
      );
      const currentHosts = Object.fromEntries(
        Object.entries(currentEntries ?? {}).map(([host, value]) => [
          host.trim().toLowerCase(),
          value,
        ]),
      );
      github[field] = { ...legacyHosts, ...currentHosts };
      if (field !== "tokens") continue;
      for (const [serverHost, value] of readSecretFieldValues(legacyHosts)) {
        if (
          serverHost === null ||
          Object.hasOwn(currentHosts, serverHost) ||
          value !== SECRET_REDACTED
        ) {
          continue;
        }
        secretMoves.push({
          from: legacyGitHubTokenSecretName(serverHost),
          to: sourceControlHostSecretName({ kind: "github", field: "tokens", serverHost }),
        });
      }
    }
    sourceControlHosts.github = github;
  }
  return { settings: { ...settings, sourceControlHosts }, secretMoves };
}

const HISTORY_RESTORED_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set(
  ["cursor", "droid", "grok", "opencode"].map((driver) => ProviderDriverKind.make(driver)),
);

/** Explicit provider instances win over legacy blobs; drop blobs matching fresh defaults.
 * Retain history opt-in for default-off providers after removing the legacy map.
 * Prior use enables only slots without an explicit flag; explicit disables always win. */
function migrateLegacyProviderSettings(
  settings: ServerSettings,
  legacyProviders: Readonly<Record<string, unknown>>,
  providerHistory: ReadonlyArray<{
    readonly providerName: string;
    readonly providerInstanceId: string | null;
  }>,
): ServerSettings {
  const usedProviders = new Set<string>(providerHistory.map(({ providerName }) => providerName));
  const usedProviderInstances = new Set<string>(
    providerHistory.map(
      ({ providerName, providerInstanceId }) => providerInstanceId ?? providerName,
    ),
  );

  const providerInstances: Record<ProviderInstanceId, ProviderInstanceConfig> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances) as Array<
    [ProviderInstanceId, ProviderInstanceConfig]
  >) {
    providerInstances[instanceId] =
      instance.enabled === undefined &&
      HISTORY_RESTORED_DRIVERS.has(instance.driver) &&
      usedProviderInstances.has(instanceId)
        ? { ...instance, enabled: true }
        : instance;
  }

  // History restores a never-configured default-off slot too.
  const legacyEntries = new Map(Object.entries(legacyProviders));
  for (const driver of HISTORY_RESTORED_DRIVERS) {
    if (!legacyEntries.has(driver)) legacyEntries.set(driver, {});
  }
  for (const [kind, blob] of legacyEntries) {
    if (!isProviderDriverKind(kind) || !isLegacyProviderConfig(blob)) continue;
    const driver = kind;
    const instanceId = defaultInstanceIdForDriver(driver);
    if (Object.hasOwn(providerInstances, instanceId)) continue;

    const { enabled: rawEnabled, ...remainingConfig } = blob as Record<string, unknown>;
    const explicitEnabled = typeof rawEnabled === "boolean" ? rawEnabled : undefined;
    // Preserve malformed legacy values so the provider's own settings schema
    // can reject them. Only a valid boolean is lifted into the instance
    // envelope and removed from the provider config.
    const config =
      explicitEnabled === undefined ? (blob as Record<string, unknown>) : remainingConfig;
    const enabled =
      explicitEnabled ??
      (HISTORY_RESTORED_DRIVERS.has(driver) && usedProviders.has(driver) ? true : undefined);
    const restoreFromHistory = HISTORY_RESTORED_DRIVERS.has(driver) && usedProviders.has(driver);
    const driverDefault = resolveProviderInstanceEnabled({ driver, config: {} });
    if (
      Object.keys(config).length === 0 &&
      (enabled === undefined || enabled === driverDefault) &&
      explicitEnabled !== true &&
      !restoreFromHistory
    ) {
      continue;
    }
    providerInstances[instanceId] = {
      driver,
      ...(enabled === undefined ? {} : { enabled }),
      config,
    } satisfies ProviderInstanceConfig;
  }

  return {
    ...settings,
    providerInstances,
  };
}

const isSettingsRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Translate a pre-provider-instance RPC patch into the driver's canonical
 * default instance. Legacy patches are nested partial updates, so merge only
 * the addressed default config and preserve named instances and envelope
 * metadata. When a modern whole-map patch is also present it is authoritative.
 */
const translateLegacyProviderSettingsPatch = Effect.fn(
  "ServerSettings.translateLegacyProviderSettingsPatch",
)(function* (
  current: ServerSettings,
  rawPatch: ServerSettingsPatch,
  settingsPath: string,
): Effect.fn.Return<ServerSettingsPatch, ServerSettingsError> {
  const legacyProviders = rawPatch.providers;
  if (legacyProviders === undefined) return rawPatch;

  const { providers: _legacyProviders, ...patch } = rawPatch;
  if (patch.providerInstances !== undefined) return patch;

  const providerInstances = { ...current.providerInstances };
  for (const [driverName, legacyConfig] of Object.entries(legacyProviders)) {
    if (!isProviderDriverKind(driverName)) continue;

    const instanceId = defaultInstanceIdForDriver(driverName);
    const existing = providerInstances[instanceId];
    // An instance id can be user-chosen. Do not change the driver identity of
    // an existing non-default instance to satisfy a legacy single-slot write.
    if (existing !== undefined && existing.driver !== driverName) {
      return yield* new ServerSettingsError({
        settingsPath,
        operation: "normalize",
        providerInstanceId: instanceId,
        cause: new Error(
          `Legacy ${driverName} settings cannot update the default instance because ${instanceId} belongs to ${existing.driver}.`,
        ),
      });
    }

    let configPatch = legacyConfig;
    let enabledPatch: boolean | undefined;
    if (isSettingsRecord(legacyConfig)) {
      const { enabled, ...configWithoutEnabled } = legacyConfig;
      if (typeof enabled === "boolean") {
        enabledPatch = enabled;
        configPatch = configWithoutEnabled;
      }
    }

    const config = isSettingsRecord(configPatch)
      ? deepMerge(isSettingsRecord(existing?.config) ? existing.config : {}, configPatch)
      : configPatch;
    providerInstances[instanceId] = {
      ...existing,
      driver: driverName,
      ...(enabledPatch === undefined ? {} : { enabled: enabledPatch }),
      config,
    };
  }

  return { ...patch, providerInstances };
});

const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");

function selectionSupportsTextGeneration(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  return settings.providerInstances[selection.instanceId]?.driver !== ACP_REGISTRY_DRIVER;
}

function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  return isModelSelectionProviderEnabled(settings, settings.textGenerationModelSelection) &&
    selectionSupportsTextGeneration(settings, settings.textGenerationModelSelection)
    ? settings
    : fallbackTextGenerationProvider(settings);
}

const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "backgroundActivity",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "textGenerationModelSelection",
  "fallbackModelSelection",
  "pullRequestMergeMethod",
]);

function stripDefaultServerSettings(current: unknown, defaults: unknown): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (!Equal.equals(currentRecord[key], defaultsRecord[key])) {
          next[key] = currentRecord[key];
        }
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);
        if (stripped !== undefined) {
          next[key] = stripped;
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}

const decodeProjectScriptsJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ProjectScript)),
);
const decodeModelSelectionJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.NullOr(ModelSelection)),
);

interface LegacyProjectSettingsRow {
  readonly projectId: string;
  readonly defaultModelSelection: string | null;
  readonly defaultThreadEnvMode: string | null;
  readonly autoPull: number;
  readonly scripts: string;
}

// projectSettingsFolded prevents restarts from undoing later UI resets.
function foldLegacyProjectSettings(
  settings: ServerSettings,
  rows: ReadonlyArray<LegacyProjectSettingsRow>,
): ServerSettings {
  if (settings.projectSettingsFolded) return settings;
  if (
    rows.length === 0 &&
    Object.keys(settings.projectAgentBrowserAccessOverrides).length === 0 &&
    Object.keys(settings.projectAutoPullOverrides).length === 0 &&
    Object.keys(settings.projectScriptOverrides).length === 0
  ) {
    return settings;
  }
  const entries: Record<string, ProjectSettingsOverrides> = {
    ...settings.projectSettingsOverrides,
  };
  const set = <K extends keyof ProjectSettingsOverrides>(
    projectId: string,
    key: K,
    value: ProjectSettingsOverrides[K] | undefined,
  ) => {
    if (value === undefined) return;
    const entry = entries[projectId] ?? {};
    if (Object.hasOwn(entry, key)) return;
    entries[projectId] = { ...entry, [key]: value };
  };
  for (const [projectId, value] of Object.entries(settings.projectAgentBrowserAccessOverrides)) {
    set(projectId, "enableAgentBrowserAccess", value);
  }
  for (const [projectId, value] of Object.entries(settings.projectAutoPullOverrides)) {
    set(projectId, "defaultAutoPull", value);
  }
  // A stored null resets to machine defaults, so the project's aggregate scripts must not resurface.
  const resetScripts = new Set<string>();
  for (const [projectId, value] of Object.entries(settings.projectScriptOverrides)) {
    if (value === null) resetScripts.add(projectId);
    else set(projectId, "defaultProjectScripts", value);
  }
  for (const row of rows) {
    const model = decodeModelSelectionJson(row.defaultModelSelection ?? "null");
    if (Option.isSome(model) && model.value !== null) {
      set(row.projectId, "defaultModelSelection", model.value);
    }
    if (row.defaultThreadEnvMode === "local" || row.defaultThreadEnvMode === "worktree") {
      set(row.projectId, "defaultThreadEnvMode", row.defaultThreadEnvMode);
    }
    if (row.autoPull === 1) set(row.projectId, "defaultAutoPull", true);
    const scripts = decodeProjectScriptsJson(row.scripts);
    if (Option.isSome(scripts) && scripts.value.length > 0 && !resetScripts.has(row.projectId)) {
      set(row.projectId, "defaultProjectScripts", scripts.value);
    }
  }
  const projectSettingsOverrides = Object.fromEntries(
    Object.entries(entries).filter(([, entry]) => Object.keys(entry).length > 0),
  );
  return {
    ...settings,
    projectSettingsOverrides,
    projectSettingsFolded: true,
    ...deriveLegacyProjectOverrides({ projectSettingsOverrides }),
  };
}

const make = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  // SCIENT-FORK:START — readiness-aware Node settings watcher.
  const directoryWatch = yield* SettingsDirectoryWatch;
  const settingsMetadata = yield* SettingsFileMetadata;
  // SCIENT-FORK:END
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  // SCIENT-FORK:START — Scient Accounts: Custom models alone uses the encrypted secret-store port.
  const customModelSecrets = yield* AccountsSecretStore;
  // SCIENT-FORK:END
  const modelReasoning = makeCustomModelReasoning();
  const sql = yield* SqlClient.SqlClient;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "check-exists",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "read-file",
          cause,
        }),
    ),
  );

  const writeSettingsAtomically = Effect.fnUntraced(
    function* (settings: ServerSettings) {
      const sparseSettingsJson = yield* encodeServerSettingsJson(
        stripDefaultServerSettings(
          settings,
          withIdleCompaction(
            DEFAULT_SERVER_SETTINGS,
            globalIdleCompaction(DEFAULT_SERVER_SETTINGS),
          ),
        ) ?? {},
      );

      return yield* writeFileStringAtomically({
        filePath: settingsPath,
        contents: `${sparseSettingsJson}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
    },
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "write-file",
          cause,
        }),
    ),
  );

  const moveInlineSettingsSecrets = Effect.fn("serverSettings.moveInlineSettingsSecrets")(
    function* (settings: ServerSettings) {
      const pending: SettingsSecret[] = [];
      mapSettingsSecrets(settings, (secret) => {
        if (secret.kind === "field" && !secret.redacted && secret.value.length > 0) {
          pending.push(secret);
        }
        return secret;
      });
      const moved = new Set<string>();
      for (const secret of pending) {
        const stored = yield* secretStore
          .set(secret.secretName, textEncoder.encode(secret.value))
          .pipe(
            Effect.as(true),
            Effect.catch(() =>
              Effect.logWarning("failed to move a settings secret into the secret store").pipe(
                Effect.as(false),
              ),
            ),
          );
        if (stored) moved.add(secret.secretName);
      }
      if (moved.size === 0) return settings;
      return mapSettingsSecrets(settings, (secret) =>
        moved.has(secret.secretName) ? { value: "", redacted: true } : secret,
      );
    },
  );

  const loadSettingsFromDisk = Effect.gen(function* () {
    let settings = DEFAULT_SERVER_SETTINGS;
    let legacyProviders: Readonly<Record<string, unknown>> | undefined;
    let legacySourceControl: Parameters<typeof migrateLegacySourceControlSettings>[1] = {};
    let parseFailure = Option.none<unknown>();
    // SCIENT-FORK:START — malformed legacy blobs must also preserve the original file.
    let settingsFileTrusted = true;
    // SCIENT-FORK:END

    if (yield* readConfigExists) {
      const raw = yield* readRawConfig;
      const decoded = decodeServerSettingsJsonExit(raw);
      const legacySettings = decodeLegacyProviderSettingsJsonExit(raw);
      if (legacySettings._tag === "Success") {
        legacyProviders = legacySettings.value.providers;
        legacySourceControl = {
          bitbucket: legacySettings.value.bitbucket,
          github: legacySettings.value.github,
        };
      }
      if (decoded._tag === "Failure" || legacySettings._tag === "Failure") {
        const failure = decoded._tag === "Failure" ? decoded : legacySettings;
        // The file may hold an opt-out we can no longer read; never resume threads on a guess.
        settings = { ...DEFAULT_SERVER_SETTINGS, continueThreadsAfterServerUpdate: false };
        if (failure._tag === "Failure") {
          parseFailure = Option.some(Cause.squash(failure.cause));
          yield* Effect.logWarning("failed to parse settings.json, using defaults", {
            path: settingsPath,
            issues: Cause.pretty(failure.cause),
            cause: failure.cause,
          });
        }
      } else {
        settings = decoded.value;
      }
      // A valid outer document can still carry an unreadable legacy provider
      // blob. Keep the original file for repair while using its readable settings.
      if (
        legacyProviders !== undefined &&
        Object.entries(legacyProviders).some(
          ([kind, blob]) => isProviderDriverKind(kind) && !isLegacyProviderConfig(blob),
        )
      ) {
        settingsFileTrusted = false;
        yield* Effect.logWarning("malformed legacy provider settings retained for repair", {
          path: settingsPath,
        });
      }
    }
    // Settings saved by a server that kept the mode in `compactIdleThreads` move
    // it to `idleCompaction`, so that switch goes to clients as a boolean. The
    // defaults gain the field too, which tells clients this server reads modes.
    settings = withIdleCompaction(settings, globalIdleCompaction(settings));

    // A file that failed to decode must stay on disk for the user to repair.
    settingsFileTrusted &&= Option.isNone(parseFailure);
    const providerHistory = yield* sql<{
      readonly providerName: string;
      readonly providerInstanceId: string | null;
    }>`
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM projection_thread_sessions
      WHERE provider_name IN ('cursor', 'droid', 'grok', 'opencode')
      UNION
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM provider_session_runtime
      WHERE provider_name IN ('cursor', 'droid', 'grok', 'opencode')
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "read-provider-history",
            cause,
          }),
      ),
    );

    // SCIENT-FORK:START — Scient Accounts: derive Custom models hints after decryption or legacy sealing.
    settings = {
      ...settings,
      customModels: yield* withCustomModelKeyHints(settings.customModels, customModelSecrets),
    };
    // SCIENT-FORK:END
    const legacyProjectRows =
      settings.projectSettingsFolded || !settingsFileTrusted
        ? []
        : yield* sql<LegacyProjectSettingsRow>`
          SELECT
            project_id AS "projectId",
            default_model_selection_json AS "defaultModelSelection",
            default_thread_env_mode AS "defaultThreadEnvMode",
            auto_pull AS "autoPull",
            scripts_json AS "scripts"
          FROM projection_projects
          WHERE deleted_at IS NULL
        `.pipe(
            NodeSqliteClient.readOnly,
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "read-project-settings",
                  cause,
                }),
            ),
          );

    // Preserve the prior runtime behavior where historical use opts a
    // default-off provider instance back in after settings have moved to the
    // provider-instance schema. Explicit disables still take precedence.
    const loaded = foldProviderInstanceEnabledFlags(
      migrateLegacyProviderSettings(settings, legacyProviders ?? {}, providerHistory),
    );
    const folded = settingsFileTrusted
      ? foldLegacyProjectSettings(loaded, legacyProjectRows)
      : loaded;
    // Copy every adopted token before retiring any source. Keep the legacy file until cleanup
    // succeeds so a failed removal or interrupted rewrite retries from the same metadata;
    // sources already removed on a prior attempt leave their copied destinations untouched.
    const legacySecretsCopied = yield* Effect.forEach(
      settingsFileTrusted
        ? migrateLegacySourceControlSettings(folded, legacySourceControl).secretMoves
        : [],
      (move) =>
        secretStore.get(move.from).pipe(
          Effect.flatMap((secret) =>
            Option.isNone(secret) ? Effect.void : secretStore.set(move.to, secret.value),
          ),
          Effect.as(true),
          Effect.catch(() =>
            Effect.logWarning("failed to copy a source control secret to its new name", {
              secretName: move.to,
            }).pipe(Effect.as(false)),
          ),
        ),
    ).pipe(Effect.map((copied) => copied.every(Boolean)));
    if (!legacySecretsCopied) {
      return yield* new ServerSettingsError({
        settingsPath,
        operation: "write-secret",
        cause: new Error(
          "Source control credentials could not be migrated. Retry loading settings.",
        ),
      });
    }
    const hasLegacySourceControl =
      settingsFileTrusted &&
      legacySecretsCopied &&
      (legacySourceControl.bitbucket !== undefined || legacySourceControl.github !== undefined);
    const sourceControlMigration = hasLegacySourceControl
      ? migrateLegacySourceControlSettings(folded, legacySourceControl)
      : { settings: folded, secretMoves: [] };
    const migrated = settingsFileTrusted
      ? yield* moveInlineSettingsSecrets(sourceControlMigration.settings)
      : folded;
    if (
      migrated !== loaded ||
      (settingsFileTrusted && legacyProviders !== undefined) ||
      hasLegacySourceControl
    ) {
      for (const move of sourceControlMigration.secretMoves) {
        yield* secretStore.remove(move.from).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "remove-secret",
                cause,
              }),
          ),
        );
      }
      yield* writeSettingsAtomically(migrated);
    }
    return { settings: migrated, parseFailure };
  });

  // SCIENT-FORK:START — custom models read the same committed snapshot as the settings cache.
  const committedCustomModels = Ref.makeUnsafe(DEFAULT_SERVER_SETTINGS.customModels);
  const loadCommittedSettings = loadSettingsFromDisk.pipe(
    Effect.tap(({ settings }) => Ref.set(committedCustomModels, settings.customModels)),
  );
  // SCIENT-FORK:END
  const settingsCache = yield* Cache.makeWith((_key: typeof cacheKey) => loadCommittedSettings, {
    capacity: 1,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  });

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey).pipe(
    Effect.map((loaded) => loaded.settings),
  );
  const reloadSettings = Cache.invalidate(settingsCache, cacheKey).pipe(
    Effect.andThen(Cache.get(settingsCache, cacheKey)),
  );
  // SCIENT-FORK:START — custom-model mutations commit to the same parsed-cache shape.
  const cacheSettings = (settings: ServerSettings) =>
    Ref.set(committedCustomModels, settings.customModels).pipe(
      Effect.andThen(Cache.set(settingsCache, cacheKey, { settings, parseFailure: Option.none() })),
    );
  // SCIENT-FORK:END

  const materializeSettingsSecrets = Effect.fn("serverSettings.materializeSettingsSecrets")(
    function* (settings: ServerSettings): Effect.fn.Return<ServerSettings, ServerSettingsError> {
      const storedSecrets = new Map<string, string>();
      const pending = new Map<string, SettingsSecret>();
      mapSettingsSecrets(settings, (secret) => {
        if (secret.sensitive && secret.redacted) pending.set(secret.secretName, secret);
        return secret;
      });
      for (const secret of pending.values()) {
        const value = yield* secretStore.get(secret.secretName).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "read-secret",
                providerInstanceId: secret.providerInstanceId,
                environmentVariable: secret.environmentVariable,
                cause,
              }),
          ),
        );
        storedSecrets.set(
          secret.secretName,
          Option.isSome(value) ? textDecoder.decode(value.value) : "",
        );
      }
      return mapSettingsSecrets(settings, (secret) => ({
        value:
          secret.sensitive && secret.redacted
            ? (storedSecrets.get(secret.secretName) ?? "")
            : secret.value,
        redacted: secret.sensitive && secret.kind === "environment" && secret.redacted,
      }));
    },
  );

  const materializeChanges = (changes: Stream.Stream<ServerSettings>) =>
    changes.pipe(
      Stream.mapEffect((settings) =>
        materializeSettingsSecrets(settings).pipe(
          Effect.catch((error: ServerSettingsError) =>
            Effect.logWarning("failed to materialize settings secrets", {
              operation: error.operation,
              providerInstanceId: error.providerInstanceId,
              environmentVariable: error.environmentVariable,
              cause: error.cause,
            }).pipe(Effect.as(settings)),
          ),
        ),
      ),
      Stream.map(resolveTextGenerationProvider),
    );

  type SecretChange = {
    readonly secretName: string;
    readonly providerInstanceId?: string;
    readonly environmentVariable?: string;
  } & (
    | { readonly kind: "write"; readonly value: Uint8Array }
    | { readonly kind: "remove"; readonly operation: "remove-secret" | "remove-stale-secret" }
  );

  const persistSettingsSecrets = (current: ServerSettings, next: ServerSettings) =>
    Effect.sync(() => {
      const previous = new Map<string, SettingsSecret>();
      mapSettingsSecrets(current, (secret) => {
        previous.set(secret.secretName, secret);
        return secret;
      });
      const changes: SecretChange[] = [];
      const nextSecretNames = new Set<string>();
      const settings = mapSettingsSecrets(next, (secret) => {
        const metadata = {
          secretName: secret.secretName,
          ...(secret.providerInstanceId !== undefined
            ? { providerInstanceId: secret.providerInstanceId }
            : {}),
          ...(secret.environmentVariable !== undefined
            ? { environmentVariable: secret.environmentVariable }
            : {}),
        };
        if (!secret.sensitive) {
          changes.push({ ...metadata, kind: "remove", operation: "remove-secret" });
          return { value: secret.value, redacted: false };
        }
        const old = previous.get(secret.secretName);
        const inlineValue =
          old?.sensitive && !old.redacted && old.value.length > 0 ? old.value : undefined;
        const value = secret.redacted ? inlineValue : secret.value;
        if (value === undefined) {
          nextSecretNames.add(secret.secretName);
          return { value: "", redacted: true };
        }
        if (value.length === 0) {
          changes.push({ ...metadata, kind: "remove", operation: "remove-secret" });
          return { value: "", redacted: false };
        }
        nextSecretNames.add(secret.secretName);
        changes.push({ ...metadata, kind: "write", value: textEncoder.encode(value) });
        return { value: "", redacted: true };
      });
      for (const secret of previous.values()) {
        if (!secret.sensitive || nextSecretNames.has(secret.secretName)) continue;
        if (changes.some((change) => change.secretName === secret.secretName)) continue;
        changes.push({
          kind: "remove",
          secretName: secret.secretName,
          operation: "remove-stale-secret",
          ...(secret.providerInstanceId !== undefined
            ? { providerInstanceId: secret.providerInstanceId }
            : {}),
          ...(secret.environmentVariable !== undefined
            ? { environmentVariable: secret.environmentVariable }
            : {}),
        });
      }
      return { settings, changes };
    });

  const rollbackSettingsSecretWrites = (
    writes: ReadonlyArray<{
      readonly secretName: string;
      readonly previousValue: Option.Option<Uint8Array>;
      readonly providerInstanceId?: string;
      readonly environmentVariable?: string;
    }>,
  ) =>
    Effect.forEach(
      writes.toReversed(),
      (write) =>
        (Option.isSome(write.previousValue)
          ? secretStore.set(write.secretName, write.previousValue.value)
          : secretStore.remove(write.secretName)
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to roll back settings secret", {
              providerInstanceId: write.providerInstanceId,
              environmentVariable: write.environmentVariable,
              cause,
            }),
          ),
        ),
      { discard: true },
    );

  const applySettingsSecretChanges = (changes: ReadonlyArray<SecretChange>) => {
    const applied: Array<{
      readonly secretName: string;
      readonly previousValue: Option.Option<Uint8Array>;
      readonly providerInstanceId?: string;
      readonly environmentVariable?: string;
    }> = [];
    const rollback = Effect.suspend(() => rollbackSettingsSecretWrites(applied));
    return Effect.forEach(
      changes,
      (change) =>
        Effect.gen(function* () {
          const previousValue = yield* secretStore.get(change.secretName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "read-secret",
                  providerInstanceId: change.providerInstanceId,
                  environmentVariable: change.environmentVariable,
                  cause,
                }),
            ),
          );
          // A store operation may mutate before reporting an error (for example chmod after rename).
          applied.push({ ...change, previousValue });
          yield* (
            change.kind === "write"
              ? secretStore.set(change.secretName, change.value)
              : secretStore.remove(change.secretName)
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: change.kind === "write" ? "write-secret" : change.operation,
                  providerInstanceId: change.providerInstanceId,
                  environmentVariable: change.environmentVariable,
                  cause,
                }),
            ),
          );
        }),
      { discard: true },
    ).pipe(
      Effect.tapError(() => rollback),
      Effect.as(rollback),
    );
  };

  const updateAndPersistSettings = (
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, ServerSettingsError>,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const { settings: current, parseFailure } = yield* reloadSettings;
        if (Option.isSome(parseFailure)) {
          return yield* new ServerSettingsError({
            settingsPath,
            operation: "read-file",
            cause: parseFailure.value,
          });
        }
        const updated = yield* update(current);
        const deferredInstance = newlyRequestedCodexSubscriptionSharing(current, updated);
        if (deferredInstance !== undefined)
          return yield* new ServerSettingsError({
            settingsPath,
            operation: "normalize",
            providerInstanceId: deferredInstance,
            cause: new Error(CODEX_SUBSCRIPTION_SHARING_UNAVAILABLE),
          });
        const persisted = yield* persistSettingsSecrets(current, updated);
        const next = yield* normalizeServerSettings(persisted.settings);
        const materialized = yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* () {
            const rollbackSecretChanges = yield* applySettingsSecretChanges(persisted.changes);
            const materializedExit = yield* Effect.exit(materializeSettingsSecrets(next));
            if (Exit.isFailure(materializedExit)) {
              yield* rollbackSecretChanges;
              return yield* Effect.failCause(materializedExit.cause);
            }
            const writeExit = yield* Effect.exit(writeSettingsAtomically(next));
            if (Exit.isFailure(writeExit)) {
              yield* rollbackSecretChanges;
              return yield* Effect.failCause(writeExit.cause);
            }
            return materializedExit.value;
          }),
        );
        yield* cacheSettings(next);
        yield* emitChange(next);
        return resolveTextGenerationProvider(materialized);
      }),
    );

  // SCIENT-FORK:START — unresolved credentials stay redacted; ordinary snapshot readers still fail closed.
  const withSettingsSnapshot: ServerSettingsService["Service"]["withSettingsSnapshot"] = (
    use,
    options,
  ) =>
    writeSemaphore.withPermits(1)(
      getSettingsFromCache.pipe(
        Effect.flatMap((settings) =>
          materializeSettingsSecrets(settings).pipe(
            Effect.catchIf(
              (error) =>
                options?.allowUnresolvedSecrets === true && error.operation === "read-secret",
              () => Effect.succeed(settings),
            ),
          ),
        ),
        Effect.map(resolveTextGenerationProvider),
        Effect.flatMap(use),
      ),
    );
  // SCIENT-FORK:END

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const { settings } = yield* reloadSettings;
      yield* emitChange(settings);
    }),
  );

  // SCIENT-FORK:START — buffer native hints; metadata covers asynchronous OS establishment gaps.
  const acquireFileChanges = Effect.fnUntraced(
    function* (filePath: string) {
      const directory = pathService.dirname(filePath);
      const fileName = pathService.basename(filePath);
      const resolvedFilePath = pathService.resolve(filePath);
      const events = yield* directoryWatch.acquire(directory);
      return events.pipe(
        Stream.filter(
          (eventPath) =>
            eventPath === fileName ||
            eventPath === filePath ||
            pathService.resolve(directory, eventPath) === resolvedFilePath,
        ),
      );
    },
    Effect.catch((error) =>
      Effect.logError(error).pipe(
        Effect.as<Stream.Stream<string, PlatformError.PlatformError>>(Stream.empty),
      ),
    ),
  );

  const watchFileChanges = (filePath: string, ready: Deferred.Deferred<void>) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const events = yield* acquireFileChanges(filePath);
        yield* revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));
        yield* Deferred.succeed(ready, undefined);
        return events;
      }),
    );
  // SCIENT-FORK:END

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "prepare-directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));
    // SCIENT-FORK:START — metadata baseline precedes every startup re-read.
    const metadataChanges = yield* acquireSettingsMetadataChanges(
      settingsPath,
      settingsMetadata.readFingerprint,
    );
    // SCIENT-FORK:END

    // Watch symlink targets' directories for rewrites; re-resolve link changes to follow repointing.
    const watchLinkTarget = Effect.gen(function* () {
      const linkTargetPath = yield* resolveSymlinkTarget(settingsPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
      if (linkTargetPath === pathService.resolve(settingsPath)) {
        return Option.none<string>();
      }
      yield* fs
        .makeDirectory(pathService.dirname(linkTargetPath), { recursive: true })
        .pipe(Effect.ignore({ log: true }));
      return Option.some(linkTargetPath);
    }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

    // SCIENT-FORK:START — resolve the initial link only after parent registration.
    const parentWatchScope = yield* Scope.fork(watcherScope, "sequential");
    const settingsFileEvents = yield* Scope.provide(
      acquireFileChanges(settingsPath),
      parentWatchScope,
    );
    const linkEvents = yield* Scope.provide(acquireFileChanges(settingsPath), parentWatchScope);
    const targetWatchReady = yield* Deferred.make<void>();
    // SCIENT-FORK:END
    const initialLinkTarget = yield* watchLinkTarget;
    const linkTargetEvents = Stream.make(initialLinkTarget).pipe(
      Stream.concat(linkEvents.pipe(Stream.mapEffect(() => watchLinkTarget))),
      Stream.changes,
      Stream.switchMap(
        Option.match({
          // SCIENT-FORK:START — re-read only after the new destination is registered.
          onNone: () =>
            Stream.fromEffect(Deferred.succeed(targetWatchReady, undefined)).pipe(Stream.drain),
          onSome: (linkTargetPath) =>
            watchFileChanges(linkTargetPath, targetWatchReady).pipe(Stream.ignore({ log: true })),
          // SCIENT-FORK:END
        }),
      ),
    );

    // Saves emit multiple events; fs.watch may fire before content is flushed.
    // SCIENT-FORK:START — all hints and metadata changes share the existing debounce/read owner.
    const debouncedSettingsEvents = Stream.merge(
      Stream.merge(settingsFileEvents, linkTargetEvents),
      metadataChanges,
    ).pipe(Stream.debounce(Duration.millis(100)));
    // SCIENT-FORK:END

    yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
      // SCIENT-FORK:START — consumer failure stops native hints and metadata; no implicit retry owner.
      Effect.ensuring(
        Scope.close(parentWatchScope, Exit.void).pipe(
          Effect.andThen(Deferred.succeed(targetWatchReady, undefined)),
        ),
      ),
      // SCIENT-FORK:END
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
    // SCIENT-FORK:START — startup refresh follows adapter acquisition; metadata handles OS lag.
    yield* Deferred.await(targetWatchReady);
    // SCIENT-FORK:END
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* reloadSettings;
    });

    // SCIENT-FORK:START — cancelled/failed startup cannot leave registered watches behind.
    const startupExit = yield* Effect.exit(
      startup.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Scope.close(watcherScope, Exit.void).pipe(
                Effect.andThen(Deferred.failCause(startedDeferred, exit.cause)),
              )
            : Effect.void,
        ),
      ),
    );
    // SCIENT-FORK:END
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    // SCIENT-FORK:START — custom-model catalog methods
    ...makeCustomModelSettingsMethods({
      secretStore: customModelSecrets,
      modelReasoning,
      writeSemaphore,
      getSettingsFromCache,
      normalizeServerSettings,
      writeSettingsAtomically,
      cacheSettings,
      emitChange,
      committedCustomModels,
    }),
    // SCIENT-FORK:END
    getSettings: getSettingsFromCache.pipe(
      Effect.flatMap(materializeSettingsSecrets),
      Effect.map(resolveTextGenerationProvider),
    ),
    updateSettings: (patch) =>
      updateAndPersistSettings(
        (current) =>
          // SCIENT-FORK:START — thread-section edits apply only to the catalog they were based on.
          translateLegacyProviderSettingsPatch(
            current,
            applyThreadSectionsPrecondition(current, patch),
            settingsPath,
          ).pipe(
            Effect.map((translatedPatch) => applyServerSettingsPatch(current, translatedPatch)),
          ),
        // SCIENT-FORK:END
      ),
    updateProviderInstance: (mutation, patch = {}) =>
      updateAndPersistSettings((current) =>
        Effect.gen(function* () {
          yield* ensureProviderInstanceMutationAllowed(current, mutation, settingsPath);
          const translatedPatch = yield* translateLegacyProviderSettingsPatch(
            current,
            patch,
            settingsPath,
          );
          const patched = applyServerSettingsPatch(current, translatedPatch);
          return applyProviderInstanceMutation(patched, mutation);
        }),
      ),
    // SCIENT-FORK:START — authoritative project deletion shares the serialized settings writer.
    removeProjectSettingsOverrides: Effect.fn("serverSettings.removeProjectSettingsOverrides")(
      function* (projectIds: ReadonlyArray<ProjectId>) {
        return yield* updateAndPersistSettings((current) =>
          Effect.succeed(withoutProjectSettingsOverrides(current, projectIds)),
        );
      },
    ),
    // SCIENT-FORK:END
    withSettingsSnapshot,
    get streamChanges() {
      return materializeChanges(Stream.fromPubSub(changesPubSub));
    },
    get subscribeChanges() {
      return PubSub.subscribe(changesPubSub).pipe(
        Effect.map((subscription) => materializeChanges(Stream.fromSubscription(subscription))),
      );
    },
  } satisfies ServerSettingsService["Service"];
});

// SCIENT-FORK:START — Scient Accounts: share encrypted Custom models storage without changing other secret-store users.
export const layer = Layer.effect(ServerSettingsService, make).pipe(
  Layer.provide(accountsSecretStoreLayer),
);
// SCIENT-FORK:END
