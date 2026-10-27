import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { McpPluginKeyPolicy } from "@t3tools/provider-core/server/mcpSession";

export function claudePluginKeyOptions<T extends Options>(
  options: T,
  policies: ReadonlyArray<McpPluginKeyPolicy> = [],
) {
  if (!policies.length) return options;
  if (typeof options.settings === "string")
    throw new Error("Plugin key suppression requires inline Claude SDK settings.");
  return {
    ...options,
    settings: {
      ...options.settings,
      enabledPlugins: {
        ...options.settings?.enabledPlugins,
        ...Object.fromEntries(policies.map((plugin) => [plugin.pluginId, false])),
      },
    },
    plugins: [
      ...(options.plugins ?? []).filter(
        (plugin) => !policies.some((policy) => policy.path === plugin.path),
      ),
      ...policies.flatMap((plugin) =>
        plugin.path ? [{ type: "local" as const, path: plugin.path, skipMcpDiscovery: true }] : [],
      ),
    ],
  };
}

export function codexPluginKeyConfig(policies: ReadonlyArray<McpPluginKeyPolicy> = []) {
  return Object.fromEntries(
    policies.flatMap((plugin) =>
      plugin.serverNames.map((server) => [
        `plugins.${JSON.stringify(plugin.pluginId)}.mcp_servers.${JSON.stringify(server)}.enabled`,
        false,
      ]),
    ),
  );
}
