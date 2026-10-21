// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ompCustomModelsExtensionSource } from "./OmpCustomModels.ts";
import { ompScientExtensionSource } from "./OmpScientExtension.ts";
import { ompTarget } from "./OmpTarget.ts";

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
    const extension = await loadExtension(
      (bootstrapPath) => ompScientExtensionSource(ompTarget, bootstrapPath),
      SESSION,
    );
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
    const extension = await loadExtension(
      (bootstrapPath) => ompScientExtensionSource(ompTarget, bootstrapPath),
      SESSION,
    );
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
    const extension = await loadExtension(
      (bootstrapPath) => ompScientExtensionSource(ompTarget, bootstrapPath),
      {
        endpoint: null,
        authorization: null,
        awareness: SESSION.awareness,
      },
    );
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
    const extension = await loadExtension(
      (bootstrapPath) => ompScientExtensionSource(ompTarget, bootstrapPath),
      {
        endpoint: null,
        authorization: null,
        awareness: "",
      },
    );
    const host = makeApi();
    await (
      await extension.importFresh()
    )(host.api);
    const hook = host.handlers.get("before_agent_start") as Handler | undefined;

    expect(hook?.({ systemPrompt: ["base"] } as never)).toEqual({ systemPrompt: undefined });
  });

  it("fails to load without its bootstrap, on every run", async () => {
    stubMcp();
    const extension = await loadExtension(
      (bootstrapPath) => ompScientExtensionSource(ompTarget, bootstrapPath),
      undefined,
    );

    await expect((await extension.importFresh())(makeApi().api)).rejects.toThrow(
      "Scient's Oh My Pi bootstrap is unavailable.",
    );
    await expect((await extension.importFresh())(makeApi().api)).rejects.toThrow(
      "Scient's Oh My Pi bootstrap is unavailable.",
    );
  });

  describe("connectors", () => {
    const GITHUB = "http://127.0.0.1/mcp/connectors/connector-github";
    const LINEAR = "http://127.0.0.1/mcp/connectors/connector-linear";
    const BROKEN = "http://127.0.0.1/mcp/connectors/connector-broken";
    const CONNECTED = {
      ...SESSION,
      connectors: [
        { serverName: "github", displayName: "GitHub", url: GITHUB },
        { serverName: "linear", displayName: "Linear", url: LINEAR },
      ],
    };

    /** Scient's endpoint plus one synthetic MCP server per connector URL; a catalog for
     * Scient's endpoint replaces its default `scient_fixture`. */
    const stubServers = (catalogs: Record<string, ReadonlyArray<string> | "fail">) => {
      const requests: Array<{
        readonly url: string;
        readonly body: McpRequest & { readonly params?: { readonly name?: string } };
        readonly authorization: string | null;
      }> = [];
      vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body)) as McpRequest & {
          readonly params?: { readonly name?: string };
        };
        requests.push({
          url,
          body,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        const catalog =
          catalogs[url] ?? (url === SESSION.endpoint ? ["scient_fixture"] : undefined);
        if (catalog === undefined || catalog === "fail") return new Response(null, { status: 502 });
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        const result =
          body.method === "initialize"
            ? { protocolVersion: "2025-06-18" }
            : body.method === "tools/list"
              ? { tools: catalog.map((name) => ({ name, inputSchema: { type: "object" } })) }
              : {
                  content: [{ type: "text", text: `${url} ran ${body.params?.name}` }],
                  ...(body.params?.name === "fails" ? { isError: true } : {}),
                };
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      });
      return requests;
    };

    const status = async (host: { readonly commands: ReadonlyMap<string, unknown> }) => {
      const notices: Array<string> = [];
      const command = host.commands.get("scient-status") as {
        readonly handler: (
          args: string,
          ctx: { readonly ui: { readonly notify: (text: string) => void } },
        ) => Promise<void>;
      };
      await command.handler("", { ui: { notify: (text) => notices.push(text) } });
      return notices;
    };

    it("registers each connector's tools under its server name and calls them through the session bearer", async () => {
      const requests = stubServers({ [GITHUB]: ["search.issues", "fails"], [LINEAR]: ["list"] });
      const extension = await loadExtension(
        (bootstrapPath) => ompScientExtensionSource(ompTarget, bootstrapPath),
        CONNECTED,
      );
      // Connector endpoints, like the bearer, stay in the bootstrap.
      expect(extension.source).not.toContain("/mcp/connectors/");
      const host = makeApi();

      await (
        await extension.importFresh()
      )(host.api);

      expect([...host.tools.keys()]).toEqual([
        "scient_fixture",
        "github__search_issues",
        "github__fails",
        "linear__list",
      ]);
      expect([...host.tools.values()].every((tool) => tool.loadMode === "essential")).toBe(true);
      const result = await host.tools.get("github__search_issues")!.execute("call-1", {});
      expect(result.content).toEqual([{ type: "text", text: `${GITHUB} ran search.issues` }]);
      expect((await host.tools.get("linear__list")!.execute("call-2", {})).content).toEqual([
        { type: "text", text: `${LINEAR} ran list` },
      ]);
      expect((await host.tools.get("scient_fixture")!.execute("call-3", {})).content).toEqual([
        { type: "text", text: `${SESSION.endpoint} ran scient_fixture` },
      ]);
      const failed = await host.tools.get("github__fails")!.execute("call-4", {});
      expect(failed.content[0]).toEqual({
        type: "text",
        text: 'Connector "GitHub" tool reported an error:',
      });
      expect(
        (host.handlers.get("tool_result") as Handler | undefined)?.({
          toolName: "github__fails",
          details: failed.details,
        } as never),
      ).toEqual({ isError: true });
      expect(new Set(requests.map(({ url }) => url))).toEqual(
        new Set([SESSION.endpoint, GITHUB, LINEAR]),
      );
      expect(requests.every(({ authorization }) => authorization === SESSION.authorization)).toBe(
        true,
      );
      expect(await status(host)).toEqual([
        "Scient connected: 1 tools. Full access; no native sandbox. GitHub: 2 tools. Linear: 1 tools.",
      ]);
    });

    it("keeps Scient's tools and the other connectors when one connector fails", async () => {
      stubServers({ [GITHUB]: ["search"], [BROKEN]: "fail" });
      const extension = await loadExtension(
        (bootstrapPath) => ompScientExtensionSource(ompTarget, bootstrapPath),
        {
          ...SESSION,
          connectors: [
            { serverName: "broken", displayName: "Broken", url: BROKEN },
            { serverName: "github", displayName: "GitHub", url: GITHUB },
          ],
        },
      );
      const host = makeApi();

      await (
        await extension.importFresh()
      )(host.api);

      expect([...host.tools.keys()]).toEqual(["scient_fixture", "github__search"]);
      expect(await status(host)).toEqual([
        "Scient connected: 1 tools. Full access; no native sandbox. Broken: unavailable. GitHub: 1 tools.",
      ]);
    });

    const calledTools = (
      requests: ReadonlyArray<{
        readonly url: string;
        readonly body: { readonly method: string; readonly params?: { readonly name?: string } };
      }>,
    ) =>
      requests
        .filter(({ body }) => body.method === "tools/call")
        .map(({ url, body }) => [url, body.params?.name]);

    it("aliases connector tool names that collide or run too long, and skips OMP's MCP namespace", async () => {
      const requests = stubServers({
        [GITHUB]: ["ok", "a.b", "a_b", "_x", "x".repeat(60)],
        [LINEAR]: ["x", "list"],
        [BROKEN]: ["native"],
      });
      const extension = await loadExtension(
        (bootstrapPath) => ompScientExtensionSource(ompTarget, bootstrapPath),
        {
          ...SESSION,
          connectors: [
            { serverName: "github", displayName: "GitHub", url: GITHUB },
            // "github" + "__" + "_x" and "github_" + "__" + "x" both make "github___x".
            { serverName: "github_", displayName: "Shadow", url: LINEAR },
            { serverName: "mcp", displayName: "Native", url: BROKEN },
          ],
        },
      );
      const host = makeApi();

      await (
        await extension.importFresh()
      )(host.api);

      // "a.b" becomes "github__a_b", so the later "a_b" takes a hashed alias, as do
      // the 68-character name and the later "github___x".
      expect([...host.tools.keys()]).toEqual([
        "scient_fixture",
        "github__ok",
        "github__a_b",
        "github__a_b_44fdc099",
        "github___x",
        "github__xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_592e2afd",
        "github___x_4b9a77d4",
        "github___list",
      ]);
      expect(await status(host)).toEqual([
        "Scient connected: 1 tools. Full access; no native sandbox. GitHub: 5 tools. Shadow: 2 tools. Native: 0 tools (1 omitted: name unusable).",
      ]);
      await host.tools.get("github__a_b_44fdc099")!.execute("call-1", {});
      await host.tools
        .get("github__xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_592e2afd")!
        .execute("call-2", {});
      await host.tools.get("github___x_4b9a77d4")!.execute("call-3", {});
      expect(calledTools(requests)).toEqual([
        [GITHUB, "a_b"],
        [GITHUB, "x".repeat(60)],
        [LINEAR, "x"],
      ]);
    });

    it("gives long names distinct deterministic aliases that call the connector's own tools", async () => {
      const server = "k".repeat(44);
      const first = `search_documents_${"a".repeat(47)}`;
      const second = `search_documents_${"b".repeat(47)}`;
      const requests = stubServers({ [GITHUB]: [first, second] });
      const extension = await loadExtension(
        (bootstrapPath) => ompScientExtensionSource(ompTarget, bootstrapPath),
        { ...SESSION, connectors: [{ serverName: server, displayName: "Docs", url: GITHUB }] },
      );
      const host = makeApi();

      await (
        await extension.importFresh()
      )(host.api);

      const names = [...host.tools.keys()];
      expect(names).toEqual([
        "scient_fixture",
        `${server}__search_do_3ff089b7`,
        `${server}__search_do_73415594`,
      ]);
      for (const name of names) expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u);
      await host.tools.get(`${server}__search_do_73415594`)!.execute("call-1", {});
      await host.tools.get(`${server}__search_do_3ff089b7`)!.execute("call-2", {});
      expect(calledTools(requests)).toEqual([
        [GITHUB, second],
        [GITHUB, first],
      ]);
      expect(await status(host)).toEqual([
        "Scient connected: 1 tools. Full access; no native sandbox. Docs: 2 tools.",
      ]);
    });

    it("aliases a connector tool whose name a Scient tool already has", async () => {
      const requests = stubServers({
        [SESSION.endpoint]: ["scient_fixture", "github__search"],
        [GITHUB]: ["search"],
      });
      const extension = await loadExtension(
        (bootstrapPath) => ompScientExtensionSource(ompTarget, bootstrapPath),
        { ...SESSION, connectors: [{ serverName: "github", displayName: "GitHub", url: GITHUB }] },
      );
      const host = makeApi();

      await (
        await extension.importFresh()
      )(host.api);

      expect([...host.tools.keys()]).toEqual([
        "scient_fixture",
        "github__search",
        "github__search_6c8b0b27",
      ]);
      await host.tools.get("github__search_6c8b0b27")!.execute("call-1", {});
      await host.tools.get("github__search")!.execute("call-2", {});
      expect(calledTools(requests)).toEqual([
        [GITHUB, "search"],
        [SESSION.endpoint, "github__search"],
      ]);
    });

    it("skips a connector tool whose name and alias are both taken", async () => {
      stubServers({
        [SESSION.endpoint]: ["github__search", "github__search_6c8b0b27"],
        [GITHUB]: ["search", "list"],
      });
      const extension = await loadExtension(
        (bootstrapPath) => ompScientExtensionSource(ompTarget, bootstrapPath),
        { ...SESSION, connectors: [{ serverName: "github", displayName: "GitHub", url: GITHUB }] },
      );
      const host = makeApi();

      await (
        await extension.importFresh()
      )(host.api);

      expect([...host.tools.keys()]).toEqual([
        "github__search",
        "github__search_6c8b0b27",
        "github__list",
      ]);
      expect(await status(host)).toEqual([
        "Scient connected: 2 tools. Full access; no native sandbox. GitHub: 1 tools (1 omitted: name unusable).",
      ]);
    });

    it("starts a digit-led server's tool names with an underscore", async () => {
      const requests = stubServers({ [GITHUB]: ["item.get"] });
      const extension = await loadExtension(
        (bootstrapPath) => ompScientExtensionSource(ompTarget, bootstrapPath),
        {
          ...SESSION,
          connectors: [{ serverName: "1password", displayName: "1Password", url: GITHUB }],
        },
      );
      const host = makeApi();

      await (
        await extension.importFresh()
      )(host.api);

      expect([...host.tools.keys()]).toEqual(["scient_fixture", "_1password__item_get"]);
      await host.tools.get("_1password__item_get")!.execute("call-1", {});
      expect(calledTools(requests)).toEqual([[GITHUB, "item.get"]]);
    });

    it("gives a subagent's re-run the connector tools over the same connections", async () => {
      const requests = stubServers({ [GITHUB]: ["search"], [LINEAR]: ["list"] });
      const extension = await loadExtension(
        (bootstrapPath) => ompScientExtensionSource(ompTarget, bootstrapPath),
        CONNECTED,
      );
      const parent = makeApi();
      const child = makeApi();

      await (
        await extension.importFresh()
      )(parent.api);
      await (
        await extension.importFresh()
      )(child.api);

      expect([...child.tools.keys()]).toEqual(["scient_fixture", "github__search", "linear__list"]);
      expect(requests.filter(({ body }) => body.method === "initialize")).toHaveLength(3);
      expect((await child.tools.get("github__search")!.execute("call-1", {})).content).toEqual([
        { type: "text", text: `${GITHUB} ran search` },
      ]);
    });
  });

  describe("tool results", () => {
    const run = async (toolResult: Record<string, unknown>) => {
      stubMcp(toolResult);
      const extension = await loadExtension(
        (bootstrapPath) => ompScientExtensionSource(ompTarget, bootstrapPath),
        SESSION,
      );
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

  describe("event-stream responses", () => {
    /** Scient's endpoint answering every request as one event stream, framed by `frame`. */
    const stubEventStream = (
      frame: (message: string) => string,
      options: { readonly chunkSize?: number; readonly open?: boolean } = {},
    ) => {
      const cancelled: Array<string> = [];
      vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as McpRequest;
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        const result =
          body.method === "initialize"
            ? { protocolVersion: "2025-06-18" }
            : body.method === "tools/list"
              ? { tools: [{ name: "scient_fixture", inputSchema: { type: "object" } }] }
              : { content: [{ type: "text", text: "streamed" }] };
        const bytes = new TextEncoder().encode(
          frame(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }, null, 2)),
        );
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
              cancelled.push(body.method);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      return cancelled;
    };
    const dataLines = (message: string, eol: string) =>
      message
        .split("\n")
        .map((line) => `data: ${line}`)
        .join(eol);
    const callFixture = async () => {
      const extension = await loadExtension(
        (bootstrapPath) => ompScientExtensionSource(ompTarget, bootstrapPath),
        SESSION,
      );
      const host = makeApi();
      await (
        await extension.importFresh()
      )(host.api);
      return host.tools.get("scient_fixture")!.execute("call-1", {});
    };

    it("parses CR-only events on an open stream fed byte by byte", async () => {
      const cancelled = stubEventStream(
        (message) =>
          `: ping\r\r${dataLines(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message" }), "\r")}\r\r${dataLines(message, "\r")}\r\r`,
        { chunkSize: 1, open: true },
      );
      const result = await callFixture();
      expect(result.content).toEqual([{ type: "text", text: "streamed" }]);
      expect(cancelled).toEqual(["initialize", "tools/list", "tools/call"]);
    });

    it.each([
      ["no line break", ""],
      ["one LF", "\n"],
      ["one CRLF", "\r\n"],
    ])(
      "accepts a final event the stream ends without a blank line after (%s)",
      async (_name, end) => {
        stubEventStream((message) => `${dataLines(message, "\n")}${end}`, { chunkSize: 5 });
        const result = await callFixture();
        expect(result.content).toEqual([{ type: "text", text: "streamed" }]);
      },
    );
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
    const extension = await loadExtension(
      (bootstrapPath) => ompCustomModelsExtensionSource(ompTarget, bootstrapPath),
      {
        url: "http://127.0.0.1:1/models",
        token: "synthetic-models-token",
        keys: { "scient-model-key-1": "sk-synthetic" },
      },
    );
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
    const extension = await loadExtension(
      (bootstrapPath) => ompCustomModelsExtensionSource(ompTarget, bootstrapPath),
      {
        url: "http://127.0.0.1:1/models",
        token: "synthetic-models-token",
        keys: { "scient-model-key-1": key },
      },
    );
    const host = makeApi();

    await expect((await extension.importFresh())(host.api)).rejects.toThrow(detail);

    expect(host.providers.size).toBe(0);
    expect(requests[1]).toMatchObject({
      path: "/applied",
      body: { generation: 1, error: expect.stringContaining(detail) },
    });
  });
});
