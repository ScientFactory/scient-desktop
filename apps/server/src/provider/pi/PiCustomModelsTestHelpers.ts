import { DEFAULT_SERVER_SETTINGS, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ServerSettingsService } from "../../serverSettings.ts";
import { customModelMethods } from "../../scientServerSettings.ts";

/** Synthetic catalogs for native wire fixtures; lifecycle tests supply a real change stream. */
export function piModelSettings(
  source: Pick<ServerSettingsService["Service"], "resolveCustomModels">,
  instanceId: ProviderInstanceId,
) {
  return {
    ...source,
    getSettings: customModelMethods(source)
      .resolveCustomModels(instanceId)
      .pipe(
        Effect.map((connections) => ({
          ...DEFAULT_SERVER_SETTINGS,
          customModels: { revision: 0, connections },
        })),
        Effect.orDie,
      ),
    subscribeChanges: Effect.succeed(Stream.never),
  };
}
