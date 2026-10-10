import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Tool } from "effect/ai";
import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import { CLAUDE_SCIENT_TOOL_PROJECTION } from "../../provider/ScientToolProjection.ts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import { HtmlToolkit } from "../../mcp/toolkits/html/tools.ts";
import { PreviewControlsToolkit } from "../../mcp/toolkits/previewControls/tools.ts";
import { EnvironmentToolkit } from "../../mcp/toolkits/environment/tools.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import { WorktreeToolkit } from "../../mcp/toolkits/worktree/tools.ts";
import { ScientThreadsToolkit } from "../../mcp/toolkits/threads/tools.ts";
import { ThreadToolkit } from "../../mcp/toolkits/thread/tools.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import type { EventNdjsonLogger } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

const makeMcpSession = (threadId: ThreadId): McpProviderSessionConfig => ({
  environmentId: EnvironmentId.make(`environment-${threadId}`),
  threadId,
  providerSessionId: `mcp-session-${threadId}`,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer secret-claude-token",
  capabilities: new Set(["preview"]),
});

describe("ClaudeAdapterV2 MCP query overrides", () => {
  const T3_MCP_SERVERS = {
    scient: {
      type: "http",
      url: "http://127.0.0.1:43123/mcp",
      headers: {
        Authorization: "${T3_CODE_MCP_AUTHORIZATION}",
      },
      timeout: ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
    },
  } as const;
  const T3_MCP_ENVIRONMENT = { T3_CODE_MCP_AUTHORIZATION: "Bearer secret-claude-token" };

  it("leaves an absent allowlist absent when no MCP session exists", () => {
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: undefined,
      readOnlySandbox: false,
    });

    assert.deepEqual(overrides, { scientAwareness: buildScientAwareness() });
  });

  it("preserves an explicit allowlist when no MCP session exists", () => {
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: undefined,
      readOnlySandbox: false,
      allowedTools: ["Read"],
    });

    assert.deepEqual(overrides, {
      scientAwareness: buildScientAwareness(),
      allowedTools: ["Read"],
    });
  });

  it("pre-approves all t3-code tools when attaching an MCP session without an allowlist", () => {
    const threadId = ThreadId.make("thread-claude-mcp-no-allowlist");
    const mcpSession = makeMcpSession(threadId);
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: false,
    });

    assert.deepEqual(overrides, {
      scientAwareness: buildScientAwareness(new Set(["preview"]), CLAUDE_SCIENT_TOOL_PROJECTION),
      allowedTools: [ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_WILDCARD],
      mcpServers: T3_MCP_SERVERS,
      mcpEnvironment: T3_MCP_ENVIRONMENT,
    });
  });

  it("extends an explicit allowlist with the t3-code wildcard", () => {
    const threadId = ThreadId.make("thread-claude-mcp-with-allowlist");
    const mcpSession = makeMcpSession(threadId);
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: false,
      allowedTools: ["Read", "mcp__scient__*"],
    });

    assert.deepEqual(overrides, {
      scientAwareness: buildScientAwareness(new Set(["preview"]), CLAUDE_SCIENT_TOOL_PROJECTION),
      allowedTools: ["Read", "mcp__scient__*"],
      mcpServers: T3_MCP_SERVERS,
      mcpEnvironment: T3_MCP_ENVIRONMENT,
    });
  });

  it("pre-approves only read-only t3-code tools in a read-only sandbox", () => {
    const threadId = ThreadId.make("thread-claude-mcp-read-only");
    const mcpSession = makeMcpSession(threadId);
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: true,
      allowedTools: [...ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS],
    });

    assert.deepEqual(overrides, {
      scientAwareness: buildScientAwareness(new Set(["preview"]), CLAUDE_SCIENT_TOOL_PROJECTION),
      allowedTools: [
        ...ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
        ...ClaudeAdapterV2.CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS,
      ],
      mcpServers: T3_MCP_SERVERS,
      mcpEnvironment: T3_MCP_ENVIRONMENT,
    });
    assert.isFalse(overrides.allowedTools?.includes(ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_WILDCARD));
  });

  it("pre-approves only read-only t3-code tools in a read-only sandbox without an allowlist", () => {
    const threadId = ThreadId.make("thread-claude-mcp-read-only-no-allowlist");
    const mcpSession = makeMcpSession(threadId);
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: true,
    });

    assert.deepEqual(overrides.allowedTools, [
      ...ClaudeAdapterV2.CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS,
    ]);
  });

  it("keys live-query reuse on the MCP-derived pre-approvals", () => {
    const threadId = ThreadId.make("thread-claude-mcp-query-key");
    const mcpSession = makeMcpSession(threadId);
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      }),
    );

    const readOnlyKey = ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(
      queryPolicy,
      ClaudeAdapterV2.claudeMcpQueryOverrides({ mcpSession, readOnlySandbox: true }),
    );
    const fullAccessKey = ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(
      queryPolicy,
      ClaudeAdapterV2.claudeMcpQueryOverrides({ mcpSession, readOnlySandbox: false }),
    );
    const detachedKey = ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(queryPolicy, {});

    assert.notEqual(readOnlyKey, fullAccessKey);
    assert.notEqual(fullAccessKey, detachedKey);
  });

  it("invalidates live-query reuse when MCP credentials rotate", () => {
    const threadId = ThreadId.make("thread-claude-mcp-credential-rotation");
    const mcpSession = makeMcpSession(threadId);
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
      }),
    );
    const initialKey = ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(
      queryPolicy,
      ClaudeAdapterV2.claudeMcpQueryOverrides({ mcpSession, readOnlySandbox: false }),
    );

    const rotatedSession: McpProviderSessionConfig = {
      ...mcpSession,
      authorizationHeader: "Bearer rotated-claude-token",
    };

    const rotatedKey = ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(
      queryPolicy,
      ClaudeAdapterV2.claudeMcpQueryOverrides({
        mcpSession: rotatedSession,
        readOnlySandbox: false,
      }),
    );
    assert.notEqual(rotatedKey, initialKey);
  });

  it("matches the read-only allowlist to the orchestrator toolkit annotations", () => {
    const readOnlyToolNames = [
      ...Object.values(OrchestratorToolkit.tools),
      ...Object.values(ThreadToolkit.tools),
      ...Object.values(ScientThreadsToolkit.tools),
      ...Object.values(WorktreeToolkit.tools),
      ...Object.values(ProjectToolkit.tools),
      ...Object.values(EnvironmentToolkit.tools),
      ...Object.values(PreviewControlsToolkit.tools),
      ...Object.values(HtmlToolkit.tools),
    ]
      .filter((tool) => Context.get(tool.annotations, Tool.Readonly))
      .map((tool) => `mcp__scient__${tool.name}`)
      .sort();

    assert.deepEqual(
      [...ClaudeAdapterV2.CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS].sort(),
      readOnlyToolNames,
    );
    assert.isFalse(
      ClaudeAdapterV2.CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS.includes(
        "mcp__scient__scient_thread_inspect",
      ),
    );
  });
});

