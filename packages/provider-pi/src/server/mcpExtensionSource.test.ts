// @effect-diagnostics nodeBuiltinImport:off -- Pi extensions run outside Effect; these tests exercise their native filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { piContextExtension } from "./contextExtension.ts";
import { makePiMcpExtensionSource, PI_T3_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";
import { buildPiRpcLaunch, materializePiT3McpExtension } from "./mcpInjection.ts";
// SCIENT-FORK:START — Scient Extensions connectors: connector tool registrations.
import { loadMcpBridge, type RegisteredTool } from "./mcpBridge.testkit.ts";
// SCIENT-FORK:END

const decodeBudget = Schema.decodeUnknownSync(
  Schema.Struct({
    max_tokens: Schema.optional(Schema.Number),
    max_completion_tokens: Schema.optional(Schema.Number),
    max_output_tokens: Schema.optional(Schema.Number),
    thinking: Schema.optional(Schema.Struct({ budget_tokens: Schema.Number })),
    generationConfig: Schema.optional(
      Schema.Struct({
        maxOutputTokens: Schema.Number,
        thinkingConfig: Schema.Struct({ thinkingBudget: Schema.Number }),
      }),
    ),
  }),
);

type ContextApi = Parameters<typeof piContextExtension>[0];
type ContextHook = Parameters<ContextApi["on"]>[1];
type RequestContext = Parameters<ContextHook>[1] & {
  model: { provider: string; contextWindow: number; maxTokens: number };
};

async function loadContextGuard(source = PI_T3_MCP_EXTENSION_SOURCE, contextWindow = 100_000) {
  const handlers = new Map<string, ContextHook[]>();
  const commands = new Map<string, Parameters<ContextApi["registerCommand"]>[1]>();
  const compactions: Array<Parameters<RequestContext["compact"]>[0]> = [];
  const notices: Array<{ message: string; kind: string }> = [];
  const messages: Array<{
    message: Parameters<ContextApi["sendMessage"]>[0];
    options: Parameters<ContextApi["sendMessage"]>[1];
  }> = [];
  let aborts = 0;
  let nativeTokens: number | undefined;
  const ctx: RequestContext = {
    model: { provider: "anthropic", contextWindow, maxTokens: 65_536 },
    getContextUsage: () => (nativeTokens === undefined ? undefined : { tokens: nativeTokens }),
    compact: (options) => compactions.push(options),
    abort: () => {
      aborts += 1;
    },
    ui: { notify: (message, kind) => notices.push({ message, kind }) },
  };
  const executable = NodeModule.stripTypeScriptTypes(
    source.replace(/^import .*;$/gm, "").replace("export default async function", "async function"),
  );
  await NodeVM.runInNewContext(`${executable}\nt3McpExtension(pi)`, {
    TextEncoder,
    process: { env: {} },
    pi: {
      on: (name: string, handler: ContextHook) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerCommand: (name: string, command: Parameters<ContextApi["registerCommand"]>[1]) => {
        commands.set(name, command);
      },
      sendMessage: (
        message: Parameters<ContextApi["sendMessage"]>[0],
        options: Parameters<ContextApi["sendMessage"]>[1],
      ) => {
        messages.push({ message, options });
      },
      getCommands: () => [],
    },
  });
  return {
    ctx,
    compactions,
    notices,
    messages,
    setNativeTokens: (tokens: number) => {
      nativeTokens = tokens;
    },
    aborts: () => aborts,
    latestCompaction: () => {
      const current = compactions.at(-1);
      if (!current) throw new Error("No native compaction requested");
      return current;
    },
    request: (payload: unknown) => {
      let replacement = payload;
      for (const handler of handlers.get("before_provider_request") ?? []) {
        const result = handler({ payload: replacement }, ctx);
        if (result !== undefined) replacement = result;
      }
      return replacement;
    },
    nextInput: () => {
      for (const handler of handlers.get("input") ?? []) {
        handler({ payload: undefined, text: "" } as Parameters<ContextHook>[0], ctx);
      }
    },
    compactCommand: () => {
      const command = commands.get("compact");
      if (!command) throw new Error("Missing native Compact command");
      return command;
    },
  };
}
type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

interface SkillCommand {
  readonly name: string;
  readonly source: string;
  readonly sourceInfo: { readonly path: string };
}

type InputHook = (
  event: { text: string; images?: ReadonlyArray<unknown> },
  ctx: { ui: { notify: (message: string, level: string) => void } },
) => Promise<{ action: string; text: string; images?: ReadonlyArray<unknown> } | undefined>;

async function loadHooks(commands: ReadonlyArray<SkillCommand> = []) {
  const handlers = new Map<string, unknown>();
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: {} },
    NodeFSP,
    NodePath,
    stripFrontmatter: (content: string) => content,
    pi: {
      on: (name: string, handler: unknown) => handlers.set(name, handler),
      getCommands: () => commands,
      registerCommand: () => undefined,
      sendMessage: () => undefined,
    },
  });
  return handlers;
}

describe("Pi orchestration prompt section", () => {
  it("adds a stable section without overriding the prompt or skipping discovery", async () => {
    const bridge = await loadMcpBridge({ modern: true, toolSearchAvailable: true });
    const hook = bridge.handlers.get("before_agent_start")!;
    const sections: Record<string, string> = { existing: "keep me" };
    const event = { systemPrompt: "base", systemPromptOptions: { sections } };
    const ctx = { model: { api: "openai-completions" }, ui: { notify: assert.fail } };

    assert.isUndefined(await hook(event, ctx));
    assert.include(sections.t3_code_orchestration, "orchestrator_capabilities");
    assert.equal(event.systemPrompt, "base");
    assert.include(bridge.getActiveTools(), "preview_snapshot");

    const guidance = sections.t3_code_orchestration!;
    assert.isUndefined(await hook(event, ctx));
    assert.deepEqual(event.systemPromptOptions.sections, {
      existing: "keep me",
      t3_code_orchestration: guidance,
    });
  });

  it.each([
    {
      name: "on Pi builds without prompt sections",
      events: [
        { systemPrompt: "base" },
        { systemPrompt: "base", systemPromptOptions: {} },
        { systemPrompt: "base", systemPromptOptions: { sections: null } },
      ],
    },
    {
      name: "when an earlier extension forces the system prompt",
      events: [
        {
          systemPrompt: "forced",
          systemPromptOptions: { sections: {}, forceSystemPrompt: "forced" },
        },
      ],
    },
  ])("appends guidance $name", async ({ events }) => {
    const bridge = await loadMcpBridge();
    const hook = bridge.handlers.get("before_agent_start")!;
    for (const event of events) {
      const result = await hook(event, { ui: { notify: assert.fail } });
      assert.isDefined(result);
      assert.isTrue(result!.systemPrompt.startsWith(`${event.systemPrompt}\n\n`));
      assert.include(result!.systemPrompt, "orchestrator_capabilities");
    }
  });
});

