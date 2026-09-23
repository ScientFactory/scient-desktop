import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";
import { piScientExtensionSource } from "./PiScientExtension.ts";

type PiContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };
type PiToolResult = { readonly content: ReadonlyArray<PiContent>; readonly details: unknown };
type RegisteredTool = {
  readonly name: string;
  readonly execute: (id: string, args: unknown) => Promise<PiToolResult>;
};
type ExtensionEvent =
  | { readonly systemPrompt: string }
  | { readonly toolName: string; readonly details?: unknown };

const runTool = async (toolResult: Record<string, unknown>) => {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, (event: ExtensionEvent) => unknown>();
  const pi = {
    on: (event: string, handler: (event: ExtensionEvent) => unknown) => {
      handlers.set(event, handler);
    },
    registerCommand: vi.fn(),
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
  };
  const fetch = async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as {
      readonly id?: number;
      readonly method: string;
    };
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result =
      request.method === "initialize"
        ? { protocolVersion: "2025-06-18" }
        : request.method === "tools/list"
          ? { tools: [{ name: "scient_fixture", inputSchema: { type: "object" } }] }
          : toolResult;
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  };
  const install = NodeVM.runInNewContext(
    "(" +
      piScientExtensionSource()
        .replace(/^export default /u, "")
        .replace(/;\s*$/u, "") +
      ")",
    {
      AbortSignal,
      TextDecoder,
      fetch,
      process: {
        env: {
          SCIENT_PI_MCP_ENDPOINT: "http://127.0.0.1/mcp",
          SCIENT_PI_MCP_AUTHORIZATION: "Bearer synthetic-only",
        },
      },
    },
  ) as (runtime: typeof pi) => Promise<void>;
  await install(pi);

  const tool = tools.get("scient_fixture");
  if (!tool) throw new Error("Synthetic Scient tool was not registered.");
  const result = await tool.execute("call-1", {});
  return { result, toolResultHandler: handlers.get("tool_result") };
};

it("uses MCP text content without appending duplicate structured content", async () => {
  const output = {
    content: [{ type: "text", text: '{"answer":"ready"}' }],
    structuredContent: { answer: "ready" },
  };

  const { result } = await runTool(output);

  expect(result.content).toEqual(output.content);
  expect(result.details).toEqual(output);
});

it("renders structured-only results as text", async () => {
  const structuredContent = { answer: "ready", count: 2 };

  const { result } = await runTool({ content: [], structuredContent });

  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(structuredContent) }]);
  expect(result.details).toEqual({ content: [], structuredContent });
});

it("keeps image content and complete metadata in tool details", async () => {
  const image = {
    type: "image",
    data: "cG5n",
    mimeType: "image/png",
  };
  const structuredContent = { screenshot: { mimeType: "image/png", width: 12, height: 8 } };

  const { result } = await runTool({ content: [image], structuredContent });

  expect(result.content).toEqual([image]);
  expect(result.details).toEqual({ content: [image], structuredContent });
});

it("marks error results without duplicating their structured error details", async () => {
  const output = {
    content: [{ type: "text", text: "The operation failed." }],
    structuredContent: { error: { _tag: "FixtureError" } },
    isError: true,
  };

  const { result, toolResultHandler } = await runTool(output);

  expect(result.content).toEqual([
    { type: "text", text: "Scient tool reported an error:" },
    ...output.content,
  ]);
  expect(result.details).toEqual(output);
  expect(toolResultHandler?.({ toolName: "scient_fixture", details: result.details })).toEqual({
    isError: true,
  });
});

it("keeps bounded browser snapshot content model-facing and full metadata in details", async () => {
  const boundedSnapshotText = JSON.stringify({
    visibleText: "x".repeat(8_000),
    interactiveElements: [{ role: "button", name: "Continue" }],
  });
  const output = {
    content: [
      { type: "text", text: '{"url":"https://example.test/"}' },
      { type: "text", text: boundedSnapshotText },
      { type: "text", text: "Snapshot text was bounded. Omitted: accessibilityTree." },
      { type: "image", data: "cG5n", mimeType: "image/png" },
    ],
    structuredContent: {
      url: "https://example.test/",
      visibleText: "x".repeat(100_000),
      accessibilityTree: { nodes: Array.from({ length: 2_000 }, (_, index) => ({ index })) },
      screenshot: { mimeType: "image/png", width: 1206, height: 2622 },
    },
  };

  expect(Buffer.byteLength(boundedSnapshotText, "utf8")).toBeLessThanOrEqual(60_000);
  const { result } = await runTool(output);

  expect(result.content).toEqual(output.content);
  expect(result.details).toEqual(output);
  expect(result.content).not.toContainEqual({
    type: "text",
    text: JSON.stringify(output.structuredContent),
  });
});
