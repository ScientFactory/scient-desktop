/**
 * Provider-facing config builders for the Synara agent gateway.
 *
 * One shared module shapes the same MCP connection (endpoint URL + per-thread
 * bearer token) into every provider's native MCP configuration format so the
 * injection rules cannot drift between adapters. This slice ships the two
 * lowest-secret-exposure transports:
 *
 * - Claude Agent SDK: `mcpServers` record with an HTTP entry (bearer token in
 *   an `Authorization` header; never in the process env).
 * - Codex: `[mcp_servers.synara]` TOML block (streamable HTTP +
 *   `bearer_token_env_var` resolved from the per-session process env, with a
 *   `shell_environment_policy` exclude so exec subprocesses cannot inherit it).
 *
 * ACP/OpenCode transports return in later slices as those injection seams land.
 *
 * @module agentGateway/mcpInjection
 */
import type { AgentGatewayMcpConnection } from "./Services/AgentGatewayCredentials.ts";

export const SYNARA_MCP_SERVER_NAME = "synara";
export const SYNARA_AGENT_GATEWAY_TOKEN_ENV = "SYNARA_AGENT_GATEWAY_TOKEN";
export const SYNARA_AGENT_GATEWAY_URL_ENV = "SYNARA_AGENT_GATEWAY_URL";

/**
 * Codex reads MCP servers from `config.toml`; the config file is shared by all
 * sessions of one Codex home, so the token is never written into it. Instead
 * the block references an env var that Synara sets per app-server process.
 *
 * The shell_environment_policy table keeps that env var out of exec tool
 * subprocesses: codex defaults to `ignore_default_excludes = true`, so the
 * built-in *TOKEN* filter is inactive and workspace commands would otherwise
 * inherit the gateway bearer token. Appended per-table, so a user-defined
 * policy table is never duplicated (their policy then governs).
 */
export function buildCodexMcpConfigToml(endpointUrl: string): string {
  return [
    `[mcp_servers.${SYNARA_MCP_SERVER_NAME}]`,
    `url = ${JSON.stringify(endpointUrl)}`,
    `bearer_token_env_var = ${JSON.stringify(SYNARA_AGENT_GATEWAY_TOKEN_ENV)}`,
    "",
    "[shell_environment_policy]",
    `exclude = [${JSON.stringify(SYNARA_AGENT_GATEWAY_TOKEN_ENV)}]`,
  ].join("\n");
}

export interface ClaudeMcpHttpServerConfig {
  readonly type: "http";
  readonly url: string;
  readonly headers: Record<string, string>;
}

export function buildClaudeMcpServers(
  connection: AgentGatewayMcpConnection,
): Record<string, ClaudeMcpHttpServerConfig> {
  return {
    [SYNARA_MCP_SERVER_NAME]: {
      type: "http",
      url: connection.url,
      headers: { Authorization: `Bearer ${connection.bearerToken}` },
    },
  };
}