describe("Pi MCP tool results", () => {
  it("returns mixed screenshot blocks and typed script output without repeating structured text", async () => {
    const content = [
      { type: "text", text: "Browser screenshot" },
      { type: "image", data: "AAAA", mimeType: "image/png", _meta: { private: true } },
      { type: "text", text: "Screenshot captured" },
    ] as const;
    const result = { content, structuredContent: { count: 2 }, _meta: { private: true } };
    const bridge = await loadMcpBridge({ modern: true, result });
    const tool = bridge.tools.find((tool) => tool.name === "preview_snapshot")!;
    const output = await tool.execute("snapshot", {});
    assert.deepEqual(output.content, [
      content[0],
      { type: "image", data: "AAAA", mimeType: "image/png" },
      content[2],
    ]);
    assert.deepEqual(output.structuredContent, { content, structuredContent: { count: 2 } });
    assert.deepEqual(tool.outputSchema, {
      type: "object",
      properties: {
        content: { type: "array", items: { type: "object" } },
        structuredContent: { type: "object", properties: { count: { type: "number" } } },
        isError: { type: "boolean" },
        _meta: { type: "object" },
      },
      required: ["content"],
    });
  });

  it.each([false, true])(
    "preserves image-only results and error status, isError=%s",
    async (isError) => {
      const image = { type: "image", data: "AAAA", mimeType: "image/png" };
      const result = { content: [image], isError };
      const bridge = await loadMcpBridge({ result });
      const output = await bridge.tools[0]!.execute("image", {});
      assert.deepEqual(output.content[0], image);
      assert.equal(output.content.length, isError ? 2 : 1);
      if (isError) assert.include(output.content[1]?.text ?? "", "returned an error");
      assert.equal(output.isError, isError ? true : undefined);
      assert.deepEqual(output.structuredContent, result);
    },
  );

  it("uses structured output as model text when content is empty", async () => {
    const result = { content: [], structuredContent: { count: 2 } };
    const bridge = await loadMcpBridge({ result });
    const output = await bridge.tools[0]!.execute("structured", {});
    assert.deepEqual(output.content, [{ type: "text", text: '{"count":2}' }]);
    assert.deepEqual(output.structuredContent, result);
  });

  it("propagates cancellation without returning a successful result", async () => {
    const bridge = await loadMcpBridge();
    const controller = new AbortController();
    controller.abort();
    await expect(bridge.tools[0]!.execute("cancelled", {}, controller.signal)).rejects.toThrow(
      "aborted",
    );
  });
});

