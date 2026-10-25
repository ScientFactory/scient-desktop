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
 * Remove legacy in-config enabled when explicitly enabling, or an old false overrides the canonical
 * envelope. Promote defaults as Settings does; custom instances require existing persisted
 * envelopes.
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
