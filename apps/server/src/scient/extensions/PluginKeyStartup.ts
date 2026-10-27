import type { PluginKeyTarget, ProviderInstanceId } from "@t3tools/contracts";
import type { McpPluginKeyPolicy } from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ProviderRegistryShape } from "../../provider/ProviderRegistry.ts";
import { pluginKeyHttpOrigins } from "./PluginKeyHttpServers.ts";
import { readLocalPluginContents, readLocalPluginKeyHttpServers } from "./LocalPluginContents.ts";

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
    const listedPath = parsed._tag === "Some" ? parsed.value.path : undefined;
    const contents =
      provider.driver === "codex"
        ? yield* actions.store?.contents?.(plugin.id) ?? Effect.void
        : listedPath
          ? yield* Effect.tryPromise(() => readLocalPluginContents(listedPath))
          : undefined;
    if (!contents?.requiredKeys?.length) continue;
    let path = listedPath;
    if (!path && provider.driver === "codex" && actions.store?.keyServerRoot)
      path = yield* actions.store.keyServerRoot(plugin.id);
    policies.push({
      pluginId: provider.driver === "codex" ? plugin.id : plugin.name,
      bindingPluginId: plugin.id,
      requiredKeys: contents.requiredKeys,
      pluginName: plugin.name.split("@")[0]!,
      ...(path ? { path } : {}),
      serverNames: contents.mcpServers.map((server) => server.name),
    });
  }
  return policies;
}, Effect.orDie);

export const readPluginKeyOrigins = Effect.fn("PluginKeyStartup.readOrigins")(function* (
  providers: ProviderRegistryShape,
  target: PluginKeyTarget,
) {
  if (!target.agent) return new Map<string, string[]>();
  const actions = yield* providers.getProviderPluginActionsForInstance(target.agent);
  if (!actions || (yield* actions.isRetired)) return new Map<string, string[]>();
  const plugin = (yield* actions.listPlugins(target.cwd ? { cwd: target.cwd } : {})).plugins.find(
    (plugin) => plugin.id === target.pluginId,
  );
  if (!plugin) return new Map<string, string[]>();
  const parsed = decodePath(plugin);
  const root =
    parsed._tag === "Some"
      ? parsed.value.path
      : yield* actions.store?.keyServerRoot?.(plugin.id) ?? Effect.void;
  return root
    ? pluginKeyHttpOrigins(yield* Effect.tryPromise(() => readLocalPluginKeyHttpServers(root)))
    : new Map<string, string[]>();
});