describe("Pi MCP tool exposure", () => {
  const discoveryContext = {
    model: { api: "anthropic-messages" },
    ui: { notify: () => undefined },
  };

  it.each(["session_start", "session_tree", "model_select", "before_agent_start"])(
    "declares optional Scient tools for OpenAI-compatible gateways at %s",
    async (hookName) => {
      const bridge = await loadMcpBridge({ modern: true, toolSearchAvailable: true });
      const hook = bridge.handlers.get(hookName);
      assert.isDefined(hook);
      await hook!(
        { systemPrompt: "Pi system prompt" },
        { model: { api: "openai-completions" }, ui: { notify: assert.fail } },
      );
      assert.deepEqual(
        bridge.tools.map((tool) => [tool.name, tool.exposure]),
        [
          ["orchestrator_capabilities", "direct"],
          ["delegate_task", "direct"],
          ["task_status", "direct"],
          ["preview_snapshot", "deferred"],
        ],
      );
      assert.isTrue(bridge.tools.every((tool) => bridge.getActiveTools().includes(tool.name)));
      const result = await bridge.tools
        .find((tool) => tool.name === "preview_snapshot")!
        .execute("gateway-call", {});
      assert.equal(result.content[0]?.text, "browser snapshot");
      assert.isTrue(bridge.tools.every((tool) => !tool.name.includes("mcp__t3")));
    },
  );

  it("keeps orchestration direct and optional bridge tools discoverable on modern Pi", async () => {
    const bridge = await loadMcpBridge({ modern: true, toolSearchAvailable: true });
    await bridge.handlers.get("session_start")!({ systemPrompt: "" }, discoveryContext);
    const start = bridge.handlers.get("before_agent_start");
    assert.isDefined(start);
    const prompt = await start!({ systemPrompt: "Pi system prompt" }, discoveryContext);
    assert.include(prompt?.systemPrompt ?? "", "orchestrator_capabilities");
    assert.equal(bridge.servers.length, 0);
    assert.equal(bridge.tools.length, 4);
    assert.deepEqual(bridge.getActiveTools(), ["read", "tool_search"]);
    assert.deepEqual(
      bridge.tools
        .filter((tool) => tool.exposure !== "hidden")
        .map((tool) => [tool.name, tool.exposure]),
      [
        ["orchestrator_capabilities", "direct"],
        ["delegate_task", "direct"],
        ["task_status", "direct"],
        ["preview_snapshot", "deferred"],
      ],
    );
    assert.isTrue(bridge.tools.every((tool) => !tool.name.includes("mcp__t3")));
    const result = await bridge.tools
      .find((tool) => tool.name === "preview_snapshot")!
      .execute("call-1", { depth: 2 });
    assert.equal(result.content[0]?.text, "browser snapshot");
    assert.equal(bridge.requests.at(-1)?.method, "tools/call");
  });

  it("restores gateway declarations after model switches and older tree loadouts without excluded tools", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolSearchAvailable: true,
      allowsTool: (name) => name !== "delegate_task",
    });
    const event = { systemPrompt: "" };
    await bridge.handlers.get("session_start")!(event, discoveryContext);
    const gatewayContext = { model: { api: "openai-completions" }, ui: { notify: assert.fail } };
    await bridge.handlers.get("model_select")!(event, gatewayContext);
    bridge.restoreActiveTools(["read", "task_status"]);
    await bridge.handlers.get("session_tree")!(event, gatewayContext);
    assert.deepEqual(bridge.getActiveTools(), [
      "read",
      "task_status",
      "tool_search",
      "orchestrator_capabilities",
      "preview_snapshot",
    ]);
    await bridge.handlers.get("model_select")!(event, discoveryContext);
    assert.equal(
      bridge.tools.find((tool) => tool.name === "preview_snapshot")?.exposure,
      "deferred",
    );
    assert.include(bridge.getActiveTools(), "preview_snapshot");
  });

  it.each(["legacy Pi", "disabled tool search"])(
    "keeps tool execution available with %s",
    async (mode) => {
      const bridge = await loadMcpBridge({
        modern: mode !== "legacy Pi",
        toolSearchAvailable: mode === "disabled tool search",
        toolSearchDisabled: mode === "disabled tool search",
      });
      if (mode !== "legacy Pi") {
        const start = bridge.handlers.get("session_start");
        await start!({ systemPrompt: "Pi system prompt" }, discoveryContext);
      }
      assert.equal(bridge.tools.filter((tool) => tool.exposure !== "hidden").length, 4);
      assert.isTrue(
        bridge.tools
          .filter((tool) => tool.exposure !== "hidden")
          .every((tool) => tool.exposure === undefined || tool.exposure === "direct"),
      );
      const tool = bridge.tools.find((tool) => tool.name === "preview_snapshot");
      assert.isDefined(tool);
      const controller = new AbortController();
      const result = await tool!.execute("call-1", { depth: 2 }, controller.signal);
      assert.equal(result.content[0]?.text, "browser snapshot");
      assert.strictEqual(bridge.transports.at(-1)?.signal, controller.signal);
      assert.equal(bridge.transports.at(-1)?.url, "http://fixture.invalid/mcp");
      assert.equal(bridge.transports.at(-1)?.authorization, "Bearer fixture-token");
      assert.deepEqual(JSON.parse(JSON.stringify(bridge.requests.at(-1))), {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "preview_snapshot", arguments: { depth: 2 } },
      });
      assert.isUndefined(tool?.promptSnippet);
      assert.isUndefined(tool?.promptGuidelines);
    },
  );

  it("keeps model-visible names on the canonical Scient projection", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolSearchAvailable: true,
      toolNameMap: { preview_snapshot: "mcp__scient__preview_snapshot" },
    });
    await bridge.handlers.get("session_start")!(
      { systemPrompt: "" },
      { model: { api: "openai-completions" }, ui: { notify: () => undefined } },
    );
    assert.include(bridge.getActiveTools(), "mcp__scient__preview_snapshot");
    assert.notInclude(bridge.getActiveTools(), "preview_snapshot");
    const tool = bridge.tools.find((tool) => tool.name === "mcp__scient__preview_snapshot");
    assert.isDefined(tool);
    assert.equal((await tool!.execute("selected", {})).content[0]?.text, "browser snapshot");
    assert.deepEqual(bridge.requests.at(-1)?.params, {
      name: "preview_snapshot",
      arguments: {},
    });
    assert.isTrue(bridge.tools.every((item) => !item.name.includes("mcp__t3")));
  });

  it.each([false, true])(
    "reconciles tree loadouts while honoring search exclusion: %s",
    async (excludeSearch) => {
      const bridge = await loadMcpBridge({
        modern: true,
        toolSearchAvailable: true,
        allowsTool: (name) =>
          name !== "delegate_task" && (!excludeSearch || name !== "tool_search"),
      });
      await bridge.handlers.get("session_start")!({ systemPrompt: "" }, discoveryContext);
      bridge.restoreActiveTools([
        "read",
        "mcp__t3-code__task_status",
        "mcp__t3-code__preview_snapshot",
      ]);
      const tree = bridge.handlers.get("session_tree");
      assert.isDefined(tree);
      await tree!({ systemPrompt: "" }, discoveryContext);
      assert.deepEqual(bridge.getActiveTools(), [
        "read",
        "task_status",
        "preview_snapshot",
        ...(!excludeSearch ? ["tool_search"] : []),
      ]);
      assert.isFalse(
        bridge.tools.some((tool) => tool.exposure !== "hidden" && tool.name === "delegate_task"),
      );
    },
  );
});

describe("Pi tool discovery permissions", () => {
  it.each(["approval-required", "auto-accept-edits", "auto"])(
    "allows annotated Scient reads in %s while gating mutations and replacements",
    async (runtimeMode) => {
      const bridge = await loadMcpBridge({ modern: true, runtimeMode });
      const hook = bridge.handlers.get("tool_call") as unknown as (
        event: { toolName: string; input: unknown },
        ctx: { hasUI: boolean; ui: { confirm: (title: string) => Promise<boolean> } },
      ) => Promise<{ block: true; reason: string } | undefined>;
      const confirmations: string[] = [];
      const ctx = {
        hasUI: true,
        ui: {
          confirm: async (title: string) => {
            confirmations.push(title);
            return false;
          },
        },
      };
      for (const prefix of [""]) {
        assert.isUndefined(
          await hook({ toolName: prefix + "orchestrator_capabilities", input: {} }, ctx),
        );
        assert.equal(
          (await hook({ toolName: prefix + "delegate_task", input: {} }, ctx))?.block,
          true,
        );
        assert.equal(
          (await hook({ toolName: prefix + "task_status", input: {} }, ctx))?.block,
          true,
        );
      }
      assert.equal(confirmations.length, 2);
      bridge.setBridgeSourcePath("/user/extensions/replacement.ts");
      assert.equal(
        (await hook({ toolName: "orchestrator_capabilities", input: {} }, ctx))?.block,
        true,
      );
      assert.equal(
        (await hook({ toolName: "mcp__other__orchestrator_capabilities", input: {} }, ctx))?.block,
        true,
      );
      assert.equal(confirmations.length, 4);
    },
  );

  it("allows discovery without confirmation and still gates the discovered tool", async () => {
    type ToolCallHook = (
      event: { toolName: string; input: unknown },
      ctx: {
        signal: AbortSignal;
        ui: {
          confirm: (
            title: string,
            detail: string,
            options: { signal: AbortSignal },
          ) => Promise<boolean>;
        };
      },
    ) => Promise<{ block: true; reason: string } | undefined>;
    let toolCall: ToolCallHook | undefined;
    let searchPath = "builtin:tool-search";
    const source = NodeModule.stripTypeScriptTypes(
      PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
        "export default async function",
        "async function",
      ),
    );
    await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
      process: { env: { T3_PI_RUNTIME_MODE: "approval-required" } },
      pi: {
        registerCommand: () => undefined,
        sendMessage: () => undefined,
        on: (name: string, handler: ToolCallHook) => {
          if (name === "tool_call") toolCall = handler;
        },
        getAllTools: () => [{ name: "tool_search", sourceInfo: { path: searchPath } }],
      },
    });
    assert.isDefined(toolCall);
    const confirmations: string[] = [];
    const controller = new AbortController();
    const ctx = {
      hasUI: true,
      signal: controller.signal,
      ui: {
        confirm: async (title: string, _detail: string, options: { signal: AbortSignal }) => {
          assert.strictEqual(options.signal, controller.signal);
          confirmations.push(title);
          return false;
        },
      },
    };
    assert.isUndefined(
      await toolCall!({ toolName: "tool_search", input: { query: "preview_snapshot" } }, ctx),
    );
    assert.equal(confirmations.length, 0);
    const result = await toolCall!({ toolName: "preview_snapshot", input: {} }, ctx);
    assert.equal(result?.block, true);
    assert.deepEqual(confirmations, ["Allow preview_snapshot?"]);

    searchPath = "/extensions/custom-search.ts";
    const replaced = await toolCall!({ toolName: "tool_search", input: {} }, ctx);
    assert.equal(replaced?.block, true);
    assert.equal(confirmations.at(-1), "Allow tool_search?");
  });
});

