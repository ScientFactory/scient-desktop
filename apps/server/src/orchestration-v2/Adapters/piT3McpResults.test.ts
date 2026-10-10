// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { makePiMcpExtensionSource } from "@t3tools/provider-pi/testing";
import { buildPiRuntimeGuidance } from "../../provider/PiDriverComposition.ts";
import { SCIENT_ORCHESTRATION_INSTRUCTIONS } from "../../provider/ScientProviderInstructions.ts";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Tool = {
  name: string;
  execute: (
    id: string,
    args: unknown,
  ) => Promise<{ content: Content[]; details: unknown; isError?: boolean }>;
};
type ToolHook = (
  event: { toolName: string; input: unknown },
  context: { hasUI: boolean; ui: { confirm: () => Promise<boolean> } },
) => Promise<unknown>;
type ExtensionHook = (event: unknown, context?: unknown) => unknown;
const decodeGuidance = Schema.decodeUnknownSync(Schema.Struct({ systemPrompt: Schema.String }));

/** Only Pi's extension API and the MCP HTTP peer are substituted. */
async function loadBridge(result: unknown, mode = "full-access") {
  const tools = new Map<string, Tool>();
  let hook: ToolHook | undefined;
  let guidance: ExtensionHook | undefined;
  let extension = makePiMcpExtensionSource(SCIENT_ORCHESTRATION_INSTRUCTIONS);
  for (const declaration of [
    'import { stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";',
    'import * as NodeFSP from "node:fs/promises";',
    'import * as NodePath from "node:path";',
    'import { Type } from "typebox";',
  ]) {
    expect(extension.split(declaration)).toHaveLength(2);
    extension = extension.replace(declaration, "");
  }
  const source = NodeModule.stripTypeScriptTypes(
    extension.replace("export default async function", "async function"),
  );
  const runtimeGuidance = buildPiRuntimeGuidance(new Set(["preview"]));
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    AbortSignal,
    TextDecoder,
    TextEncoder,
    NodeFSP,
    NodePath,
    stripFrontmatter: () => {
      throw new Error("The MCP result fixture must not read native skill files.");
    },
    Type: { Unsafe: (schema: unknown) => schema },
    process: {
      env: {
        T3_MCP_URL: "http://127.0.0.1/mcp",
        T3_MCP_BEARER_TOKEN: "synthetic",
        T3_PI_RUNTIME_MODE: mode,
        PI_RUNTIME_GUIDANCE: runtimeGuidance,
      },
    },
    pi: {
      on: (name: string, handler: ExtensionHook) => {
        if (name === "tool_call")
          hook = (event, context) => Promise.resolve(handler(event, context));
        if (name === "before_agent_start") guidance = handler;
      },
      registerCommand: () => undefined,
      registerTool: (tool: Tool) => tools.set(tool.name, tool),
    },
    fetch: async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { id: number; method: string };
      if (request.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      const response =
        request.method === "initialize"
          ? { protocolVersion: "2025-06-18" }
          : request.method === "tools/list"
            ? {
                tools: [
                  { name: "scient_fixture", inputSchema: { type: "object" } },
                  { name: "preview_status", inputSchema: { type: "object" } },
                ],
              }
            : result;
      return Response.json({ jsonrpc: "2.0", id: request.id, result: response });
    },
  });
  const tool = tools.get("scient_fixture");
  if (!tool || !hook || !guidance)
    throw new Error("Native bridge did not register its tool and permission hook.");
  expect([...tools.keys()]).toEqual(["scient_fixture", "preview_status"]);
  const systemPrompt = decodeGuidance(
    guidance({ systemPrompt: "Base system prompt" }),
  ).systemPrompt;
  expect(systemPrompt).toBe(
    ["Base system prompt", runtimeGuidance, SCIENT_ORCHESTRATION_INSTRUCTIONS.trim()].join("\n\n"),
  );
  return { execute: () => tool.execute("call-1", {}), hook };
}