describe("ClaudeAdapterV2 native protocol logging", () => {
  it("injects thread-scoped MCP configuration without logging the credential", () => {
    const threadId = ThreadId.make("thread-claude-mcp");
    const mcpSession: McpProviderSessionConfig = {
      environmentId: EnvironmentId.make("environment-claude-mcp"),
      threadId,
      providerSessionId: "mcp-session-claude",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-claude-token",
      capabilities: new Set(["preview"] as const),
    };
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: false,
      allowedTools: ["Read"],
    });
    assert.deepEqual(overrides, {
      scientAwareness: buildScientAwareness(new Set(["preview"]), CLAUDE_SCIENT_TOOL_PROJECTION),
      allowedTools: ["Read", "mcp__scient__*"],
      mcpServers: {
        scient: {
          type: "http",
          url: "http://127.0.0.1:43123/mcp",
          headers: {
            Authorization: "${T3_CODE_MCP_AUTHORIZATION}",
          },
          timeout: ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
        },
      },
      mcpEnvironment: { T3_CODE_MCP_AUTHORIZATION: "Bearer secret-claude-token" },
    });

    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      nativeThreadId: "native-thread-claude-mcp",
      resume: false,
      cwd: "/workspace",
      ...overrides,
      environment: { ...overrides.mcpEnvironment },
    });
    assert.notInclude(JSON.stringify(options.mcpServers), "secret-claude-token");
    assert.equal(options.env?.T3_CODE_MCP_AUTHORIZATION, "Bearer secret-claude-token");
    assert.isObject(options.systemPrompt);
    const systemPrompt = options.systemPrompt as {
      readonly type: string;
      readonly preset: string;
      readonly append?: string;
    };
    assert.equal(systemPrompt.type, "preset");
    assert.equal(systemPrompt.preset, "claude_code");
    assert.include(systemPrompt.append ?? "", "Use `delegate_task`");
    assert.include(systemPrompt.append ?? "", "mcp__scient__preview_status");
    assert.notInclude(systemPrompt.append ?? "", "scient_pdf_build");
    const logged = ClaudeAdapterV2.loggedClaudeQueryOptions(options);
    assert.equal(logged.hasMcpServers, true);
    assert.notInclude(JSON.stringify(logged), "secret-claude-token");
  });

  it.effect("writes Claude Agent SDK protocol frames to the native provider log", () =>
    Effect.gen(function* () {
      const writes: Array<{
        readonly event: unknown;
        readonly threadId: ThreadId | null;
      }> = [];
      const logger: EventNdjsonLogger = {
        filePath: "/tmp/events.log",
        write: (event, threadId) =>
          Effect.sync(() => {
            writes.push({ event, threadId });
          }),
        close: () => Effect.void,
      };
      const threadId = ThreadId.make("thread-1");
      const providerSessionId = ProviderSessionId.make("provider-session-1");
      const protocolLogger = ClaudeAdapterV2.makeClaudeAgentSdkProtocolLogger({
        nativeEventLogger: logger,
        threadId,
        providerSessionId,
      });

      assert.notEqual(protocolLogger, undefined);
      if (protocolLogger === undefined) {
        return;
      }

      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: {
          type: "stream_event",
          uuid: "00000000-0000-0000-0000-000000000001",
          session_id: "native-thread",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              get text(): string {
                throw new Error("streaming text must not be inspected");
              },
            },
          },
        },
      });
      yield* protocolLogger({
        direction: "outgoing",
        stage: "decoded",
        payload: {
          type: "query.interrupt",
        },
      });

      assert.equal(writes.length, 1);
      assert.equal(writes[0]?.threadId, threadId);
      assert.deepEqual(writes[0]?.event, {
        provider: "claudeAgent",
        protocol: ClaudeAdapterV2.CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
        kind: "protocol",
        providerSessionId,
        event: {
          direction: "outgoing",
          stage: "decoded",
          payload: {
            type: "query.interrupt",
          },
        },
      });
    }),
  );

  it("logs query options without leaking environment values or callback functions", () => {
    const options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions = {
      model: "claude-sonnet-4-6",
      tools: {
        type: "preset",
        preset: "claude_code",
      },
      permissionMode: "default",
      sessionId: "native-thread-1",
      cwd: "/workspace",
      env: {
        ANTHROPIC_API_KEY: "secret",
      },
      extraArgs: {
        "append-system-prompt": "secret launch prompt",
      },
      canUseTool: (_toolName, input, callbackOptions) =>
        Promise.resolve({
          behavior: "allow",
          updatedInput: input,
          toolUseID: callbackOptions.toolUseID,
          decisionClassification: "user_temporary",
        }),
    };

    assert.deepEqual(ClaudeAdapterV2.loggedClaudeQueryOptions(options), {
      model: "claude-sonnet-4-6",
      tools: {
        type: "preset",
        preset: "claude_code",
      },
      permissionMode: "default",
      sessionId: "native-thread-1",
      cwd: "/workspace",
      hasCanUseTool: true,
      hasEnvironment: true,
      hasExtraArgs: true,
    });
    assert.notInclude(
      JSON.stringify(ClaudeAdapterV2.loggedClaudeQueryOptions(options)),
      "secret launch prompt",
    );
  });
});