// SCIENT-FORK:START — Scient Extensions connectors: proxied MCP servers and event-stream responses.
describe("Pi Scient connectors", () => {
  const linear = {
    serverName: "linear",
    url: "http://fixture.invalid/mcp/connectors/linear",
    tools: [
      {
        name: "search.issues",
        description: "Search Linear issues.",
        annotations: { readOnlyHint: true },
      },
      { name: "create_issue", description: "Create a Linear issue." },
    ],
  };
  const notion = {
    serverName: "notion",
    url: "http://fixture.invalid/mcp/connectors/notion",
    tools: [{ name: "search", description: "Search Notion." }],
  };

  it("registers each connector's tools under a server prefix on the session credential", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolSearchAvailable: true,
      connectors: [linear, notion],
    });
    await bridge.handlers.get("session_start")!(
      { systemPrompt: "" },
      { model: { api: "openai-completions" }, ui: { notify: assert.fail } },
    );
    assert.deepEqual(
      bridge.tools.map((tool) => [tool.name, tool.exposure]),
      [
        ["orchestrator_capabilities", "direct"],
        ["delegate_task", "direct"],
        ["task_status", "direct"],
        ["preview_snapshot", "deferred"],
        ["linear__search_issues", "deferred"],
        ["linear__create_issue", "deferred"],
        ["notion__search", "deferred"],
      ],
    );
    for (const name of ["linear__search_issues", "linear__create_issue", "notion__search"]) {
      assert.include(bridge.getActiveTools(), name);
    }

    const output = await bridge.tools
      .find((tool) => tool.name === "linear__search_issues")!
      .execute("connector-call", { query: "bug" });
    assert.equal(output.content[0]?.text, "linear:search.issues");
    assert.equal(bridge.transports.at(-1)?.url, linear.url);
    assert.deepEqual(bridge.requests.at(-1)?.params, {
      name: "search.issues",
      arguments: { query: "bug" },
    });
    assert.isTrue(
      bridge.transports.every((transport) => transport.authorization === "Bearer fixture-token"),
    );
    assert.sameMembers(
      [...new Set(bridge.transports.map((transport) => transport.url))],
      ["http://fixture.invalid/mcp", linear.url, notion.url],
    );
  });

  it("confirms connector tools even when they are annotated read-only", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      runtimeMode: "approval-required",
      connectors: [linear],
    });
    const hook = bridge.handlers.get("tool_call") as unknown as (
      event: { toolName: string; input: unknown },
      ctx: { hasUI: boolean; ui: { confirm: (title: string) => Promise<boolean> } },
    ) => Promise<{ block: true; reason: string } | undefined>;
    const confirmations: string[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        confirm: async (title: string) => {
          confirmations.push(title);
          return false;
        },
      },
    };
    assert.isUndefined(await hook({ toolName: "orchestrator_capabilities", input: {} }, ctx));
    assert.equal((await hook({ toolName: "linear__search_issues", input: {} }, ctx))?.block, true);
    assert.deepEqual(confirmations, ["Allow linear__search_issues?"]);
  });

  it("keeps Scient and healthy connectors when one connector fails", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      connectors: [{ ...linear, fail: true }, notion],
    });
    const notifications: Array<readonly [string, string]> = [];
    await bridge.handlers.get("session_start")!(
      { systemPrompt: "" },
      {
        model: { api: "anthropic-messages" },
        ui: { notify: (message, severity) => notifications.push([message, severity]) },
      },
    );
    assert.deepEqual(
      bridge.tools.map((tool) => tool.name),
      [
        "orchestrator_capabilities",
        "delegate_task",
        "task_status",
        "preview_snapshot",
        "notion__search",
      ],
    );
    assert.deepEqual(notifications, [["Scient connector linear unavailable.", "warning"]]);
    const scientResult = await bridge.tools
      .find((tool) => tool.name === "preview_snapshot")!
      .execute("scient-call", {});
    assert.equal(scientResult.content[0]?.text, "browser snapshot");
  });

  it("gives a connector tool colliding with a projected Scient tool name a hashed alias", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolNameMap: { preview_snapshot: "mcp__scient__preview_snapshot" },
      connectors: [
        {
          serverName: "mcp",
          url: "http://fixture.invalid/mcp/connectors/mcp",
          tools: [{ name: "scient__preview_snapshot" }, { name: "other" }],
        },
      ],
    });
    assert.deepEqual(
      bridge.tools.filter((tool) => tool.name.startsWith("mcp__")).map((tool) => tool.name),
      ["mcp__scient__preview_snapshot", "mcp__scient__preview_snapshot_573af5c1", "mcp__other"],
    );
    const scient = await bridge.tools
      .find((tool) => tool.name === "mcp__scient__preview_snapshot")!
      .execute("scient-call", {});
    assert.equal(scient.content[0]?.text, "browser snapshot");
    const connector = await bridge.tools
      .find((tool) => tool.name === "mcp__scient__preview_snapshot_573af5c1")!
      .execute("connector-call", {});
    assert.equal(connector.content[0]?.text, "mcp:scient__preview_snapshot");
    assert.deepEqual(bridge.requests.at(-1)?.params, {
      name: "scient__preview_snapshot",
      arguments: {},
    });
  });

  const VALID_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
  const longServer = {
    serverName: "k".repeat(44),
    url: "http://fixture.invalid/mcp/connectors/long",
    tools: [
      { name: "search_documents_" + "a".repeat(47) },
      { name: "search_documents_" + "b".repeat(47) },
    ],
  };
  const connectorNames = (bridge: { readonly tools: ReadonlyArray<{ readonly name: string }> }) =>
    bridge.tools.map((tool) => tool.name).filter((name) => name.includes("__"));

  it("aliases over-long connector tool names deterministically and calls the original name", async () => {
    const expected = [
      "k".repeat(44) + "__search_do_3ff089b7",
      "k".repeat(44) + "__search_do_73415594",
    ];
    const first = await loadMcpBridge({ modern: true, connectors: [longServer] });
    const second = await loadMcpBridge({ modern: true, connectors: [longServer] });
    assert.deepEqual(connectorNames(first), expected);
    assert.deepEqual(connectorNames(second), expected);
    for (const name of expected) {
      assert.equal(name.length, 64);
      assert.match(name, VALID_TOOL_NAME);
    }

    const output = await first.tools
      .find((tool) => tool.name === expected[1])!
      .execute("connector-call", { query: "q" });
    assert.equal(output.content[0]?.text, `${longServer.serverName}:${longServer.tools[1]!.name}`);
    assert.equal(first.transports.at(-1)?.url, longServer.url);
    assert.deepEqual(first.requests.at(-1)?.params, {
      name: longServer.tools[1]!.name,
      arguments: { query: "q" },
    });
  });

  it("prefixes an underscore when the server name starts with a digit", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      connectors: [
        {
          serverName: "1password",
          url: "http://fixture.invalid/mcp/connectors/1password",
          tools: [{ name: "item.get" }],
        },
      ],
    });
    assert.deepEqual(connectorNames(bridge), ["_1password__item_get"]);
    const output = await bridge.tools
      .find((tool) => tool.name === "_1password__item_get")!
      .execute("connector-call", {});
    assert.equal(output.content[0]?.text, "1password:item.get");
  });

  it("resolves names across connectors in delivered order", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      connectors: [
        {
          serverName: "a",
          url: "http://fixture.invalid/mcp/connectors/a",
          tools: [{ name: "b__c" }],
        },
        {
          serverName: "a__b",
          url: "http://fixture.invalid/mcp/connectors/ab",
          tools: [{ name: "c" }],
        },
      ],
    });
    assert.deepEqual(connectorNames(bridge), ["a__b__c", "a__b__c_a92700ce"]);
    const output = await bridge.tools
      .find((tool) => tool.name === "a__b__c_a92700ce")!
      .execute("connector-call", {});
    assert.equal(output.content[0]?.text, "a__b:c");
  });

  it("declares only valid connector tool names to completion gateways", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolSearchAvailable: true,
      connectors: [
        longServer,
        {
          serverName: "1password",
          url: "http://fixture.invalid/mcp/connectors/1password",
          tools: [{ name: "item.get" }, { name: "vault/list items" }],
        },
      ],
    });
    await bridge.handlers.get("session_start")!(
      { systemPrompt: "" },
      { model: { api: "openai-completions" }, ui: { notify: assert.fail } },
    );
    const names = connectorNames(bridge);
    assert.lengthOf(names, 4);
    for (const name of names) assert.include(bridge.getActiveTools(), name);
    for (const name of bridge.getActiveTools()) assert.match(name, VALID_TOOL_NAME);
  });

  it("keeps Scient and other connectors when one connector lists a pathological catalog", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolSearchAvailable: true,
      connectors: [
        {
          serverName: "patho",
          url: "http://fixture.invalid/mcp/connectors/patho",
          tools: [
            { name: "a.b" },
            { name: "a_b" },
            { name: "dup" },
            { name: "dup" },
            { name: "x".repeat(300) },
            { name: "x".repeat(300) + "!" },
          ],
          malformedTools: [null, {}, { name: 42 }, { name: "" }],
        },
        notion,
      ],
    });
    await bridge.handlers.get("session_start")!(
      { systemPrompt: "" },
      { model: { api: "openai-completions" }, ui: { notify: assert.fail } },
    );
    const names = bridge.tools.map((tool) => tool.name);
    assert.includeMembers(names, [
      "orchestrator_capabilities",
      "delegate_task",
      "task_status",
      "preview_snapshot",
      "patho__a_b",
      "patho__a_b_602396cf",
      "patho__dup",
      "notion__search",
    ]);
    assert.lengthOf(names, new Set(names).size);
    assert.lengthOf(connectorNames(bridge), 6);
    for (const name of names) assert.match(name, VALID_TOOL_NAME);
    for (const name of bridge.getActiveTools()) assert.match(name, VALID_TOOL_NAME);

    const notionOutput = await bridge.tools
      .find((tool) => tool.name === "notion__search")!
      .execute("connector-call", {});
    assert.equal(notionOutput.content[0]?.text, "notion:search");
    const scientOutput = await bridge.tools
      .find((tool) => tool.name === "preview_snapshot")!
      .execute("scient-call", {});
    assert.equal(scientOutput.content[0]?.text, "browser snapshot");
  });
});

