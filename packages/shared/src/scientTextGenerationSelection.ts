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
import { readCustomModelEntries } from "./model.ts";

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

/**
 * Use a selected instance's custom thread default when available: its backend may reject built-in
 * defaults. Match instance ID, never driver alone, so another account cannot borrow model/options
 * authority.
 */
export function fallbackScientTextGenerationModelSelection(
  providerInstances: ServerSettings["providerInstances"],
  isEnabled: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => boolean,
  options?: { readonly defaultModelSelection?: ModelSelection | null },
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
  const threadDefault = options?.defaultModelSelection;
  const config = providerInstances[instanceId]?.config;
  const customModels =
    typeof config === "object" && config !== null && "customModels" in config
      ? config.customModels
      : undefined;
  if (
    threadDefault?.instanceId === instanceId &&
    readCustomModelEntries(customModels).some((entry) => entry.slug === threadDefault.model)
  ) {
    return threadDefault;
  }
  return {
    instanceId,
    model:
      DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_TEXT_GENERATION_MODEL,
  };
}
