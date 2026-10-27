import type { ProviderInstanceId } from "@t3tools/contracts";
import type { McpPluginKeyPolicy } from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ProviderRegistryShape } from "../../provider/ProviderRegistry.ts";
import { readLocalPluginContents } from "./LocalPluginContents.ts";

const decodePath = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String }));
export const preparePluginKeyStartup = Effect.fn("PluginKeyStartup.prepare")(function* (
  providers: ProviderRegistryShape,
  instanceId: ProviderInstanceId,
  cwd: string | undefined,
) {
  const provider = (yield* providers.getProviders).find((item) => item.instanceId === instanceId);
  if (!provider || (provider.driver !== "claudeAgent" && provider.driver !== "codex")) return [];
  const actions = yield* providers.getProviderPluginActionsForInstance(instanceId);
  if (!actions || (yield* actions.isRetired)) return [];
  const listing = yield* actions.listPlugins(cwd ? { cwd } : {});
  const policies: McpPluginKeyPolicy[] = [];
  for (const plugin of listing.plugins.filter((plugin) => plugin.enabled)) {
    const parsed = decodePath(plugin);
    const path = parsed._tag === "Some" ? parsed.value.path : undefined;
    const contents =
      provider.driver === "codex"
        ? yield* actions.store?.contents?.(plugin.id) ?? Effect.void
        : path
          ? yield* Effect.tryPromise(() => readLocalPluginContents(path))
          : undefined;
    if (!contents?.requiredKeys?.length) continue;
    policies.push({
      pluginId: plugin.name,
      pluginName: plugin.name.split("@")[0]!,
      ...(path ? { path } : {}),
      serverNames: contents.mcpServers.map((server) => server.name),
    });
  }
  return policies;
}, Effect.orDie);
