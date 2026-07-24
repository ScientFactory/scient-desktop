import { describe, expect, it } from "vitest";

import { buildIsolatedClaudeDiscoveryOptions } from "./claudeDiscoveryIsolation.ts";

describe("Claude discovery isolation", () => {
  it("preserves caller options while enforcing an MCP-free temporary process", () => {
    const abortController = new AbortController();
    const stderr = () => undefined;
    const env = {
      HOME: "/Users/tester",
      PATH: "/custom/bin",
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
    };

    const result = buildIsolatedClaudeDiscoveryOptions({
      cwd: "/workspace",
      pathToClaudeCodeExecutable: "/managed/claude",
      permissionMode: "plan",
      allowedTools: [],
      abortController,
      stderr,
      env,
      persistSession: true,
      settingSources: [],
      mcpServers: {
        unsafe: {
          command: "should-not-run",
        },
      },
      strictMcpConfig: false,
      agent: "unsafe-agent",
      agents: {
        "unsafe-agent": {
          description: "Must not participate in passive discovery",
          prompt: "Start an MCP server",
          tools: [],
        },
      },
      extraArgs: {
        "mcp-config": "/tmp/unsafe-mcp.json",
      },
    });

    expect(result).toMatchObject({
      cwd: "/workspace",
      pathToClaudeCodeExecutable: "/managed/claude",
      permissionMode: "plan",
      allowedTools: [],
      abortController,
      stderr,
      persistSession: false,
      settingSources: ["user", "project", "local"],
      mcpServers: {},
      strictMcpConfig: true,
      env: {
        HOME: "/Users/tester",
        PATH: "/custom/bin",
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      },
    });
    expect(result.env).not.toBe(env);
    expect(result).not.toHaveProperty("agent");
    expect(result).not.toHaveProperty("agents");
    expect(result).not.toHaveProperty("extraArgs");
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("true");
  });

  it("does not mutate process.env when enforcing the connector override", () => {
    const previous = process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
    try {
      delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
      const result = buildIsolatedClaudeDiscoveryOptions({ env: process.env });

      expect(result.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
      expect(process.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
      } else {
        process.env.ENABLE_CLAUDEAI_MCP_SERVERS = previous;
      }
    }
  });
});
