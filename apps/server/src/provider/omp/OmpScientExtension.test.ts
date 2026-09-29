// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ompCustomModelsExtensionSource } from "./OmpCustomModels.ts";
import { ompScientExtensionSource } from "./OmpScientExtension.ts";

type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };
type ToolResult = { readonly content: ReadonlyArray<Content>; readonly details: unknown };
type RegisteredTool = {
  readonly name: string;
  readonly loadMode?: string;
  readonly execute: (id: string, args: unknown) => Promise<ToolResult>;
};
type Handler = (event: never) => unknown;
type McpRequest = {
  readonly id?: number;
  readonly method: string;
  readonly params?: { readonly clientInfo?: { readonly name?: string } };
};

/** A fresh OMP-like extension API that records what the extension registers. */
const makeApi = () => {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Handler>();
  const providers = new Map<string, Record<string, unknown>>();
  const commands = new Map<string, { readonly description: string }>();
  return {
    tools,
    handlers,
    providers,
    commands,
    api: {
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      registerCommand: (name: string, command: { readonly description: string }) =>
        commands.set(name, command),
      registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
      registerProvider: (name: string, config: Record<string, unknown>) =>
        providers.set(name, config),
      unregisterProvider: (name: string) => providers.delete(name),
    },
  };
};

const roots: Array<string> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

/** Writes an extension and its bootstrap like Scient does, then imports it. */
const loadExtension = async (
  source: (bootstrapPath: string) => string,
  bootstrap: Record<string, unknown> | undefined,
) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-extension-"));
  roots.push(root);
  const bootstrapPath = NodePath.join(root, "extension.bootstrap.json");
  const extensionPath = NodePath.join(root, "extension.mjs");
  if (bootstrap) NodeFS.writeFileSync(bootstrapPath, JSON.stringify(bootstrap), { mode: 0o600 });
  const text = source(bootstrapPath);
  NodeFS.writeFileSync(extensionPath, text, { mode: 0o600 });
  // OMP imports each load under a new specifier; so does this.
  let loads = 0;
  const importFresh = async () =>
    (
      (await import(
        /* @vite-ignore */ `${NodeURL.pathToFileURL(extensionPath).href}?load=${++loads}`
      )) as { readonly default: (api: unknown) => Promise<void> }
    ).default;
  return { bootstrapPath, source: text, importFresh };
};

/** A synthetic Scient MCP endpoint. */
const stubMcp = (toolResult: Record<string, unknown> = { content: [] }) => {
  const requests: Array<{ readonly body: McpRequest; readonly authorization: string | null }> = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as McpRequest;
    requests.push({ body, authorization: new Headers(init?.headers).get("authorization") });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-06-18" }
        : body.method === "tools/list"
          ? { tools: [{ name: "scient_fixture", inputSchema: { type: "object" } }] }
          : toolResult;
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  });
  return requests;
};

const SESSION = {
  endpoint: "http://127.0.0.1/mcp",
  authorization: "Bearer synthetic-omp",
  awareness: "## Scient\nsynthetic awareness",
};

