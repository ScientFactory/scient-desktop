import {
  DEFAULT_SERVER_SETTINGS,
  defaultInstanceIdForDriver,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

function withoutLegacyEnabled(config: unknown): unknown {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return config;
  const { enabled: _legacyEnabled, ...rest } = config as Record<string, unknown>;
  return rest;
}

/**
 * Build the one settings write needed to enable an existing provider.
 *
 * The envelope is canonical. Legacy in-config `enabled` is removed so an old
 * `false` cannot continue to override the user's explicit enable action.
 * Default providers are promoted exactly as the Settings editor promotes
 * them; custom instances must already have a persisted envelope.
 */
export function buildEnableProviderPatch(
  settings: Pick<ServerSettings, "providers" | "providerInstances">,
  provider: Pick<ServerProvider, "driver" | "instanceId">,
): ServerSettingsPatch | null {
  const existing = settings.providerInstances[provider.instanceId];
  const isDefault = provider.instanceId === defaultInstanceIdForDriver(provider.driver);
  const legacyProviders = settings.providers as Record<string, unknown>;
  const legacyDefaults = DEFAULT_SERVER_SETTINGS.providers as Record<string, unknown>;
  const legacyConfig = isDefault ? legacyProviders[provider.driver] : undefined;

  if (!existing && legacyConfig === undefined) return null;

  const source = existing ?? {
    driver: provider.driver,
    config: legacyConfig,
  };
  const cleanConfig = withoutLegacyEnabled(source.config);
  const enabledInstance: ProviderInstanceConfig = {
    ...source,
    enabled: true,
    ...(cleanConfig === undefined ? {} : { config: cleanConfig }),
  };

  return {
    ...(isDefault && legacyDefaults[provider.driver] !== undefined
      ? {
          providers: {
            ...settings.providers,
            [provider.driver]: legacyDefaults[provider.driver],
          } as ServerSettings["providers"],
        }
      : {}),
    providerInstances: {
      ...settings.providerInstances,
      [provider.instanceId]: enabledInstance,
    },
  };
}
