import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  probeClaudeAccountCapabilities,
  sanitizeClaudeAccountCapabilities,
  type ClaudeCapabilitiesQueryFactory,
} from "./claudeCapabilities";

describe("Claude account capability probing", () => {
  it("returns only non-secret account metadata from SDK initialization", async () => {
    let capturedOptions: Parameters<ClaudeCapabilitiesQueryFactory>[0]["options"] | undefined;
    const close = vi.fn();
    const createQuery: ClaudeCapabilitiesQueryFactory = (input) => {
      capturedOptions = input.options;
      return {
        initializationResult: async () => ({
          account: {
            email: "scientist@example.test",
            organization: "Research Lab",
            subscriptionType: "max",
            tokenSource: "claude.ai",
            apiProvider: "firstParty",
            accessToken: "must-not-escape",
          },
        }),
        close,
      };
    };

    await expect(
      probeClaudeAccountCapabilities({
        executable: "/custom/claude",
        env: { HOME: "/Users/tester" },
        cwd: "/workspace",
        createQuery,
      }),
    ).resolves.toEqual({
      email: "scientist@example.test",
      organization: "Research Lab",
      subscriptionType: "max",
      tokenSource: "claude.ai",
      apiProvider: "firstParty",
    });
    expect(capturedOptions).toMatchObject({
      pathToClaudeCodeExecutable: "/custom/claude",
      persistSession: false,
      allowedTools: [],
      cwd: "/workspace",
      settingSources: ["user", "project", "local"],
      mcpServers: {},
      strictMcpConfig: true,
      env: {
        HOME: "/Users/tester",
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      },
    });
    expect(capturedOptions?.env).not.toBe(process.env);
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not treat an empty initialization account as authentication proof", async () => {
    const createQuery: ClaudeCapabilitiesQueryFactory = () => ({
      initializationResult: async () => ({ account: {} }),
      close: () => undefined,
    });

    await expect(
      probeClaudeAccountCapabilities({ executable: "claude", env: {}, createQuery }),
    ).resolves.toBeUndefined();
  });

  it("times out and closes a stalled SDK probe", async () => {
    const close = vi.fn();
    const createQuery: ClaudeCapabilitiesQueryFactory = () => ({
      initializationResult: () => new Promise(() => undefined),
      close,
    });

    await expect(
      probeClaudeAccountCapabilities({
        executable: "claude",
        env: {},
        timeoutMs: 1,
        createQuery,
      }),
    ).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it("aborts and closes exactly once when SDK initialization fails", async () => {
    let capturedSignal: AbortSignal | undefined;
    const close = vi.fn();
    const createQuery: ClaudeCapabilitiesQueryFactory = (input) => {
      capturedSignal = input.options.abortController?.signal;
      return {
        initializationResult: async () => {
          throw new Error("simulated initialization failure");
        },
        close,
      };
    };

    await expect(
      probeClaudeAccountCapabilities({ executable: "claude", env: {}, createQuery }),
    ).resolves.toBeUndefined();
    expect(capturedSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("serializes the isolation boundary through the pinned Claude SDK", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "scient-claude-probe-sdk-"));
    const executablePath = path.join(tempDir, "fake-claude.mjs");
    const invocationPath = path.join(tempDir, "invocation.json");
    const workspaceCwd = path.join(tempDir, "workspace");
    mkdirSync(workspaceCwd, { recursive: true });

    writeFileSync(
      executablePath,
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        'import { createInterface } from "node:readline";',
        "const args = process.argv.slice(2);",
        "writeFileSync(process.env.SCIENT_PROBE_INVOCATION_PATH, JSON.stringify({",
        "  args,",
        "  cwd: process.cwd(),",
        "  connectorEnv: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,",
        "}));",
        "const lines = createInterface({ input: process.stdin });",
        'lines.on("line", (line) => {',
        "  const message = JSON.parse(line);",
        '  if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;',
        "  process.stdout.write(JSON.stringify({",
        '    type: "control_response",',
        "    response: {",
        '      subtype: "success",',
        "      request_id: message.request_id,",
        "      response: {",
        "        commands: [],",
        "        agents: [],",
        '        output_style: "default",',
        '        available_output_styles: ["default"],',
        "        models: [],",
        '        account: { email: "scientist@example.test", subscriptionType: "max", tokenSource: "claude.ai" },',
        "      },",
        "    },",
        '  }) + "\\n");',
        "});",
        "setInterval(() => {}, 1_000);",
        "",
      ].join("\n"),
    );
    chmodSync(executablePath, 0o755);

    try {
      await expect(
        probeClaudeAccountCapabilities({
          executable: executablePath,
          env: {
            ...process.env,
            SCIENT_PROBE_INVOCATION_PATH: invocationPath,
            ENABLE_CLAUDEAI_MCP_SERVERS: "true",
          },
          cwd: workspaceCwd,
          timeoutMs: 5_000,
        }),
      ).resolves.toEqual({
        email: "scientist@example.test",
        subscriptionType: "max",
        tokenSource: "claude.ai",
      });

      const invocation = JSON.parse(readFileSync(invocationPath, "utf8")) as {
        readonly args: ReadonlyArray<string>;
        readonly cwd: string;
        readonly connectorEnv: string;
      };
      expect(invocation.cwd).toBe(realpathSync(workspaceCwd));
      expect(invocation.connectorEnv).toBe("false");
      expect(invocation.args).toContain("--strict-mcp-config");
      expect(invocation.args).not.toContain("--mcp-config");
      expect(invocation.args).toContain("--setting-sources=user,project,local");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects token-only objects during sanitization", () => {
    expect(sanitizeClaudeAccountCapabilities({ accessToken: "secret" })).toBeUndefined();
  });

  it("does not treat Claude's logged-out sentinel values as authentication proof", () => {
    expect(
      sanitizeClaudeAccountCapabilities({
        tokenSource: "none",
        apiKeySource: "not_configured",
        subscriptionType: "unknown",
        apiProvider: "firstParty",
      }),
    ).toBeUndefined();
  });

  it("does not treat a first-party backend selection alone as a logged-in account", () => {
    expect(sanitizeClaudeAccountCapabilities({ apiProvider: "firstParty" })).toBeUndefined();
    expect(sanitizeClaudeAccountCapabilities({ apiProvider: "bedrock" })).toEqual({
      apiProvider: "bedrock",
    });
  });
});
