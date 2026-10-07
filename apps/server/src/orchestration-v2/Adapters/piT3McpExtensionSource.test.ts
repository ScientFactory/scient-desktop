import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import type { piContextExtension } from "../../provider/pi/PiContextExtension.ts";
import { PI_T3_MCP_EXTENSION_SOURCE } from "./piT3McpExtensionSource.ts";
import { buildPiRpcLaunch, materializePiT3McpExtension } from "./piT3McpInjection.ts";

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
    source
      .replace('import { Type } from "typebox";', "")
      .replace("export default async function", "async function"),
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
      for (const handler of handlers.get("input") ?? []) handler({ payload: undefined }, ctx);
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
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    it(`caps ${key} without changing the conversation or tools`, async () => {
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
    });
  }

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
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const) {
    it(`bounds ${key} from final instructions and tools without deleting input`, async () => {
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
  }

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
  for (const mcpAvailable of [false, true]) {
    it(`appends exact awareness through before_agent_start with MCP ${mcpAvailable}`, async () => {
      type Hook = (event: { systemPrompt: string }) => { systemPrompt: string };
      const handlers = new Map<string, Hook>();
      const capabilities = mcpAvailable
        ? new Set(["documents:build", "compute:inventory", "skills:read"] as const)
        : undefined;
      const env: Record<string, string> = {
        SCIENT_PI_AWARENESS: buildScientAwareness(capabilities),
        ...(mcpAvailable
          ? { T3_MCP_URL: "http://127.0.0.1:43123/mcp", T3_MCP_BEARER_TOKEN: "synthetic-token" }
          : {}),
      };
      const source = NodeModule.stripTypeScriptTypes(
        PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
          "export default async function",
          "async function",
        ),
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
      assert.include(prompt, `Native model instructions\n\n${buildScientAwareness(capabilities)}`);
      assert.equal(prompt.includes("scient_pdf_build"), mcpAvailable);
      assert.equal(prompt.includes("scient_skill_load"), mcpAvailable);
      assert.notInclude(prompt, "preview_status");
      assert.notInclude(prompt, "device_list");
      assert.notInclude(prompt, "synthetic-token");
      assert.isUndefined(env.SCIENT_PI_AWARENESS);
      assert.isTrue(handlers.has("tool_call"));
      if (!mcpAvailable) assert.notInclude(prompt, "delegate_task");
    });
  }
});
