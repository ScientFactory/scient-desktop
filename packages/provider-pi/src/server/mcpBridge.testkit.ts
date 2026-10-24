// @effect-diagnostics nodeBuiltinImport:off -- Executes the shipped Pi extension at its native JavaScript boundary.
// SCIENT-FORK:START — Scient Extensions connectors: hashed connector tool aliases.
import * as NodeCrypto from "node:crypto";
// SCIENT-FORK:END
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { PI_T3_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";

// SCIENT-FORK:START — Scient Extensions connectors: tests type connector tool registrations.
export interface RegisteredTool {
  // SCIENT-FORK:END
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly outputSchema?: unknown;
  readonly exposure?: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: ReadonlyArray<string>;
  readonly execute: (
    id: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    readonly content: ReadonlyArray<{
      readonly type: string;
      readonly text?: string;
      readonly data?: string;
      readonly mimeType?: string;
    }>;
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
  }>;
}

type AgentStartHook = (
  event: {
    systemPrompt: string;
    systemPromptOptions?: { sections?: Record<string, string> | null; forceSystemPrompt?: string };
  },
  ctx: {
    model?: { api: string };
    ui: { notify: (message: string, severity: string) => void };
  },
) => Promise<{ systemPrompt: string } | undefined>;

// SCIENT-FORK:START — Scient Extensions connectors: proxied MCP server fixtures.
export interface FixtureConnector {
  readonly serverName: string;
  readonly url: string;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly annotations?: { readonly readOnlyHint?: boolean };
  }>;
  /** Listed verbatim after `tools`, as a misbehaving server might send them. */
  readonly malformedTools?: ReadonlyArray<unknown>;
  /** Fail every request, as an unreachable or misconfigured connector would. */
  readonly fail?: boolean;
}
// SCIENT-FORK:END

