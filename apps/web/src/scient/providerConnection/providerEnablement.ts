import {
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

/** Apply one enabled value without leaving a contradictory legacy flag. */
export function withProviderInstanceEnabled(
  instance: ProviderInstanceConfig,
  enabled: boolean,
): ProviderInstanceConfig {
  if (!enabled) return { ...instance, enabled: false };
  const cleanConfig = withoutLegacyEnabled(instance.config);
  return {
    ...instance,
    enabled: true,
    ...(cleanConfig === undefined ? {} : { config: cleanConfig }),
  };
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
  settings: Pick<ServerSettings, "providerInstances">,
  provider: Pick<ServerProvider, "driver" | "instanceId">,
): ServerSettingsPatch | null {
  const existing = settings.providerInstances[provider.instanceId];
  const isDefault = provider.instanceId === defaultInstanceIdForDriver(provider.driver);

  if (!existing && !isDefault) return null;

  const source = existing ?? { driver: provider.driver };
  const enabledInstance = withProviderInstanceEnabled(source, true);

  return {
    providerInstances: {
      ...settings.providerInstances,
      [provider.instanceId]: enabledInstance,
    },
  };
}