describe("Scient's Oh My Pi extension", () => {
  it("registers essential tools through the session's bearer and consumes its bootstrap", async () => {
    const requests = stubMcp({ content: [{ type: "text", text: "ok" }] });
    const extension = await loadExtension(ompScientExtensionSource, SESSION);
    // The module names its bootstrap; it holds no secret itself.
    expect(extension.source).not.toContain("synthetic-omp");
    expect(extension.source).not.toContain("127.0.0.1");
    const host = makeApi();

    await (
      await extension.importFresh()
    )(host.api);

    expect(NodeFS.existsSync(extension.bootstrapPath)).toBe(false);
    expect(host.tools.get("scient_fixture")?.loadMode).toBe("essential");
    expect(requests[0]?.body.params?.clientInfo?.name).toBe("scient-omp");
    const result = await host.tools.get("scient_fixture")!.execute("call-1", {});
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(requests.map(({ body }) => body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(requests.every(({ authorization }) => authorization === SESSION.authorization)).toBe(
      true,
    );
    expect(host.commands.get("scient-status")?.description).toBe(
      "Show the Scient connection for this Oh My Pi session",
    );
  });

  it("gives a subagent's re-run the same tools over the one connection", async () => {
    const requests = stubMcp({ content: [{ type: "text", text: "child" }] });
    const extension = await loadExtension(ompScientExtensionSource, SESSION);
    const parent = makeApi();
    const child = makeApi();

    await (
      await extension.importFresh()
    )(parent.api);
    // OMP re-imports and re-runs the extension for an in-process subagent,
    // after the bootstrap is gone.
    await (
      await extension.importFresh()
    )(child.api);

    expect(child.tools.get("scient_fixture")?.loadMode).toBe("essential");
    expect(requests.filter(({ body }) => body.method === "initialize")).toHaveLength(1);
    expect(requests.filter(({ body }) => body.method === "tools/list")).toHaveLength(1);
    const result = await child.tools.get("scient_fixture")!.execute("call-2", {});
    expect(result.content).toEqual([{ type: "text", text: "child" }]);
    expect(
      (child.handlers.get("before_agent_start") as Handler | undefined)?.({
        systemPrompt: ["subagent"],
      } as never),
    ).toEqual({ systemPrompt: ["subagent", SESSION.awareness] });
  });

  it("appends awareness as one more system prompt element", async () => {
    const requests = stubMcp();
    const extension = await loadExtension(ompScientExtensionSource, {
      endpoint: null,
      authorization: null,
      awareness: SESSION.awareness,
    });
    const host = makeApi();
    await (
      await extension.importFresh()
    )(host.api);
    const hook = host.handlers.get("before_agent_start") as Handler | undefined;

    expect(hook?.({ systemPrompt: ["base", "project rules"] } as never)).toEqual({
      systemPrompt: ["base", "project rules", SESSION.awareness],
    });
    // No endpoint means no Scient tool connection, but awareness still applies.
    expect(host.tools.size).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("leaves the system prompt untouched without awareness", async () => {
    stubMcp();
    const extension = await loadExtension(ompScientExtensionSource, {
      endpoint: null,
      authorization: null,
      awareness: "",
    });
    const host = makeApi();
    await (
      await extension.importFresh()
    )(host.api);
    const hook = host.handlers.get("before_agent_start") as Handler | undefined;

    expect(hook?.({ systemPrompt: ["base"] } as never)).toEqual({ systemPrompt: undefined });
  });

  it("fails to load without its bootstrap, on every run", async () => {
    stubMcp();
    const extension = await loadExtension(ompScientExtensionSource, undefined);

    await expect((await extension.importFresh())(makeApi().api)).rejects.toThrow(
      "Scient's Oh My Pi bootstrap is unavailable.",
    );
    await expect((await extension.importFresh())(makeApi().api)).rejects.toThrow(
      "Scient's Oh My Pi bootstrap is unavailable.",
    );
  });

  describe("tool results", () => {
    const run = async (toolResult: Record<string, unknown>) => {
      stubMcp(toolResult);
      const extension = await loadExtension(ompScientExtensionSource, SESSION);
      const host = makeApi();
      await (
        await extension.importFresh()
      )(host.api);
      const result = await host.tools.get("scient_fixture")!.execute("call-1", {});
      return { result, toolResultHandler: host.handlers.get("tool_result") };
    };

    it("uses MCP text content without appending duplicate structured content", async () => {
      const output = {
        content: [{ type: "text", text: '{"answer":"ready"}' }],
        structuredContent: { answer: "ready" },
      };
      const { result } = await run(output);
      expect(result.content).toEqual(output.content);
      expect(result.details).toEqual(output);
    });

    it("renders structured-only results as text", async () => {
      const structuredContent = { answer: "ready", count: 2 };
      const { result } = await run({ content: [], structuredContent });
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(structuredContent) }]);
    });

    it("keeps image content", async () => {
      const image = { type: "image", data: "cG5n", mimeType: "image/png" };
      const { result } = await run({ content: [image] });
      expect(result.content).toEqual([image]);
    });

    it("marks error results", async () => {
      const output = {
        content: [{ type: "text", text: "The operation failed." }],
        isError: true,
      };
      const { result, toolResultHandler } = await run(output);
      expect(result.content).toEqual([
        { type: "text", text: "Scient tool reported an error:" },
        ...output.content,
      ]);
      expect(
        (toolResultHandler as Handler | undefined)?.({
          toolName: "scient_fixture",
          details: result.details,
        } as never),
      ).toEqual({ isError: true });
    });
  });
});

/** A synthetic custom-model endpoint whose long-poll holds until aborted. */
const stubModels = (connections: ReadonlyArray<Record<string, unknown>>) => {
  const requests: Array<{ readonly path: string; readonly body?: unknown }> = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const path = String(input).replace("http://127.0.0.1:1/models", "");
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ path, ...(body === undefined ? {} : { body }) });
    if (path === "") return Response.json({ generation: 1, connections });
    if (path === "/applied") return new Response(null, { status: 204 });
    return await new Promise<Response>((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  });
  return requests;
};