describe("native Pi MCP result fidelity", () => {
  it.each(
    [
      {
        type: "resource_link",
        uri: "file:///fixture/report.pdf",
        name: "report.pdf",
        description: "Synthetic report",
      },
      {
        type: "resource",
        resource: {
          uri: "fixture://report",
          mimeType: "text/plain",
          text: "Synthetic resource text",
        },
      },
      {
        type: "resource",
        resource: { uri: "fixture://binary", mimeType: "application/pdf", blob: "cGRm" },
      },
    ].map((block) => ({
      caseTitle: `exposes ${block.type} model content while retaining the complete native result`,
      block,
    })),
  )("$caseTitle", async ({ block }) => {
    const result = { content: [block] };
    const bridge = await loadBridge(result);
    const actual = await bridge.execute();
    expect(actual.details).toEqual({ server: "scient", tool: "scient_fixture", result });
    expect(actual.content).toHaveLength(1);
    const text = actual.content[0];
    expect(text?.type).toBe("text");
    if (text?.type !== "text") throw new Error("Resource information must reach the model");
    expect(text.text).toContain(block.uri ?? block.resource?.uri);
    if (block.name) expect(text.text).toContain(block.name);
    if (block.resource?.text) expect(text.text).toContain(block.resource.text);
    if (block.resource?.blob) expect(text.text).not.toContain(block.resource.blob);
  });

  it("keeps mixed text, images and bounded resource text without duplicating structured snapshots", async () => {
    const text = { type: "text", text: "Useful summary" };
    const image = { type: "image", data: "cG5n", mimeType: "image/png" };
    const result = {
      content: [
        text,
        image,
        { type: "resource", resource: { uri: "fixture://large", text: "x".repeat(50_000) } },
        { type: "resource_link", uri: "fixture://overflow", name: "overflow" },
      ],
      structuredContent: { snapshot: "snapshot-must-not-be-duplicated" },
    };
    const actual = await (await loadBridge(result)).execute();
    expect(actual.content.slice(0, 2)).toEqual([text, image]);
    expect(actual.content).toHaveLength(3);
    const resource = actual.content[2];
    if (resource?.type !== "text") throw new Error("Expected bounded resource text");
    expect(resource.text).toContain("fixture://large");
    expect(resource.text.length).toBeLessThanOrEqual(12_000);
    expect(resource.text).not.toContain(result.structuredContent.snapshot);
    expect(actual.details).toEqual({ server: "scient", tool: "scient_fixture", result });
  });

  it("keeps MCP images and complete metadata in native tool details", async () => {
    const image = { type: "image", data: "cG5n", mimeType: "image/png" };
    const result = { content: [image], structuredContent: { width: 12, height: 8 } };
    const bridge = await loadBridge(result);
    expect(await bridge.execute()).toEqual({
      content: [image],
      details: { server: "scient", tool: "scient_fixture", result },
    });
  });

  it("marks MCP failures without duplicating their structured details", async () => {
    const result = {
      content: [{ type: "text", text: "The operation failed." }],
      structuredContent: { error: { _tag: "FixtureError" } },
      isError: true,
    };
    const bridge = await loadBridge(result);
    expect(await bridge.execute()).toEqual({
      content: result.content,
      details: { server: "scient", tool: "scient_fixture", result },
      isError: true,
    });
  });

  it("keeps bounded browser content model-facing and full metadata in native details", async () => {
    const result = {
      content: [
        { type: "text", text: "bounded snapshot" },
        { type: "image", data: "cG5n", mimeType: "image/png" },
      ],
      structuredContent: {
        visibleText: "x".repeat(100_000),
        accessibilityTree: { nodes: Array.from({ length: 2000 }, (_, index) => ({ index })) },
      },
    };
    const bridge = await loadBridge(result);
    expect(await bridge.execute()).toEqual({
      content: result.content,
      details: { server: "scient", tool: "scient_fixture", result },
    });
  });

  it("renders structured-only MCP results once", async () => {
    const result = { content: [], structuredContent: { answer: "ready" } };
    const bridge = await loadBridge(result);
    expect((await bridge.execute()).content).toEqual([
      { type: "text", text: JSON.stringify(result.structuredContent) },
    ]);
  });

  it.each(
    (
      [
        ["approval-required", "edit", true, false, true],
        ["auto-accept-edits", "edit", true, false, false],
        ["auto-accept-edits", "bash", true, false, true],
        ["auto-accept-edits", "scient_fixture", true, true, false],
        ["approval-required", "bash", false, true, true],
        ["full-access", "bash", false, false, false],
      ] as const
    ).map(([mode, toolName, hasUI, accepted, blocked]) => ({
      caseTitle: `${mode} enforces native ${toolName} permission with UI=${hasUI} and accepted=${accepted}`,
      mode,
      toolName,
      hasUI,
      accepted,
      blocked,
    })),
  )("$caseTitle", async ({ mode, toolName, hasUI, accepted, blocked }) => {
    const bridge = await loadBridge({}, mode);
    let confirmations = 0;
    const decision = await bridge.hook(
      { toolName, input: { command: "fixture" } },
      {
        hasUI,
        ui: {
          confirm: async () => {
            confirmations++;
            return accepted;
          },
        },
      },
    );
    expect(decision !== undefined).toBe(blocked);
    if (!hasUI) expect(confirmations).toBe(0);
  });
});
