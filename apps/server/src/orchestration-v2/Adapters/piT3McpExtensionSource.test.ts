import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import { PI_T3_MCP_EXTENSION_SOURCE } from "./piT3McpExtensionSource.ts";

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

async function loadRequestHook(): Promise<RequestHook> {
  const handlers = new Map<string, RequestHook>();
  // Execute the shipped extension with MCP disabled; this path needs no Typebox.
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: {} },
    pi: { on: (name: string, handler: RequestHook) => handlers.set(name, handler) },
  });
  const hook = handlers.get("before_provider_request");
  assert.isDefined(hook);
  return hook!;
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
        pi: { on: (name: string, handler: Hook) => handlers.set(name, handler) },
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