const connection = (apiKey: string) => ({
  id: "scient_stub",
  name: "Stub",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:2/v1",
  apiKey,
  models: [{ id: "stub-model" }],
});

describe("Scient's Oh My Pi custom-model extension", () => {
  it("registers literal keys, and a re-run replays them without another refresh loop", async () => {
    const requests = stubModels([connection("scient-model-key-1")]);
    const extension = await loadExtension(ompCustomModelsExtensionSource, {
      url: "http://127.0.0.1:1/models",
      token: "synthetic-models-token",
      keys: { "scient-model-key-1": "sk-synthetic" },
    });
    expect(extension.source).not.toContain("sk-synthetic");
    expect(extension.source).not.toContain("synthetic-models-token");
    const parent = makeApi();
    const child = makeApi();

    await (
      await extension.importFresh()
    )(parent.api);
    expect(NodeFS.existsSync(extension.bootstrapPath)).toBe(false);
    expect(parent.providers.get("scient_stub")).toMatchObject({ apiKey: "sk-synthetic" });
    await vi.waitFor(() => expect(requests.map(({ path }) => path)).toContain("/wait?after=1"));

    await (
      await extension.importFresh()
    )(child.api);

    expect(child.providers.get("scient_stub")).toEqual(parent.providers.get("scient_stub"));
    expect(child.commands.size).toBe(0);
    expect(child.handlers.size).toBe(0);
    expect(requests.map(({ path }) => path)).toEqual(["", "/applied", "/wait?after=1"]);
    expect(requests[1]?.body).toEqual({ generation: 1 });
    (parent.handlers.get("session_shutdown") as (() => void) | undefined)?.();
  });

  it.each([
    ["starts with !", "!cat ~/.ssh/id_rsa", "starts with ! as a command"],
    ["names an environment variable", "PATH", "names an environment variable"],
  ])("refuses a key that %s instead of letting OMP resolve it", async (_label, key, detail) => {
    const requests = stubModels([connection("scient-model-key-1")]);
    const extension = await loadExtension(ompCustomModelsExtensionSource, {
      url: "http://127.0.0.1:1/models",
      token: "synthetic-models-token",
      keys: { "scient-model-key-1": key },
    });
    const host = makeApi();

    await expect((await extension.importFresh())(host.api)).rejects.toThrow(detail);

    expect(host.providers.size).toBe(0);
    expect(requests[1]).toMatchObject({
      path: "/applied",
      body: { generation: 1, error: expect.stringContaining(detail) },
    });
  });
});
