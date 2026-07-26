import { describe, expect, it } from "vitest";

import {
  SYNARA_AGENT_GATEWAY_TOKEN_ENV,
  SYNARA_MCP_SERVER_NAME,
  buildClaudeMcpServers,
  buildCodexMcpConfigToml,
} from "./mcpInjection.ts";

describe("exported constants", () => {
  it("SYNARA_MCP_SERVER_NAME is 'synara'", () => {
    expect(SYNARA_MCP_SERVER_NAME).toBe("synara");
  });

  it("SYNARA_AGENT_GATEWAY_TOKEN_ENV is 'SYNARA_AGENT_GATEWAY_TOKEN'", () => {
    expect(SYNARA_AGENT_GATEWAY_TOKEN_ENV).toBe("SYNARA_AGENT_GATEWAY_TOKEN");
  });
});

describe("buildClaudeMcpServers", () => {
  it("returns a record keyed by the synara server name with an http config", () => {
    const servers = buildClaudeMcpServers({
      url: "https://example.test/mcp",
      bearerToken: "secret-token",
    });

    expect(Object.keys(servers)).toEqual([SYNARA_MCP_SERVER_NAME]);
    const entry = servers[SYNARA_MCP_SERVER_NAME];
    expect(entry).toBeDefined();
    expect(entry?.type).toBe("http");
    expect(entry?.url).toBe("https://example.test/mcp");
    expect(entry?.headers.Authorization).toBe("Bearer secret-token");
  });
});

describe("buildCodexMcpConfigToml", () => {
  const toml = buildCodexMcpConfigToml("https://example.test/mcp");

  it("contains the mcp_servers.synara table header", () => {
    expect(toml).toContain("[mcp_servers.synara]");
  });

  it("contains the json-quoted url", () => {
    expect(toml).toContain(`url = ${JSON.stringify("https://example.test/mcp")}`);
  });

  it("references the bearer_token_env_var as SYNARA_AGENT_GATEWAY_TOKEN", () => {
    expect(toml).toContain(
      `bearer_token_env_var = ${JSON.stringify("SYNARA_AGENT_GATEWAY_TOKEN")}`,
    );
  });

  it("contains a shell_environment_policy table", () => {
    expect(toml).toContain("[shell_environment_policy]");
  });

  it("excludes the token env var from the shell environment policy", () => {
    expect(toml).toContain(`exclude = [${JSON.stringify("SYNARA_AGENT_GATEWAY_TOKEN")}]`);
  });
});
