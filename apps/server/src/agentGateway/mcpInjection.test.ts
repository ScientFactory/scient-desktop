import { describe, expect, it } from "vitest";

import {
  SCIENT_AGENT_GATEWAY_TOKEN_ENV,
  SCIENT_MCP_SERVER_NAME,
  buildClaudeMcpServers,
  buildCodexMcpConfigToml,
} from "./mcpInjection.ts";

describe("exported constants", () => {
  it("SCIENT_MCP_SERVER_NAME is 'synara'", () => {
    expect(SCIENT_MCP_SERVER_NAME).toBe("scient");
  });

  it("SCIENT_AGENT_GATEWAY_TOKEN_ENV is 'SCIENT_AGENT_GATEWAY_TOKEN'", () => {
    expect(SCIENT_AGENT_GATEWAY_TOKEN_ENV).toBe("SCIENT_AGENT_GATEWAY_TOKEN");
  });
});

describe("buildClaudeMcpServers", () => {
  it("returns a record keyed by the Scient server name with an http config", () => {
    const servers = buildClaudeMcpServers({
      url: "https://example.test/mcp",
      bearerToken: "secret-token",
    });

    expect(Object.keys(servers)).toEqual([SCIENT_MCP_SERVER_NAME]);
    const entry = servers[SCIENT_MCP_SERVER_NAME];
    expect(entry).toBeDefined();
    expect(entry?.type).toBe("http");
    expect(entry?.url).toBe("https://example.test/mcp");
    expect(entry?.headers.Authorization).toBe("Bearer secret-token");
  });
});

describe("buildCodexMcpConfigToml", () => {
  const toml = buildCodexMcpConfigToml("https://example.test/mcp");

  it("contains the mcp_servers.scient table header", () => {
    expect(toml).toContain("[mcp_servers.scient]");
  });

  it("contains the json-quoted url", () => {
    expect(toml).toContain(`url = ${JSON.stringify("https://example.test/mcp")}`);
  });

  it("references the bearer_token_env_var as SCIENT_AGENT_GATEWAY_TOKEN", () => {
    expect(toml).toContain(
      `bearer_token_env_var = ${JSON.stringify("SCIENT_AGENT_GATEWAY_TOKEN")}`,
    );
  });

  it("contains a shell_environment_policy table", () => {
    expect(toml).toContain("[shell_environment_policy]");
  });

  it("excludes the token env var from the shell environment policy", () => {
    expect(toml).toContain(`exclude = [${JSON.stringify("SCIENT_AGENT_GATEWAY_TOKEN")}]`);
  });
});
