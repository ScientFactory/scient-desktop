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
import { loadMcpBridge } from "./mcpBridge.testkit.ts";

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
  // Execute the shipped extension with MCP disabled; this path needs no Typebox.
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
    // Frontmatter parsing belongs to Pi. These fixtures contain only skill bodies.
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
  it("keeps orchestration direct and optional bridge tools discoverable on modern Pi", async () => {
    const bridge = await loadMcpBridge({ modern: true, toolSearchAvailable: true });
    await bridge.handlers.get("session_start")!(
      { systemPrompt: "" },
      { ui: { notify: () => undefined } },
    );
    const start = bridge.handlers.get("before_agent_start");
    assert.isDefined(start);
    const prompt = await start!(
      { systemPrompt: "Pi system prompt" },
      { ui: { notify: () => undefined } },
    );
    assert.include(prompt.systemPrompt, "orchestrator_capabilities");
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
        await start!({ systemPrompt: "Pi system prompt" }, { ui: { notify: () => undefined } });
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
      { ui: { notify: () => undefined } },
    );
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
      await bridge.handlers.get("session_start")!(
        { systemPrompt: "" },
        { ui: { notify: () => undefined } },
      );
      bridge.restoreActiveTools([
        "read",
        "mcp__t3-code__task_status",
        "mcp__t3-code__preview_snapshot",
      ]);
      const tree = bridge.handlers.get("session_tree");
      assert.isDefined(tree);
      await tree!({ systemPrompt: "" }, { ui: { notify: () => undefined } });
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
        // task_status acknowledges result delivery, and is intentionally not read-only.
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

    // An extension that replaces the search builtin is not known to be read-only.
    searchPath = "/extensions/custom-search.ts";
    const replaced = await toolCall!({ toolName: "tool_search", input: {} }, ctx);
    assert.equal(replaced?.block, true);
    assert.equal(confirmations.at(-1), "Allow tool_search?");
  });
});

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
    type Hook = (event: { systemPrompt: string }) => { systemPrompt: string };
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
    const prompt = hook({ systemPrompt: "Native model instructions" }).systemPrompt;
    assert.include(prompt, "Native model instructions\n\nScient orchestration guidance fixture");
    assert.equal(prompt.includes(hostInstructions), mcpAvailable);
    assert.notInclude(prompt, "T3 Code");
    assert.notInclude(prompt, "mcp__t3");
    assert.notInclude(prompt, "synthetic-token");
    assert.isUndefined(env.PI_RUNTIME_GUIDANCE);
    assert.isTrue(handlers.has("tool_call"));
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
    // Punctuation-adjacent references are plain text in the composer, not selected chips.
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