/** An event-stream response delivered in `chunkSize`-byte pieces, optionally left open. */
function sseResponse(
  text: string,
  options: {
    readonly chunkSize?: number;
    readonly open?: boolean;
    readonly onCancel?: () => void;
  } = {},
) {
  const bytes = new TextEncoder().encode(text);
  const chunkSize = options.chunkSize ?? bytes.length;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          controller.enqueue(bytes.slice(offset, offset + chunkSize));
        }
        if (options.open !== true) controller.close();
      },
      cancel() {
        options.onCancel?.();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const dataLines = (value: unknown, eol = "\n") =>
  JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => `data: ${line}`)
    .join(eol);

describe("Pi MCP event-stream responses", () => {
  const connector = {
    serverName: "remote",
    url: "http://fixture.invalid/mcp/connectors/remote",
    tools: [{ name: "lookup" }],
  };
  const callRemote = (bridge: { readonly tools: ReadonlyArray<RegisteredTool> }) =>
    bridge.tools.find((tool) => tool.name === "remote__lookup")!.execute("connector-call", {});

  it("joins a pretty-printed message split across data lines and chunks", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      connectors: [connector],
      respond: (message, { url }) =>
        url === connector.url
          ? sseResponse(`event: message\n${dataLines(message)}\n\n`, { chunkSize: 7 })
          : undefined,
    });
    const output = await callRemote(bridge);
    assert.equal(output.content[0]?.text, "remote:lookup");
  });

  it("decodes UTF-8 split across chunks inside a multi-line message", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      connectors: [connector],
      respond: (message, { url, method }) =>
        url === connector.url && method === "tools/call"
          ? sseResponse(
              `${dataLines({ ...message, result: { content: [{ type: "text", text: "Zürich ✓" }] } })}\n\n`,
              { chunkSize: 1 },
            )
          : undefined,
    });
    const output = await callRemote(bridge);
    assert.equal(output.content[0]?.text, "Zürich ✓");
  });

  it("resolves on the matching response while the stream stays open, then cancels it", async () => {
    const cancelled: string[] = [];
    const bridge = await loadMcpBridge({
      modern: true,
      connectors: [connector],
      respond: (message, { url, method }) =>
        url === connector.url
          ? sseResponse(`data: ${JSON.stringify(message)}\n\n`, {
              open: true,
              onCancel: () => cancelled.push(method),
            })
          : undefined,
    });
    // Bootstrap (initialize, tools/list) completed over open streams too.
    assert.deepEqual(cancelled, ["initialize", "tools/list"]);
    const output = await callRemote(bridge);
    assert.equal(output.content[0]?.text, "remote:lookup");
    assert.deepEqual(cancelled, ["initialize", "tools/list", "tools/call"]);
  });

  it("skips comments, notifications and other requests' responses before the matching one", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      connectors: [connector],
      respond: (message, { url, method }) =>
        url === connector.url && method === "tools/call"
          ? sseResponse(
              [
                ": keep-alive",
                "",
                "event: message",
                "id: 1",
                "retry: 1000",
                `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}`,
                "",
                dataLines({
                  jsonrpc: "2.0",
                  id: message.id + 100,
                  result: { content: [{ type: "text", text: "wrong" }] },
                }),
                "",
                dataLines({ jsonrpc: "2.0", id: 7, method: "sampling/createMessage", params: {} }),
                "",
                dataLines(message),
                "",
                "",
              ].join("\n"),
              { open: true },
            )
          : undefined,
    });
    const output = await callRemote(bridge);
    assert.equal(output.content[0]?.text, "remote:lookup");
  });

  it("does not take a server request that reuses the pending id as its response", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      connectors: [connector],
      respond: (message, { url, method }) =>
        url === connector.url && method === "tools/call"
          ? sseResponse(
              [
                // The server numbers its own requests, so one may carry this call's id.
                dataLines({ jsonrpc: "2.0", id: message.id, method: "sampling/createMessage" }),
                "",
                dataLines(message),
                "",
                "",
              ].join("\n"),
              { open: true },
            )
          : undefined,
    });
    const output = await callRemote(bridge);
    assert.equal(output.content[0]?.text, "remote:lookup");
  });

  it.each([
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])(
    "parses %s-delimited events, including terminators split across chunks",
    async (_name, eol) => {
      const bridge = await loadMcpBridge({
        modern: true,
        connectors: [connector],
        respond: (message, { url }) =>
          url === connector.url
            ? sseResponse(
                `: ping${eol}${eol}${dataLines({ jsonrpc: "2.0", method: "notifications/message", params: {} }, eol)}${eol}${eol}${dataLines(message, eol)}${eol}${eol}`,
                { chunkSize: 1, open: true },
              )
            : undefined,
      });
      const output = await callRemote(bridge);
      assert.equal(output.content[0]?.text, "remote:lookup");
    },
  );

  it("reports a JSON-RPC error carried by the matching event", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      connectors: [connector],
      respond: (message, { url, method }) =>
        url === connector.url && method === "tools/call"
          ? sseResponse(
              `${dataLines({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "upstream refused" } })}\n\n`,
              { open: true },
            )
          : undefined,
    });
    await expect(callRemote(bridge)).rejects.toThrow("upstream refused");
  });

  it("fails clearly when the stream ends without the matching response", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      connectors: [connector],
      respond: (message, { url, method }) =>
        url === connector.url && method === "tools/call"
          ? sseResponse(`${dataLines({ ...message, id: message.id + 1 })}\n\n`)
          : undefined,
    });
    await expect(callRemote(bridge)).rejects.toThrow(
      "MCP tools/call event stream ended without its response.",
    );
  });

  it("keeps Scient's own server working over an event stream", async () => {
    const bridge = await loadMcpBridge({
      respond: (message) => sseResponse(`data: ${JSON.stringify(message)}\n\n`, { open: true }),
    });
    const output = await bridge.tools[0]!.execute("scient-call", {});
    assert.equal(output.content[0]?.text, "browser snapshot");
  });
});
// SCIENT-FORK:END

