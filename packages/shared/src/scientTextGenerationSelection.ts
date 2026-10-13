import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  isProviderDriverKind,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";

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
  "scient",
].map((driver) => ProviderDriverKind.make(driver));

/** Shipped Scient writer policy; the caller supplies environment or project enablement. */
export function fallbackScientTextGenerationModelSelection(
  providerInstances: ServerSettings["providerInstances"],
  isEnabled: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => boolean,
): ModelSelection | null {
  const builtIns = TEXT_GENERATION_FALLBACK_DRIVERS.map(
    (driver) => [defaultInstanceIdForDriver(driver), driver] as const,
  );
  const driverOrder = new Map(
    TEXT_GENERATION_FALLBACK_DRIVERS.map((driver, index) => [driver, index]),
  );
  const named = Object.entries(providerInstances)
    .filter(
      ([instanceId, instance]) =>
        instanceId !== defaultInstanceIdForDriver(instance.driver) &&
        isProviderDriverKind(instance.driver) &&
        driverOrder.has(instance.driver),
    )
    .sort(
      ([leftId, left], [rightId, right]) =>
        driverOrder.get(left.driver)! - driverOrder.get(right.driver)! ||
        (leftId < rightId ? -1 : leftId > rightId ? 1 : 0),
    )
    .map(
      ([instanceId, instance]) => [ProviderInstanceId.make(instanceId), instance.driver] as const,
    );
  // Default-on Scient Agent remains the last resort after intentional named setups.
  const match = [
    ...builtIns.filter(([, driver]) => driver !== "scient"),
    ...named,
    ...builtIns.filter(([, driver]) => driver === "scient"),
  ].find(([instanceId, driver]) => isEnabled(instanceId, driver));
  if (match === undefined) return null;
  const [instanceId, driver] = match;
  return {
    instanceId,
    model:
      DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_TEXT_GENERATION_MODEL,
  };
}
