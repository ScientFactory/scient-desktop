import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { CustomModelSettingsMethods } from "../../scientServerSettings.ts";

/** Synthetic catalogs for native wire fixtures; lifecycle tests supply a real change stream. */
export function piModelSettings(
  source: Pick<CustomModelSettingsMethods, "resolveCustomModels">,
  instanceId: Parameters<typeof source.resolveCustomModels>[0],
) {
  return {
    ...source,
    getSettings: source.resolveCustomModels(instanceId).pipe(
      Effect.map((connections) => ({
        ...DEFAULT_SERVER_SETTINGS,
        customModels: { revision: 0, connections },
      })),
      Effect.orDie,
    ),
    subscribeChanges: Effect.succeed(Stream.never),
  };
}