async function loadRequestHook(): Promise<RequestHook> {
  const h = await loadContextGuard(PI_T3_MCP_EXTENSION_SOURCE, 0);
  return ({ payload }, ctx) => {
    h.ctx.model.provider = ctx.model.provider;
    const result = h.request(payload);
    if (result === payload) return undefined;
    if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined;
    return Object.fromEntries(Object.entries(result));
  };
}

describe("Pi upstream output-budget workaround", () => {
  it.each(["max_tokens", "max_completion_tokens"])(
    "caps %s without changing the conversation or tools",
    async (key) => {
      const hook = await loadRequestHook();
      const payload = {
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read" } }],
        [key]: 231_969,
      };
      const result = hook({ payload }, { model: { provider: "openrouter" } });
      assert.equal(result?.[key], 32_768);
      assert.strictEqual(result?.messages, payload.messages);
      assert.strictEqual(result?.tools, payload.tools);
      assert.equal(result?.model, payload.model);
      assert.equal(payload[key], 231_969);
    },
  );

  it("preserves smaller budgets and other providers' payloads", async () => {
    const hook = await loadRequestHook();
    for (const payload of [{ max_tokens: 8192 }, { max_completion_tokens: 32_768 }, {}, null]) {
      assert.isUndefined(hook({ payload }, { model: { provider: "openrouter" } }));
    }
    assert.isUndefined(
      hook({ payload: { max_tokens: 231_969 } }, { model: { provider: "anthropic" } }),
    );
  });
});

