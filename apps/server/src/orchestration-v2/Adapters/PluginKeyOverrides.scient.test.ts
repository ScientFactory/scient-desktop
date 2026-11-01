import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { claudeMcpQueryOverrides } from "./ClaudeAdapterV2.ts";
import { codexThreadRuntimeParams } from "./CodexAdapterV2.ts";
const alias = "pkey-synthetic";
const session = {
  environmentId: EnvironmentId.make("synthetic"),
  threadId: ThreadId.make("synthetic-thread"),
  providerSessionId: "synthetic-session",
  providerInstanceId: ProviderInstanceId.make("synthetic-agent"),
  endpoint: "https://scient.example/mcp",
  authorizationHeader: "Bearer synthetic-session-bearer",
  capabilities: new Set<string>(),
  connectors: [
    {
      connectorId: "con_synthetic01",
      serverName: alias,
      displayName: "sample: api",
      url: "https://scient.example/mcp/connectors/con_synthetic01",
    },
  ],
  pluginKeyPolicies: [
    {
      pluginId: "sample@synthetic",
      bindingPluginId: "native-plugin-id",
      requiredKeys: ["TOKEN"],
      pluginName: "sample",
      path: "/synthetic/plugin",
      serverNames: ["api.v1"],
    },
  ],
};
it("registers the Claude proxy under the original scoped plugin server name", () => {
  const result = claudeMcpQueryOverrides({
    mcpSession: { ...session, pluginKeyServerNames: { [alias]: "plugin:sample:api" } },
    readOnlySandbox: false,
  });
  expect(Object.keys(result.mcpServers ?? {})).toEqual(["scient", "plugin:sample:api"]);
  expect(result.mcpServers?.["plugin:sample:api"]).toMatchObject({
    type: "http",
    url: session.connectors[0]!.url,
  });
});
it("keeps Codex's original server key while disabling its native plugin transport", () => {
  const result = codexThreadRuntimeParams({
    mcpSession: { ...session, pluginKeyServerNames: { [alias]: "api.v1" } },
  });
  expect(result.config['plugins."sample@synthetic".mcp_servers."api.v1".enabled']).toBe(false);
  expect(result.config['mcp_servers."api.v1"']).toEqual({
    url: session.connectors[0]!.url,
    http_headers: { Authorization: session.authorizationHeader },
  });
  expect(result.config[`mcp_servers.${alias}`]).toBeUndefined();
});

it("delivers only launcher paths for Claude and Codex stdio replacements", () => {
  const launcher = {
    serverName: "plugin:sample:api",
    command: "/synthetic/node",
    args: ["/private/synthetic/launcher.mjs", "/private/synthetic/env.json"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
  const mcpSession = { ...session, connectors: [], pluginKeyStdioServers: [launcher] };
  const claude = claudeMcpQueryOverrides({ mcpSession, readOnlySandbox: false });
  expect(claude.mcpServers?.[launcher.serverName]).toEqual({
    type: "stdio",
    command: launcher.command,
    args: launcher.args,
    env: launcher.env,
  });
  const codex = codexThreadRuntimeParams({
    mcpSession: { ...mcpSession, pluginKeyStdioServers: [{ ...launcher, serverName: "api.v1" }] },
  });
  expect(codex.config['mcp_servers."api.v1"']).toEqual({
    command: launcher.command,
    args: launcher.args,
    env: launcher.env,
  });
  expect(codex.config['plugins."sample@synthetic".mcp_servers."api.v1".enabled']).toBe(false);
});
