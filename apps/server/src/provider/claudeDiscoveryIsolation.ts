// FILE: claudeDiscoveryIsolation.ts
// Purpose: Keep passive Claude capability discovery from starting user-configured MCP servers.
// Layer: Provider utility.

import type { Options as ClaudeQueryOptions, SettingSource } from "@anthropic-ai/claude-agent-sdk";

const CLAUDE_DISCOVERY_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

/**
 * Applies the non-interactive safety boundary shared by temporary Claude
 * discovery processes. Filesystem settings remain available for command and
 * model metadata, but their MCP declarations (including Claude.ai connectors)
 * cannot start. Interactive Claude sessions must not use this helper.
 */
export function buildIsolatedClaudeDiscoveryOptions(
  options: ClaudeQueryOptions & { readonly env: NodeJS.ProcessEnv },
): ClaudeQueryOptions {
  const safeOptions = { ...options };

  // strictMcpConfig blocks MCP declarations loaded from settings, but the SDK
  // still accepts MCP-capable agent definitions and arbitrary raw CLI flags.
  // Temporary discovery has no need for either, so remove both escape hatches
  // even if a future caller passes them accidentally.
  delete safeOptions.agent;
  delete safeOptions.agents;
  delete safeOptions.extraArgs;

  return {
    ...safeOptions,
    env: {
      ...options.env,
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    },
    settingSources: [...CLAUDE_DISCOVERY_SETTING_SOURCES],
    persistSession: false,
    mcpServers: {},
    strictMcpConfig: true,
  };
}