describe("loaded native Pi serialized request guard", () => {
  it.each(
    (["max_tokens", "max_completion_tokens", "max_output_tokens"] as const).map((key) => ({
      caseTitle: `bounds ${key} from final instructions and tools without deleting input`,
      key,
    })),
  )("$caseTitle", async ({ key }) => {
    const h = await loadContextGuard();
    const payload = {
      messages: [{ role: "tool", content: "completed-action-receipt" }],
      tools: [{ description: "t".repeat(90_000) }],
      system: "s".repeat(90_000),
      [key]: 65_536,
    };
    const result = h.request(payload);
    const budget = decodeBudget(result)[key];
    assert.isNumber(budget);
    assert.isBelow(budget ?? Infinity, 35_000);
    assert.strictEqual(Reflect.get(Object(result), "messages"), payload.messages);
    assert.strictEqual(Reflect.get(Object(result), "tools"), payload.tools);
    assert.equal(payload[key], 65_536);
    assert.lengthOf(h.compactions, 0);
  });

  it("accounts for images and keeps Anthropic thinking inside output", async () => {
    const h = await loadContextGuard();
    const payload = {
      messages: [
        { content: [{ type: "image", source: { type: "base64", data: "a".repeat(1_000_000) } }] },
      ],
      max_tokens: 90_000,
      thinking: { type: "enabled", budget_tokens: 80_000 },
    };
    const result = decodeBudget(h.request(payload));
    assert.isAbove(result.max_tokens ?? 0, 70_000);
    assert.isBelow(result.max_tokens ?? Infinity, 79_000);
    assert.isAtMost(result.thinking?.budget_tokens ?? Infinity, (result.max_tokens ?? 0) - 1_024);
    assert.equal(payload.max_tokens, 90_000);
    assert.equal(payload.thinking.budget_tokens, 80_000);
  });

  it("counts Gemini response schema and preserves output/thinking constraints", async () => {
    const h = await loadContextGuard();
    h.ctx.model.provider = "google";
    const payload = {
      contents: [{ parts: [{ text: "continue" }] }],
      generationConfig: {
        maxOutputTokens: 65_536,
        responseSchema: { description: "s".repeat(210_000) },
        thinkingConfig: { thinkingBudget: 40_000 },
      },
    };
    const result = decodeBudget(h.request(payload)).generationConfig;
    assert.isBelow(result?.maxOutputTokens ?? Infinity, 25_000);
    assert.isAtMost(
      result?.thinkingConfig.thinkingBudget ?? Infinity,
      (result?.maxOutputTokens ?? 0) - 1_024,
    );
    assert.equal(payload.generationConfig.maxOutputTokens, 65_536);
    assert.lengthOf(h.compactions, 0);
  });

  it("compacts once and sends only a hidden continuation before rejecting repeated overflow", async () => {
    const h = await loadContextGuard();
    const payload = {
      messages: [{ role: "tool", content: "done" }, { content: "x".repeat(300_000) }],
    };
    assert.strictEqual(h.request(payload), payload);
    assert.lengthOf(h.compactions, 1);
    h.latestCompaction().onComplete();
    assert.lengthOf(h.messages, 1);
    assert.equal(h.messages[0]?.message.customType, "scient-context-continuation");
    assert.isFalse(h.messages[0]?.message.display);
    assert.isTrue(h.messages[0]?.options.triggerTurn);
    assert.include(h.messages[0]?.message.content ?? "", "Do not repeat completed tool actions");
    assert.notInclude(h.messages[0]?.message.content ?? "", "x".repeat(100));
    h.request(payload);
    assert.lengthOf(h.compactions, 1);
    assert.equal(h.aborts(), 1);
    assert.include(h.notices.at(-1)?.message ?? "", "scient:context-limit:");
    h.nextInput();
    h.request(payload);
    assert.lengthOf(h.compactions, 2);
  });

  it("reports failed automatic compaction without replaying input", async () => {
    const h = await loadContextGuard();
    const payload = { messages: [{ content: "x".repeat(300_000) }] };
    h.request(payload);
    h.latestCompaction().onError(new Error("synthetic native compaction failure"));
    assert.lengthOf(h.messages, 0);
    assert.equal(h.notices.at(-1)?.kind, "error");
    assert.include(h.notices.at(-1)?.message ?? "", "scient:context-limit:");
    assert.equal(payload.messages[0]?.content.length, 300_000);
  });

  it("keeps the native Compact command completion and error callbacks", async () => {
    const h = await loadContextGuard();
    let completed = false;
    const pending = h
      .compactCommand()
      .handler("preserve decisions", h.ctx)
      .then(() => {
        completed = true;
      });
    assert.isFalse(completed);
    assert.equal(h.latestCompaction().customInstructions, "preserve decisions");
    h.latestCompaction().onComplete();
    await pending;
    assert.isTrue(completed);
    const failed = h
      .compactCommand()
      .handler("", h.ctx)
      .then(
        () => undefined,
        (error: Error) => error.message,
      );
    h.latestCompaction().onError(new Error("native Compact failed"));
    assert.equal(await failed, "native Compact failed");
  });

  it.effect(
    "loads the guard from the actual materialized MCP-disabled native launch extension",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cache = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-context-extension-" });
        const extensionPath = yield* materializePiT3McpExtension(cache);
        const launch = buildPiRpcLaunch({
          launchArgs: [],
          environment: {},
          mcpSession: undefined,
          extensionPath,
        });
        assert.isFalse(launch.hasT3Mcp);
        assert.include(launch.args, extensionPath);
        const source = yield* fs.readFileString(extensionPath);
        const h = yield* Effect.tryPromise(() => loadContextGuard(source));
        h.setNativeTokens(80_000);
        assert.equal(
          decodeBudget(h.request({ messages: [], max_tokens: 50_000 })).max_tokens,
          15_000,
        );
        assert.lengthOf(h.compactions, 0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("native Pi Scient awareness channel", () => {
  it("embeds host-owned orchestration copy while preserving the generic package default", () => {
    const hostInstructions = "## Scient orchestration\nUse the Scient capability catalog.";
    const source = makePiMcpExtensionSource(hostInstructions);

    assert.equal(PI_T3_MCP_EXTENSION_SOURCE, makePiMcpExtensionSource());
    assert.include(PI_T3_MCP_EXTENSION_SOURCE, "T3 Code orchestration");
    assert.include(source, JSON.stringify(hostInstructions));
    assert.notInclude(source, "T3 Code orchestration");
  });

  it.each(
    [false, true].map((mcpAvailable) => ({
      caseTitle: `appends exact awareness through before_agent_start with MCP ${mcpAvailable}`,
      mcpAvailable,
    })),
  )("$caseTitle", async ({ mcpAvailable }) => {
    type Hook = (event: {
      systemPrompt: string;
      systemPromptOptions?: { sections: Record<string, string> };
    }) => { systemPrompt: string } | undefined;
    const handlers = new Map<string, Hook>();
    const env: Record<string, string> = {
      PI_RUNTIME_GUIDANCE: "Scient orchestration guidance fixture",
      ...(mcpAvailable
        ? { T3_MCP_URL: "http://127.0.0.1:43123/mcp", T3_MCP_BEARER_TOKEN: "synthetic-token" }
        : {}),
    };
    const hostInstructions = "## Scient orchestration\nUse the Scient capability catalog.";
    const source = NodeModule.stripTypeScriptTypes(
      makePiMcpExtensionSource(hostInstructions)
        .replace(/^import .*;$/gm, "")
        .replace("export default async function", "async function"),
    );
    await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
      process: { env },
      pi: {
        on: (name: string, handler: Hook) => handlers.set(name, handler),
        registerCommand: () => undefined,
      },
    });
    const hook = handlers.get("before_agent_start");
    assert.isDefined(hook);
    if (!hook) throw new Error("Missing native system prompt hook");
    const prompt = hook({ systemPrompt: "Native model instructions" })?.systemPrompt ?? "";
    assert.include(prompt, "Native model instructions\n\nScient orchestration guidance fixture");
    assert.equal(prompt.includes(hostInstructions), mcpAvailable);
    assert.notInclude(prompt, "T3 Code");
    assert.notInclude(prompt, "mcp__t3");
    assert.notInclude(prompt, "synthetic-token");
    assert.isUndefined(env.PI_RUNTIME_GUIDANCE);
    assert.isTrue(handlers.has("tool_call"));
    if (mcpAvailable) {
      const sections = { native: "keep native instructions" };
      const event = {
        systemPrompt: "Native model instructions",
        systemPromptOptions: { sections },
      };
      assert.isUndefined(hook(event));
      const guidance = event.systemPromptOptions.sections as Record<string, string>;
      assert.include(guidance.t3_code_orchestration, "Scient orchestration guidance fixture");
      assert.include(guidance.t3_code_orchestration, hostInstructions);
      assert.equal(guidance.native, "keep native instructions");
      assert.equal(event.systemPrompt, "Native model instructions");
    }
  });
});

async function loadInputHook(commands: ReadonlyArray<SkillCommand>) {
  const handlers = await loadHooks(commands);
  const hook = handlers.get("input");
  assert.isDefined(hook);
  return hook as InputHook;
}

describe("Pi skill references", () => {
  it("loads every selected skill once while preserving inline prose, whitespace, and images", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-skill-mentions-"));
    try {
      const alpha = NodePath.join(directory, "alpha.md");
      const beta = NodePath.join(directory, "beta.md");
      await NodeFSP.writeFile(alpha, "ALPHA_INSTRUCTIONS");
      await NodeFSP.writeFile(beta, "BETA_INSTRUCTIONS");
      const hook = await loadInputHook([
        { name: "skill:alpha", source: "skill", sourceInfo: { path: alpha } },
        { name: "skill:beta", source: "skill", sourceInfo: { path: beta } },
      ]);
      const text =
        "Please use the $alpha philosophy, then $beta and $alpha\n```ts\n  const x = 1;\n```";
      const images = [{ type: "image", data: "fixture" }];
      const result = await hook({ text, images }, { ui: { notify: assert.fail } });
      assert.equal(result?.action, "transform");
      assert.isTrue(result?.text.startsWith(text + "\n\n"));
      assert.equal(result?.text.split("ALPHA_INSTRUCTIONS").length, 2);
      assert.equal(result?.text.split("BETA_INSTRUCTIONS").length, 2);
      assert.include(result?.text ?? "", `References are relative to ${directory}.`);
      assert.strictEqual(result?.images, images);
    } finally {
      await NodeFSP.rm(directory, { recursive: true });
    }
  });

  it("leaves unknown references and native skill commands for Pi", async () => {
    const hook = await loadInputHook([
      { name: "skill:alpha", source: "skill", sourceInfo: { path: "/unused" } },
    ]);
    for (const text of [
      "Explain $HOME",
      "/skill:alpha use $alpha",
      "Hello",
      "$missing",
      "Use $alpha, then continue",
      "Use ($alpha)",
    ]) {
      assert.isUndefined(await hook({ text }, { ui: { notify: assert.fail } }));
    }
  });

  it("loads additional chips without duplicating a leading native skill", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-skill-mentions-"));
    try {
      const path = NodePath.join(directory, "beta.md");
      await NodeFSP.writeFile(path, "BETA_INSTRUCTIONS");
      const hook = await loadInputHook([
        { name: "skill:alpha", source: "skill", sourceInfo: { path: "/unused" } },
        { name: "skill:beta", source: "skill", sourceInfo: { path } },
      ]);
      const text = "/skill:alpha use $alpha and $beta";
      const result = await hook({ text }, { ui: { notify: assert.fail } });
      assert.isTrue(result?.text.startsWith(text + "\n\n"));
      assert.notInclude(result?.text ?? "", '<skill name="alpha"');
      assert.include(result?.text ?? "", "BETA_INSTRUCTIONS");
    } finally {
      await NodeFSP.rm(directory, { recursive: true });
    }
  });

  it("reports an unreadable skill without deleting its reference or other selected instructions", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-skill-mentions-"));
    try {
      const path = NodePath.join(directory, "readable.md");
      await NodeFSP.writeFile(path, "READABLE_INSTRUCTIONS");
      const hook = await loadInputHook([
        {
          name: "skill:missing",
          source: "skill",
          sourceInfo: { path: NodePath.join(directory, "missing.md") },
        },
        { name: "skill:readable", source: "skill", sourceInfo: { path } },
      ]);
      const notices: string[] = [];
      const text = "Use $missing and $readable";
      const result = await hook(
        { text },
        {
          ui: {
            notify: (message) => {
              notices.push(message);
            },
          },
        },
      );
      assert.isTrue(result?.text.startsWith(text + "\n\n"));
      assert.include(result?.text ?? "", "READABLE_INSTRUCTIONS");
      assert.equal(notices.length, 1);
      assert.include(notices[0] ?? "", "Could not load skill missing");
    } finally {
      await NodeFSP.rm(directory, { recursive: true });
    }
  });
});