export async function loadMcpBridge(
  options: {
    readonly modern?: boolean;
    readonly result?: unknown;
    readonly toolSearchAvailable?: boolean;
    readonly toolSearchDisabled?: boolean;
    readonly allowsTool?: (name: string) => boolean;
    readonly toolNameMap?: Readonly<Record<string, string>>;
    readonly runtimeMode?: string;
    readonly inputSchema?: Record<string, unknown>;
    // SCIENT-FORK:START — Scient Extensions connectors: fixture servers and response encoding.
    readonly connectors?: ReadonlyArray<FixtureConnector>;
    /** Encodes a JSON-RPC response; undefined keeps the plain `application/json` reply. */
    readonly respond?: (
      message: { readonly jsonrpc: "2.0"; readonly id: number; readonly result: unknown },
      request: { readonly url: string; readonly method: string },
    ) => Response | undefined;
    // SCIENT-FORK:END
  } = {},
) {
  const handlers = new Map<string, AgentStartHook>();
  let agentStartHookCount = 0;
  const tools: RegisteredTool[] = [];
  const requests: Array<{ readonly method: string; readonly params?: unknown }> = [];
  let activeTools = ["read"];
  let bridgeSourcePath = "/fixture/pi-t3-extension.ts";
  const transports: Array<{
    readonly url: string;
    readonly authorization: string;
    readonly signal: AbortSignal | undefined;
  }> = [];
  const servers: Array<{ readonly name: string; readonly config: Record<string, unknown> }> = [];
  const catalog = [
    {
      name: "orchestrator_capabilities",
      description: "Discover available providers and models.",
      annotations: { readOnlyHint: true },
    },
    { name: "delegate_task", description: "Delegate work to another agent." },
    {
      name: "task_status",
      description: "Check delegated work.",
      annotations: { readOnlyHint: false },
    },
    { name: "preview_snapshot", description: "Inspect the collaborative browser." },
  ].map((tool) => ({
    ...tool,
    inputSchema: options.inputSchema ?? { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { count: { type: "number" } } },
  }));
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: {
      env: {
        T3_MCP_URL: "http://fixture.invalid/mcp",
        T3_MCP_BEARER_TOKEN: "fixture-token",
        ...(options.toolNameMap === undefined
          ? {}
          : { PI_TOOL_NAME_MAP: JSON.stringify(options.toolNameMap) }),
        // SCIENT-FORK:START — Scient Extensions connectors delivered with the session credential.
        ...(options.connectors === undefined
          ? {}
          : {
              T3_MCP_CONNECTORS: JSON.stringify(
                options.connectors.map(({ serverName, url }) => ({ serverName, url })),
              ),
            }),
        // SCIENT-FORK:END
        T3_PI_MCP_EXTENSION_PATH: "/fixture/pi-t3-extension.ts",
        T3_PI_RUNTIME_MODE: options.runtimeMode,
      },
    },
    AbortSignal,
    // SCIENT-FORK:START — Scient Extensions connectors: streamed responses and hashed aliases.
    TextDecoder,
    NodeCrypto,
    // SCIENT-FORK:END
    NodePath,
    Type: { Unsafe: (schema: unknown) => schema },
    fetch: async (
      url: string,
      transport: { body: string; headers: Record<string, string>; signal?: AbortSignal },
    ) => {
      transport.signal?.throwIfAborted();
      transports.push({
        url,
        authorization: transport.headers.authorization!,
        signal: transport.signal,
      });
      const request = JSON.parse(transport.body) as {
        id: number;
        method: string;
        params?: unknown;
      };
      requests.push(request);
      // SCIENT-FORK:START — Scient Extensions connectors: fixture servers answer their own requests.
      const connector = options.connectors?.find((candidate) => candidate.url === url);
      if (connector?.fail === true) {
        return new Response("connector unavailable", { status: 502 });
      }
      const calledTool =
        typeof request.params === "object" && request.params !== null && "name" in request.params
          ? String(request.params.name)
          : "";
      const result =
        request.method === "tools/list"
          ? {
              tools:
                connector === undefined
                  ? catalog
                  : [
                      ...connector.tools.map((tool) => ({
                        ...tool,
                        inputSchema: { type: "object", properties: {} },
                      })),
                      ...(connector.malformedTools ?? []),
                    ],
            }
          : request.method === "tools/call"
            ? connector === undefined
              ? (options.result ?? { content: [{ type: "text", text: "browser snapshot" }] })
              : { content: [{ type: "text", text: `${connector.serverName}:${calledTool}` }] }
            : {};
      const message = { jsonrpc: "2.0" as const, id: request.id, result };
      return (
        options.respond?.(message, { url, method: request.method }) ??
        new Response(JSON.stringify(message), {
          headers: { "content-type": "application/json" },
        })
      );
      // SCIENT-FORK:END
    },
    pi: {
      registerCommand: () => undefined,
      sendMessage: () => undefined,
      on: (name: string, handler: AgentStartHook) => {
        if (name === "before_agent_start" && ++agentStartHookCount > 1)
          throw new Error("Pi MCP bridge registered duplicate native system-prompt hooks.");
        handlers.set(name, handler);
      },
      registerTool: (tool: RegisteredTool) => {
        if (options.allowsTool && !options.allowsTool(tool.name)) return;
        const index = tools.findIndex((current) => current.name === tool.name);
        if (index === -1) tools.push(tool);
        else tools[index] = tool;
      },
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => {
        activeTools = names.filter((name) => options.allowsTool?.(name) ?? true);
      },
      getAllTools: () => [
        ...tools.map((tool) => ({ name: tool.name, sourceInfo: { path: bridgeSourcePath } })),
        ...(options.toolSearchAvailable &&
        !options.toolSearchDisabled &&
        (options.allowsTool?.("tool_search") ?? true)
          ? [{ name: "tool_search", sourceInfo: { path: "builtin:tool-search" } }]
          : []),
      ],
      ...(options.modern
        ? {
            registerMcpServer: (name: string, config: Record<string, unknown>) =>
              servers.push({ name, config }),
            unregisterMcpServer: () => servers.splice(0),
          }
        : {}),
    },
  });
  return {
    handlers,
    tools,
    setBridgeSourcePath: (path: string) => {
      bridgeSourcePath = path;
    },
    requests,
    servers,
    transports,
    getActiveTools: () => activeTools,
    restoreActiveTools: (names: string[]) => {
      activeTools = names;
    },
  };
}
