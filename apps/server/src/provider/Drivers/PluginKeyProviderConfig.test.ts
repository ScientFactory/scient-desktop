import { expect, it } from "@effect/vitest";
import { claudePluginKeyOptions, codexPluginKeyConfig } from "./PluginKeyProviderConfig.ts";
const policies = [
  {
    pluginId: "sample@synthetic",
    pluginName: "sample",
    path: "/synthetic/plugin",
    serverNames: ["api", "local"],
  },
];
it("suppresses Claude's original plugin MCP discovery before loading its remaining components", () => {
  const result = claudePluginKeyOptions(
    {
      settings: { enabledPlugins: { "unrelated@synthetic": true } },
      plugins: [{ type: "local", path: "/synthetic/unrelated" }],
    },
    policies,
  );
  expect(result.settings).toEqual({
    enabledPlugins: { "unrelated@synthetic": true, "sample@synthetic": false },
  });
  expect(result.plugins).toEqual([
    { type: "local", path: "/synthetic/unrelated" },
    { type: "local", path: "/synthetic/plugin", skipMcpDiscovery: true },
  ]);
  expect(result).not.toHaveProperty("env");
  expect(result).not.toHaveProperty("mcpServers");
  expect(() => claudePluginKeyOptions({ settings: "/synthetic/settings.json" }, policies)).toThrow(
    "inline",
  );
});
it("disables only the plugin's Codex servers and quotes dotted native names", () => {
  expect(
    codexPluginKeyConfig([
      { ...policies[0]!, pluginId: "vendor.sample@synthetic", serverNames: ["api.v1"] },
    ]),
  ).toEqual({
    'plugins."vendor.sample@synthetic".mcp_servers."api.v1".enabled': false,
  });
  expect(codexPluginKeyConfig()).toEqual({});
});
